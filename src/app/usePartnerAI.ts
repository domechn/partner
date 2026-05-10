/**
 * usePartnerAI — React hook that connects to the Python Partner server.
 *
 * Protocol:
 *   Client → Server:  { audio: base64WAV16k, image?: base64JPEG, screen_image?: base64JPEG, gaze?: {x,y} }
 *   Client → Server:  { type: "interrupt" }
 *   Server → Client:  { type: "text", transcription?, text, llm_time }
 *   Server → Client:  { type: "audio_start", sample_rate, sentence_count }
 *   Server → Client:  { type: "audio_chunk", audio: base64Int16PCM, index }
 *   Server → Client:  { type: "audio_end", tts_time }
 *
 * The hook:
 *   1. Opens a WebSocket to ws://127.0.0.1:<port>/ws (auto-reconnects)
 *   2. Exposes sendTurn/audio and sendText — sends every user turn to Python
 *   3. Streams PCM audio back via WebAudio API (gapless)
 *   4. Calls window.partner IPC methods to keep conversation state in sync
 *   5. Handles barge-in via interrupt()
 */
import { useCallback, useEffect, useRef, useState } from "react";

// ---------------------------------------------------------------------------
// Audio helpers
// ---------------------------------------------------------------------------

/** Decode a MediaRecorder blob, resample to 16 kHz mono, return WAV base64. */
async function audioBlobToWav16kBase64(blob: Blob): Promise<string> {
  const arrayBuffer = await blob.arrayBuffer();
  const decodeCtx = new AudioContext();
  let audioBuffer: AudioBuffer;
  try {
    audioBuffer = await decodeCtx.decodeAudioData(arrayBuffer);
  } finally {
    await decodeCtx.close();
  }

  const TARGET_RATE = 16_000;
  const sampleCount = Math.ceil(audioBuffer.duration * TARGET_RATE);
  const offlineCtx = new OfflineAudioContext(1, sampleCount, TARGET_RATE);
  const src = offlineCtx.createBufferSource();
  src.buffer = audioBuffer;
  src.connect(offlineCtx.destination);
  src.start();
  const resampled = await offlineCtx.startRendering();
  const samples = resampled.getChannelData(0);

  // Build canonical WAV header + Int16 PCM body
  const byteCount = samples.length * 2;
  const buf = new ArrayBuffer(44 + byteCount);
  const v = new DataView(buf);
  const ws = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i));
  };
  ws(0, "RIFF");
  v.setUint32(4, 36 + byteCount, true);
  ws(8, "WAVE");
  ws(12, "fmt ");
  v.setUint32(16, 16, true); // chunk size
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, TARGET_RATE, true);
  v.setUint32(28, TARGET_RATE * 2, true);
  v.setUint16(32, 2, true); // block align
  v.setUint16(34, 16, true); // bits per sample
  ws(36, "data");
  v.setUint32(40, byteCount, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }

  const bytes = new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export type PartnerAIClient = {
  /** True once the WebSocket is connected and the server is ready. */
  isConnected: boolean;
  /** True while the assistant's audio is playing. */
  isPlaying: boolean;
  /**
   * Send a completed speech turn to the Python server.
   * @param audioBlob  MediaRecorder blob (WebM/ogg) — resampled internally to WAV 16kHz.
   * @param visualContext  Optional camera/screen frames for vision grounding.
   * @param gaze  Optional normalised gaze point {x, y} in [0, 1].
   */
  sendTurn: (
    audioBlob: Blob,
    visualContext?: PartnerVisualContext,
    gaze?: { x: number; y: number },
  ) => boolean;
  /** Send a typed turn to the Python server. */
  sendText: (
    text: string,
    visualContext?: PartnerVisualContext,
    gaze?: PartnerGazePoint,
  ) => boolean;
  /** Stop audio playback and signal the server to abort its response. */
  interrupt: () => void;
};

