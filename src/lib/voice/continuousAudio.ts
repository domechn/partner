import {
  consumeVadLevel,
  createVadState,
  getDefaultVadConfig,
  type VadConfig,
} from "./vad.ts";

export type ContinuousAudioSession = {
  stop: () => Promise<void>;
};

export type RecordedAudioChunk = {
  blob: Blob;
  receivedAtMs: number;
};

export type StartContinuousAudioOptions = {
  onSpeechStart?: () => void | Promise<void>;
  onSpeechEnd?: (payload: {
    audioBlob: Blob;
    decision: "commit" | "discard";
  }) => void | Promise<void>;
  onError?: (error: unknown) => void;
  vadConfig?: VadConfig;
  analysisIntervalMs?: number;
  preSpeechMs?: number;
  recorderTimesliceMs?: number;
};

type PendingSpeechSegment = {
  decision: "commit" | "discard";
  speechStartMs: number;
  speechEndMs: number;
};

const DEFAULT_ANALYSIS_INTERVAL_MS = 50;
const DEFAULT_PRE_SPEECH_MS = 900;
const DEFAULT_RECORDER_TIMESLICE_MS = 250;

export async function startContinuousAudioSession(
  options: StartContinuousAudioOptions,
): Promise<ContinuousAudioSession> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
    video: false,
  });

  const audioContext = new AudioContext();
  await audioContext.resume();

  const source = audioContext.createMediaStreamSource(stream);
  const analyser = audioContext.createAnalyser();
  analyser.fftSize = 2048;
  analyser.smoothingTimeConstant = 0.1;
  source.connect(analyser);

  const levels = new Float32Array(analyser.fftSize);
  const vadConfig = options.vadConfig ?? getDefaultVadConfig();
  const intervalMs = options.analysisIntervalMs ?? DEFAULT_ANALYSIS_INTERVAL_MS;
  const preSpeechMs = options.preSpeechMs ?? DEFAULT_PRE_SPEECH_MS;
  const recorderTimesliceMs =
    options.recorderTimesliceMs ?? DEFAULT_RECORDER_TIMESLICE_MS;

  let vadState = createVadState();
  let stopped = false;
  let intervalId: number | null = null;
  let activeRecorder: MediaRecorder | null = null;
  let recordedChunks: RecordedAudioChunk[] = [];
  let activeSpeechStartMs: number | null = null;
  let pendingSegment: PendingSpeechSegment | null = null;
  let deliverOnStop = true;

  const cleanupRecorder = (): void => {
    activeRecorder = null;
    recordedChunks = [];
    activeSpeechStartMs = null;
    pendingSegment = null;
  };

  const createRecorder = (): MediaRecorder => {
    if (MediaRecorder.isTypeSupported("audio/webm;codecs=opus")) {
      return new MediaRecorder(stream, { mimeType: "audio/webm;codecs=opus" });
    }

    return new MediaRecorder(stream);
  };

  const appendRecordedChunk = (blob: Blob): void => {
    if (blob.size <= 0) {
      return;
    }

    const receivedAtMs = performance.now();
    recordedChunks.push({ blob, receivedAtMs });

    if (!pendingSegment && activeSpeechStartMs === null) {
      recordedChunks = trimRecordedAudioChunks(recordedChunks, {
        nowMs: receivedAtMs,
        preSpeechMs,
      });
    }
  };

  const buildAudioBlob = (chunks: RecordedAudioChunk[]): Blob => {
    return new Blob(
      chunks.map((chunk) => chunk.blob),
      {
        type: activeRecorder?.mimeType || chunks[0]?.blob.type || "audio/webm",
      },
    );
  };

  const deliverPendingSegment = (): void => {
    const segment = pendingSegment;
    if (!segment) {
      return;
    }

    const segmentEndMs = Math.max(segment.speechEndMs, performance.now());
    const segmentChunks = selectAudioChunksForSpeech(recordedChunks, {
      speechStartMs: segment.speechStartMs,
      speechEndMs: segmentEndMs,
      preSpeechMs,
    });

    pendingSegment = null;
    activeSpeechStartMs = null;
    recordedChunks = trimRecordedAudioChunks(recordedChunks, {
      nowMs: segmentEndMs,
      preSpeechMs,
    });

    if (!deliverOnStop || segmentChunks.length === 0) {
      return;
    }

    void options.onSpeechEnd?.({
      audioBlob: buildAudioBlob(segmentChunks),
      decision: segment.decision,
    });
  };

  const requestRecorderData = (): void => {
    const recorder = activeRecorder;
    if (!recorder || recorder.state === "inactive") {
      deliverPendingSegment();
      return;
    }

    try {
      recorder.requestData();
    } catch {
      deliverPendingSegment();
    }
  };

  const stopRecorder = (): void => {
    if (activeRecorder && activeRecorder.state !== "inactive") {
      activeRecorder.stop();
      return;
    }

    cleanupRecorder();
  };

  const startRecorder = (): void => {
    if (activeRecorder && activeRecorder.state !== "inactive") {
      return;
    }

    const recorder = createRecorder();
    activeRecorder = recorder;

    recorder.ondataavailable = (event) => {
      appendRecordedChunk(event.data);

      if (pendingSegment) {
        deliverPendingSegment();
      }
    };

    recorder.onerror = (event) => {
      cleanupRecorder();
      options.onError?.(event.error);
    };

    recorder.onstop = () => {
      if (pendingSegment) {
        deliverPendingSegment();
      }

      cleanupRecorder();
    };

    recorder.start(recorderTimesliceMs);
  };

  startRecorder();

  intervalId = window.setInterval(() => {
    if (stopped) {
      return;
    }

    analyser.getFloatTimeDomainData(levels);
    const step = consumeVadLevel(vadState, measureRmsLevel(levels), vadConfig);
    vadState = step.state;

    if (step.event.type === "speech-started") {
      activeSpeechStartMs = performance.now();
      void options.onSpeechStart?.();
      return;
    }

    if (step.event.type === "speech-ended") {
      pendingSegment = {
        decision: step.event.decision,
        speechStartMs: activeSpeechStartMs ?? performance.now(),
        speechEndMs: performance.now(),
      };
      requestRecorderData();
    }
  }, intervalMs);

  return {
    async stop() {
      stopped = true;
      deliverOnStop = false;

      if (intervalId !== null) {
        window.clearInterval(intervalId);
        intervalId = null;
      }

      stopRecorder();
      source.disconnect();
      analyser.disconnect();
      stream.getTracks().forEach((track) => track.stop());
      await audioContext.close();
    },
  };
}

export function selectAudioChunksForSpeech(
  chunks: RecordedAudioChunk[],
  options: {
    speechStartMs: number;
    speechEndMs: number;
    preSpeechMs: number;
  },
): RecordedAudioChunk[] {
  const startCutoffMs = options.speechStartMs - options.preSpeechMs;
  return chunks.filter(
    (chunk) =>
      chunk.receivedAtMs >= startCutoffMs &&
      chunk.receivedAtMs <= options.speechEndMs,
  );
}

export function trimRecordedAudioChunks(
  chunks: RecordedAudioChunk[],
  options: { nowMs: number; preSpeechMs: number },
): RecordedAudioChunk[] {
  const cutoffMs = options.nowMs - options.preSpeechMs;
  return chunks.filter((chunk) => chunk.receivedAtMs >= cutoffMs);
}

export function measureRmsLevel(frame: Float32Array): number {
  if (frame.length === 0) {
    return 0;
  }

  let sum = 0;
  for (let index = 0; index < frame.length; index += 1) {
    const sample = frame[index] ?? 0;
    sum += sample * sample;
  }

  return Math.sqrt(sum / frame.length);
}
