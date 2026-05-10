"""Platform-aware local TTS for Partner."""

import os
import platform
import subprocess
import sys
import tempfile
import wave
from collections.abc import Mapping

import numpy as np

CHINESE_VOICE_DEFAULT = "Tingting"
KOKORO_ENGLISH_VOICE_DEFAULT = "af_heart"


def _is_apple_silicon() -> bool:
    return sys.platform == "darwin" and platform.machine() == "arm64"


def contains_chinese_text(text: str) -> bool:
    return any("\u4e00" <= char <= "\u9fff" for char in text)


def resolve_macos_voice(
    text: str,
    env: Mapping[str, str] = os.environ,
) -> str:
    if contains_chinese_text(text):
        return (
            env.get("PARTNER_TTS_ZH_VOICE", "").strip()
            or env.get("PARTNER_MACOS_ZH_VOICE", "").strip()
            or CHINESE_VOICE_DEFAULT
        )

    return (
        env.get("PARTNER_TTS_EN_VOICE", "").strip()
        or env.get("PARTNER_MACOS_EN_VOICE", "").strip()
        or "Samantha"
    )


def resolve_kokoro_voice(
    text: str,
    env: Mapping[str, str] = os.environ,
) -> str:
    return (
        env.get("PARTNER_KOKORO_VOICE", "").strip()
        or env.get("KOKORO_VOICE", "").strip()
        or KOKORO_ENGLISH_VOICE_DEFAULT
    )


class TTSBackend:
    """Unified TTS interface."""

    sample_rate: int = 24000

    def generate(self, text: str, voice: str | None = None, speed: float = 1.1) -> np.ndarray:
        raise NotImplementedError


class MacOSSayBackend(TTSBackend):
    """macOS system TTS, used for Chinese where Kokoro ONNX is English-only."""

    def generate(self, text: str, voice: str | None = None, speed: float = 1.1) -> np.ndarray:
        selected_voice = voice or resolve_macos_voice(text)
        rate = os.environ.get("PARTNER_MACOS_TTS_RATE", "") or str(round(180 * speed))

        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as output:
            output_path = output.name

        try:
            subprocess.run(
                [
                    "say",
                    "-v",
                    selected_voice,
                    "-r",
                    rate,
                    "-o",
                    output_path,
                    "--file-format=WAVE",
                    f"--data-format=LEI16@{self.sample_rate}",
                    "--channels=1",
                    text,
                ],
                check=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            )
            return read_wave_pcm(output_path, self.sample_rate)
        finally:
            try:
                os.unlink(output_path)
            except FileNotFoundError:
                pass


class MLXBackend(TTSBackend):
    """mlx-audio backend (Apple Silicon GPU via MLX)."""

    def __init__(self):
        from mlx_audio.tts.generate import load_model

        self._model = load_model("mlx-community/Kokoro-82M-bf16")
        self.sample_rate = self._model.sample_rate
        # Warmup: triggers pipeline init (phonemizer, spacy, etc.)
        list(self._model.generate(text="Hello", voice=KOKORO_ENGLISH_VOICE_DEFAULT, speed=1.0))

    def generate(self, text: str, voice: str | None = None, speed: float = 1.1) -> np.ndarray:
        results = list(
            self._model.generate(
                text=text,
                voice=voice or resolve_kokoro_voice(text),
                speed=speed,
            ),
        )
        return np.concatenate([np.array(r.audio) for r in results])


class ONNXBackend(TTSBackend):
    """kokoro-onnx backend (ONNX Runtime, CPU)."""

    def __init__(self):
        import kokoro_onnx
        from huggingface_hub import hf_hub_download

        model_path = hf_hub_download("fastrtc/kokoro-onnx", "kokoro-v1.0.onnx")
        voices_path = hf_hub_download("fastrtc/kokoro-onnx", "voices-v1.0.bin")

        self._model = kokoro_onnx.Kokoro(model_path, voices_path)
        self.sample_rate = 24000

    def generate(self, text: str, voice: str | None = None, speed: float = 1.1) -> np.ndarray:
        pcm, _sr = self._model.create(
            text,
            voice=voice or resolve_kokoro_voice(text),
            speed=speed,
            lang="en-us",
        )
        return pcm


class HybridTTSBackend(TTSBackend):
    """Routes Chinese to macOS system TTS and other text to Kokoro."""

    def __init__(self, kokoro_backend: TTSBackend):
        self._kokoro_backend = kokoro_backend
        self._macos_backend = MacOSSayBackend() if sys.platform == "darwin" else None
        self.sample_rate = kokoro_backend.sample_rate

    def generate(self, text: str, voice: str | None = None, speed: float = 1.1) -> np.ndarray:
        if contains_chinese_text(text) and self._macos_backend:
            return self._macos_backend.generate(text, voice=voice, speed=speed)

        return self._kokoro_backend.generate(text, voice=voice, speed=speed)


def read_wave_pcm(path: str, sample_rate: int) -> np.ndarray:
    with wave.open(path, "rb") as wav_file:
        channels = wav_file.getnchannels()
        frame_rate = wav_file.getframerate()
        sample_width = wav_file.getsampwidth()
        frames = wav_file.readframes(wav_file.getnframes())

    if sample_width != 2:
        raise ValueError(f"Expected 16-bit PCM from macOS say, got {sample_width * 8}-bit")

    samples = np.frombuffer(frames, dtype="<i2").astype(np.float32) / 32768.0
    if channels > 1:
        samples = samples.reshape(-1, channels).mean(axis=1)

    if frame_rate != sample_rate:
        source_positions = np.linspace(0, len(samples), num=len(samples), endpoint=False)
        target_length = round(len(samples) * sample_rate / frame_rate)
        target_positions = np.linspace(0, len(samples), num=target_length, endpoint=False)
        samples = np.interp(target_positions, source_positions, samples).astype(np.float32)

    return samples


def load() -> TTSBackend:
    """Load the best available TTS backend for this platform."""
    if _is_apple_silicon() and not os.environ.get("KOKORO_ONNX"):
        try:
            backend = MLXBackend()
            print(f"TTS: mlx-audio (Apple GPU, sample_rate={backend.sample_rate})")
            return HybridTTSBackend(backend)
        except ImportError:
            print("TTS: mlx-audio not installed, falling back to kokoro-onnx")

    backend = ONNXBackend()
    print(f"TTS: kokoro-onnx (CPU, sample_rate={backend.sample_rate})")
    return HybridTTSBackend(backend)