export type PartnerVisualContext = {
  cameraImageBase64?: string;
  screenImageBase64?: string;
};

export type PartnerGazePoint = {
  x: number;
  y: number;
};

type PendingUserTurn = {
  fallbackTranscript: string;
  cameraImageBase64?: string;
  screenImageBase64?: string;
};

export function buildTextTurnPayload(
  text: string,
  visualContext?: PartnerVisualContext,
  gaze?: PartnerGazePoint,
) {
  const payload: {
    text: string;
    image?: string;
    screen_image?: string;
    gaze?: PartnerGazePoint;
  } = { text };
  if (visualContext?.cameraImageBase64) {
    payload.image = visualContext.cameraImageBase64;
  }
  if (visualContext?.screenImageBase64) {
    payload.screen_image = visualContext.screenImageBase64;
  }
  if (gaze) {
    payload.gaze = gaze;
  }
  return payload;
}

export function usePartnerAI(serverPort: number | null): PartnerAIClient {
  const wsRef = useRef<WebSocket | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);

  // Playback state
  const audioCtxRef = useRef<AudioContext | null>(null);
  const sampleRateRef = useRef(24_000);
  const nextPlayTimeRef = useRef(0);
  const activeSourcesRef = useRef<AudioBufferSourceNode[]>([]);
  const pendingChunksRef = useRef<string[]>([]);
  const pendingUserTurnRef = useRef<PendingUserTurn | null>(null);

  // ---------------------------------------------------------------------------
  // Playback helpers
  // ---------------------------------------------------------------------------

  const ensureAudioCtx = useCallback(() => {
    if (!audioCtxRef.current || audioCtxRef.current.state === "closed") {
      audioCtxRef.current = new AudioContext();
    }
    if (audioCtxRef.current.state === "suspended") {
      void audioCtxRef.current.resume();
    }
    return audioCtxRef.current;
  }, []);

  const stopPlayback = useCallback(() => {
    for (const src of activeSourcesRef.current) {
      try {
        src.stop();
      } catch {
        // already ended
      }
    }
    activeSourcesRef.current = [];
    nextPlayTimeRef.current = 0;
    pendingChunksRef.current = [];
    setIsPlaying(false);
  }, []);

  const queueChunk = useCallback(
    (base64Pcm: string) => {
      const ctx = ensureAudioCtx();
      const bin = atob(base64Pcm);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const int16 = new Int16Array(bytes.buffer);
      const float32 = new Float32Array(int16.length);
      for (let i = 0; i < int16.length; i++) float32[i] = int16[i] / 32_768;

      const buffer = ctx.createBuffer(1, float32.length, sampleRateRef.current);
      buffer.getChannelData(0).set(float32);

      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(ctx.destination);

      const startAt = Math.max(nextPlayTimeRef.current, ctx.currentTime);
      source.start(startAt);
      nextPlayTimeRef.current = startAt + buffer.duration;
      activeSourcesRef.current.push(source);

      source.onended = () => {
        const idx = activeSourcesRef.current.indexOf(source);
        if (idx !== -1) activeSourcesRef.current.splice(idx, 1);
        if (activeSourcesRef.current.length === 0) {
          setIsPlaying(false);
          // Notify main process so conversation phase advances to "listening"
          void window.partner?.partnerTtsCompleted();
        }
      };
    },
    [ensureAudioCtx],
  );

  // ---------------------------------------------------------------------------
  // WebSocket lifecycle
  // ---------------------------------------------------------------------------

  useEffect(() => {
    if (!serverPort) return;

    let disposed = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    const connect = () => {
      if (disposed) return;

      const ws = new WebSocket(`ws://127.0.0.1:${serverPort}/ws`);
      wsRef.current = ws;

      ws.onopen = () => {
        if (!disposed) setIsConnected(true);
      };

      ws.onclose = () => {
        if (disposed) return;
        setIsConnected(false);
        stopPlayback();
        // Reconnect after a short delay
        reconnectTimer = setTimeout(connect, 2_000);
      };

      ws.onerror = () => {
        // onclose will fire afterwards and handle reconnect
      };

      ws.onmessage = ({ data }: MessageEvent<string>) => {
        if (disposed) return;
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(data) as Record<string, unknown>;
        } catch {
          return;
        }

        if (msg.type === "text") {
          const pendingUserTurn = pendingUserTurnRef.current;
          pendingUserTurnRef.current = null;
          const transcription = (msg.transcription as string | undefined) ?? "";
          const text = (msg.text as string) ?? "";
          void window.partner?.submitPartnerResponse(
            transcription || pendingUserTurn?.fallbackTranscript || "",
            text,
            pendingUserTurn?.cameraImageBase64,
            pendingUserTurn?.screenImageBase64,
          );
        } else if (msg.type === "audio_start") {
          sampleRateRef.current = (msg.sample_rate as number) ?? 24_000;
          stopPlayback();
          ensureAudioCtx();
          nextPlayTimeRef.current =
            (audioCtxRef.current?.currentTime ?? 0) + 0.05;
          setIsPlaying(true);
        } else if (msg.type === "audio_chunk") {
          queueChunk(msg.audio as string);
        } else if (msg.type === "audio_end") {
          if (activeSourcesRef.current.length === 0) {
            setIsPlaying(false);
            void window.partner?.partnerTtsCompleted();
          }
        }
      };
    };

    connect();

    return () => {
      disposed = true;
      if (reconnectTimer !== null) clearTimeout(reconnectTimer);
      wsRef.current?.close();
      wsRef.current = null;
      setIsConnected(false);
      stopPlayback();
    };
  }, [serverPort, stopPlayback, queueChunk, ensureAudioCtx]);

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  const sendTurn = useCallback(
    (
      audioBlob: Blob,
      visualContext?: PartnerVisualContext,
      gaze?: { x: number; y: number },
    ) => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return false;

      pendingUserTurnRef.current = {
        fallbackTranscript: "（语音输入）",
        cameraImageBase64: visualContext?.cameraImageBase64,
        screenImageBase64: visualContext?.screenImageBase64,
      };

      void audioBlobToWav16kBase64(audioBlob)
        .then((wavBase64) => {
          if (ws.readyState !== WebSocket.OPEN) return;
          const payload: Record<string, unknown> = { audio: wavBase64 };
          if (visualContext?.cameraImageBase64) {
            payload.image = visualContext.cameraImageBase64;
          }
          if (visualContext?.screenImageBase64) {
            payload.screen_image = visualContext.screenImageBase64;
          }
          if (gaze) payload.gaze = gaze;
          ws.send(JSON.stringify(payload));
        })
        .catch(() => {
          pendingUserTurnRef.current = null;
          void window.partner?.dispatchConversationEvent({
            type: "user.turn.discarded",
            reason: "语音编码失败，请重试。",
          });
        });

      return true;
    },
    [],
  );

  const sendText = useCallback(
    (
      text: string,
      visualContext?: PartnerVisualContext,
      gaze?: PartnerGazePoint,
    ) => {
      const trimmed = text.trim();
      const ws = wsRef.current;
      if (!trimmed || !ws || ws.readyState !== WebSocket.OPEN) return false;

      pendingUserTurnRef.current = {
        fallbackTranscript: trimmed,
        cameraImageBase64: visualContext?.cameraImageBase64,
        screenImageBase64: visualContext?.screenImageBase64,
      };
      ws.send(
        JSON.stringify(buildTextTurnPayload(trimmed, visualContext, gaze)),
      );
      return true;
    },
    [],
  );

  const interrupt = useCallback(() => {
    stopPlayback();
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "interrupt" }));
    }
  }, [stopPlayback]);

  return { isConnected, isPlaying, sendTurn, sendText, interrupt };
}
