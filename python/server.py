"""Partner on-device multimodal AI server (voice + vision).

Architecture:
  - Gemma 4 E2B via LiteRT-LM  (audio + vision understanding, no separate STT)
  - Kokoro TTS (MLX on Apple Silicon, ONNX fallback)
  - WebSocket /ws  protocol

Additional features over the reference implementation:
  - Bilingual system prompt (Chinese + English)
  - Optional `gaze` field in incoming messages  {x: 0..1, y: 0..1}
"""

import asyncio
import base64
import json
import os
import re
import time
from contextlib import asynccontextmanager

os.environ.setdefault("HF_HUB_DISABLE_XET", "1")

import litert_lm
import numpy as np
import uvicorn
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse

import tts

HF_REPO = "litert-community/gemma-4-E2B-it-litert-lm"
HF_FILENAME = "gemma-4-E2B-it.litertlm"


def resolve_model_path() -> str:
    path = os.environ.get("MODEL_PATH", "")
    if path:
        return path
    from huggingface_hub import hf_hub_download

    print(f"Downloading {HF_REPO}/{HF_FILENAME} (first run only)...", flush=True)
    return hf_hub_download(repo_id=HF_REPO, filename=HF_FILENAME)


MODEL_PATH = resolve_model_path()

SYSTEM_PROMPT = (
    "你是 Partner 的本地语音助手。"
    "默认使用简洁中文回答，如果用户用英文说话则用英文回答。"
    "用户正在通过麦克风与你对话，并可能向你展示摄像头画面。"
    "如果消息中包含注视点坐标，请结合画面内容理解用户的关注点。"
    "你必须始终使用 respond_to_user 工具来回复。"
    "先精确转录用户所说的内容，再给出你的回应（1-4句简洁回答）。"
    " / "
    "You are Partner's local voice assistant. "
    "Reply in the same language the user speaks. "
    "The user is talking through a microphone and may be showing their camera. "
    "You MUST always use the respond_to_user tool to reply. "
    "First transcribe exactly what the user said, then write your response."
)

SENTENCE_SPLIT_RE = re.compile(r"(?<=[.!?。！？])\s*")

engine = None
tts_backend = None


def load_models():
    global engine, tts_backend
    print(f"Loading Gemma 4 E2B from {MODEL_PATH}...")
    engine = litert_lm.Engine(
        MODEL_PATH,
        backend=litert_lm.Backend.GPU,
        vision_backend=litert_lm.Backend.GPU,
        audio_backend=litert_lm.Backend.CPU,
    )
    engine.__enter__()
    print("Engine loaded.")

    tts_backend = tts.load()


@asynccontextmanager
async def lifespan(app):
    await asyncio.get_event_loop().run_in_executor(None, load_models)
    yield


app = FastAPI(lifespan=lifespan)


def split_sentences(text: str) -> list[str]:
    """Split text into sentences for streaming TTS (handles both Chinese and English punctuation)."""
    parts = SENTENCE_SPLIT_RE.split(text.strip())
    return [s.strip() for s in parts if s.strip()]


@app.get("/")
async def root():
    return JSONResponse({"status": "ok", "model": HF_REPO})


@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket):
    await ws.accept()

    # Per-connection tool state captured via closure
    tool_result = {}

    def respond_to_user(transcription: str, response: str) -> str:
        """Respond to the user's voice message.

        Args:
            transcription: Exact transcription of what the user said.
            response: Your conversational response. Keep it to 1-4 short sentences.
        """
        tool_result["transcription"] = transcription
        tool_result["response"] = response
        return "OK"

    conversation = engine.create_conversation(
        messages=[{"role": "system", "content": SYSTEM_PROMPT}],
        tools=[respond_to_user],
    )
    conversation.__enter__()

    interrupted = asyncio.Event()
    msg_queue = asyncio.Queue()

    async def receiver():
        """Receive messages from WebSocket and route them."""
        try:
            while True:
                raw = await ws.receive_text()
                msg = json.loads(raw)
                if msg.get("type") == "interrupt":
                    interrupted.set()
                    print("Client interrupted")
                else:
                    await msg_queue.put(msg)
        except WebSocketDisconnect:
            await msg_queue.put(None)

    recv_task = asyncio.create_task(receiver())

    try:
        while True:
            msg = await msg_queue.get()
            if msg is None:
                break

            interrupted.clear()

            content = []
            has_audio = bool(msg.get("audio"))
            has_image = bool(msg.get("image"))
            has_gaze = "gaze" in msg

            if has_audio:
                content.append({"type": "audio", "blob": msg["audio"]})
            if has_image:
                content.append({"type": "image", "blob": msg["image"]})

            if has_audio and has_image:
                gaze_hint = ""
                if has_gaze:
                    g = msg["gaze"]
                    gaze_hint = f" The user is looking at approximately ({g.get('x', 0.5):.2f}, {g.get('y', 0.5):.2f}) on screen."
                content.append({
                    "type": "text",
                    "text": f"用户刚刚通过语音向你说话（audio），同时展示了摄像头画面（image）。{gaze_hint}请回应用户说的内容，如相关可结合画面。"
                    f" / The user just spoke (audio) while showing their camera (image).{gaze_hint} Respond to what they said, referencing what you see if relevant.",
                })
            elif has_audio:
                content.append({"type": "text", "text": "用户刚刚通过语音向你说话，请回应。 / The user just spoke to you. Respond to what they said."})
            elif has_image:
                content.append({"type": "text", "text": "用户向你展示了摄像头画面，请描述你看到的内容。 / The user is showing you their camera. Describe what you see."})
            else:
                content.append({"type": "text", "text": msg.get("text", "你好！ / Hello!")})

            # LLM inference
            t0 = time.time()
            tool_result.clear()
            response = await asyncio.get_event_loop().run_in_executor(
                None,
                lambda: conversation.send_message({"role": "user", "content": content}),
            )
            llm_time = time.time() - t0

            # Extract response from tool call or fallback to raw text
            if tool_result:
                strip = lambda s: s.replace('<|"|>', "").strip()
                transcription = strip(tool_result.get("transcription", ""))
                text_response = strip(tool_result.get("response", ""))
                print(f"LLM ({llm_time:.2f}s) [tool] heard: {transcription!r} → {text_response}")
            else:
                transcription = None
                text_response = response["content"][0]["text"]
                print(f"LLM ({llm_time:.2f}s) [no tool]: {text_response}")

            if interrupted.is_set():
                print("Interrupted after LLM, skipping response")
                continue

            reply = {"type": "text", "text": text_response, "llm_time": round(llm_time, 2)}
            if transcription:
                reply["transcription"] = transcription
            await ws.send_text(json.dumps(reply, ensure_ascii=False))

            if interrupted.is_set():
                print("Interrupted before TTS, skipping audio")
                continue

            # Streaming TTS: split into sentences and send chunks progressively
            sentences = split_sentences(text_response)
            if not sentences:
                sentences = [text_response]

            tts_start = time.time()

            await ws.send_text(json.dumps({
                "type": "audio_start",
                "sample_rate": tts_backend.sample_rate,
                "sentence_count": len(sentences),
            }))

            for i, sentence in enumerate(sentences):
                if interrupted.is_set():
                    print(f"Interrupted during TTS (sentence {i + 1}/{len(sentences)})")
                    break

                pcm = await asyncio.get_event_loop().run_in_executor(
                    None, lambda s=sentence: tts_backend.generate(s)
                )

                if interrupted.is_set():
                    break

                pcm_int16 = (pcm * 32767).clip(-32768, 32767).astype(np.int16)
                await ws.send_text(json.dumps({
                    "type": "audio_chunk",
                    "audio": base64.b64encode(pcm_int16.tobytes()).decode(),
                    "index": i,
                }))

            tts_time = time.time() - tts_start
            print(f"TTS ({tts_time:.2f}s): {len(sentences)} sentences")

            if not interrupted.is_set():
                await ws.send_text(json.dumps({
                    "type": "audio_end",
                    "tts_time": round(tts_time, 2),
                }))

    except WebSocketDisconnect:
        print("Client disconnected")
    finally:
        recv_task.cancel()
        conversation.__exit__(None, None, None)


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8765"))
    uvicorn.run(app, host="127.0.0.1", port=port)
