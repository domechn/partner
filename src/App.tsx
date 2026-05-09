import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "./App.css";
import {
  parseVoiceCommand,
  type AutomationRequest,
  type AutomationResult,
  type GazePoint,
} from "./lib/intent";
import {
  canUseLocalSpeechRecognition,
  getLocalSpeechRecognitionErrorMessage,
  getSpeechRecognitionErrorMessage,
  getSpeechMode,
} from "./lib/speech";
import { transcribeAudioBlob } from "./lib/localSpeech";

type CalibrationSample = {
  raw: GazePoint;
  target: GazePoint;
};

type SpeechRecognitionLike = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
};

type SpeechRecognitionEventLike = {
  results: ArrayLike<{
    isFinal: boolean;
    0: {
      transcript: string;
    };
  }>;
};

type FaceDetectionLike = {
  boundingBox: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
};

type FaceDetectorLike = {
  detect: (source: CanvasImageSource) => Promise<FaceDetectionLike[]>;
};

type FaceDetectorCtor = new () => FaceDetectorLike;

declare global {
  interface Window {
    SpeechRecognition?: new () => SpeechRecognitionLike;
    webkitSpeechRecognition?: new () => SpeechRecognitionLike;
    FaceDetector?: FaceDetectorCtor;
  }
}

const CALIBRATION_POINTS: GazePoint[] = [
  { x: 0.1, y: 0.1 },
  { x: 0.9, y: 0.1 },
  { x: 0.5, y: 0.5 },
  { x: 0.1, y: 0.9 },
  { x: 0.9, y: 0.9 },
];

function clamp(v: number): number {
  return Math.max(0, Math.min(1, v));
}

function mapWithCalibration(
  raw: GazePoint,
  samples: CalibrationSample[],
): GazePoint {
  if (samples.length < 2) {
    return raw;
  }

  const xRangeRaw =
    Math.max(...samples.map((s) => s.raw.x)) -
    Math.min(...samples.map((s) => s.raw.x));
  const yRangeRaw =
    Math.max(...samples.map((s) => s.raw.y)) -
    Math.min(...samples.map((s) => s.raw.y));

  const xRangeTarget =
    Math.max(...samples.map((s) => s.target.x)) -
    Math.min(...samples.map((s) => s.target.x));
  const yRangeTarget =
    Math.max(...samples.map((s) => s.target.y)) -
    Math.min(...samples.map((s) => s.target.y));

  if (xRangeRaw <= 0.001 || yRangeRaw <= 0.001) {
    return raw;
  }

  const xMinRaw = Math.min(...samples.map((s) => s.raw.x));
  const yMinRaw = Math.min(...samples.map((s) => s.raw.y));
  const xMinTarget = Math.min(...samples.map((s) => s.target.x));
  const yMinTarget = Math.min(...samples.map((s) => s.target.y));

  const x = ((raw.x - xMinRaw) / xRangeRaw) * xRangeTarget + xMinTarget;
  const y = ((raw.y - yMinRaw) / yRangeRaw) * yRangeTarget + yMinTarget;

  return { x: clamp(x), y: clamp(y) };
}

function App() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const audioStreamRef = useRef<MediaStream | null>(null);

  const [cameraReady, setCameraReady] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [manualCommand, setManualCommand] = useState("");
  const [transcript, setTranscript] = useState("");
  const [status, setStatus] = useState("等待摄像头初始化...");
  const [rawGaze, setRawGaze] = useState<GazePoint>({ x: 0.5, y: 0.5 });
  const [calibrationSamples, setCalibrationSamples] = useState<
    CalibrationSample[]
  >([]);
  const [calibrationStep, setCalibrationStep] = useState(0);
  const [lastResult, setLastResult] = useState<AutomationResult | null>(null);
  const [pendingAction, setPendingAction] = useState<AutomationRequest | null>(
    null,
  );

  const calibrated = calibrationStep >= CALIBRATION_POINTS.length;

  const hasSpeechRecognitionApi = !!(
    window.SpeechRecognition ?? window.webkitSpeechRecognition
  );
  const hasMediaRecorderApi = typeof MediaRecorder !== "undefined";
  const hasUserMediaApi = !!navigator.mediaDevices?.getUserMedia;
  const isDesktopShell = !!window.partner;
  const speechMode = getSpeechMode({
    hasSpeechRecognitionApi,
    hasMediaRecorderApi,
    hasUserMediaApi,
    isDesktopShell,
  });
  const speechSupported = speechMode !== "manual";

  const sendCommand = useCallback(async (command: AutomationRequest) => {
    if (!window.partner) {
      setStatus("Electron API 不可用，请使用 npm run dev 启动桌面端。");
      return;
    }

    const result = await window.partner.requestAutomation(command);
    setLastResult(result);
    setStatus(result.message);

    if (result.requiresConfirmation && result.pendingAction) {
      setPendingAction(result.pendingAction);
    } else {
      setPendingAction(null);
    }
  }, []);

  const handleSpeechResult = useCallback(
    async (finalText: string) => {
      setTranscript(finalText);
      const command = parseVoiceCommand(finalText);
      if (!command) {
        setStatus(
          "未识别到可执行命令，请说“点击这里 / 输入 xxx / 打开 xxx”，或直接描述你想完成的目标。",
        );
        return;
      }

      await sendCommand(command);
    },
    [sendCommand],
  );

  const submitManualCommand = useCallback(async () => {
    const text = manualCommand.trim();
    if (!text) {
      setStatus("请先输入命令。");
      return;
    }

    await handleSpeechResult(text);
    setManualCommand("");
  }, [handleSpeechResult, manualCommand]);

  const clearLocalAudioCapture = useCallback(() => {
    mediaRecorderRef.current = null;
    audioChunksRef.current = [];
    audioStreamRef.current?.getTracks().forEach((track) => track.stop());
    audioStreamRef.current = null;
  }, []);

  const startLocalListening = useCallback(async () => {
    if (
      !canUseLocalSpeechRecognition({
        hasMediaRecorderApi,
        hasUserMediaApi,
        isDesktopShell,
      })
    ) {
      setStatus("当前环境不支持本地语音录音。请改用文本命令。");
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: false,
      });
      const recorder = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? new MediaRecorder(stream, { mimeType: "audio/webm;codecs=opus" })
        : new MediaRecorder(stream);

      audioStreamRef.current = stream;
      audioChunksRef.current = [];

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };

      recorder.onerror = () => {
        setIsListening(false);
        clearLocalAudioCapture();
        setStatus("本地录音失败，请检查麦克风权限。");
      };

      recorder.onstop = () => {
        const audioBlob = new Blob(audioChunksRef.current, {
          type: recorder.mimeType || "audio/webm",
        });
        clearLocalAudioCapture();

        if (audioBlob.size === 0) {
          setStatus("没有采集到有效音频，请重试。");
          return;
        }

        setIsListening(false);
        setIsTranscribing(true);
        setStatus(
          "正在本地转写，请稍候（首次使用会下载模型，之后可离线使用）。",
        );

        void (async () => {
          try {
            const text = await transcribeAudioBlob(audioBlob);
            setIsTranscribing(false);

            if (!text) {
              setStatus("没有识别到清晰语音，请重试。");
              return;
            }

            await handleSpeechResult(text);
          } catch (error) {
            setIsTranscribing(false);
            setStatus(getLocalSpeechRecognitionErrorMessage(error));
          }
        })();
      };

      mediaRecorderRef.current = recorder;
      recorder.start();
      setIsListening(true);
      setStatus("开始本地录音，再点一次结束。首次转写会下载本地模型。");
    } catch (error) {
      setStatus(getLocalSpeechRecognitionErrorMessage(error));
    }
  }, [
    clearLocalAudioCapture,
    handleSpeechResult,
    hasMediaRecorderApi,
    hasUserMediaApi,
    isDesktopShell,
  ]);

  const stopLocalListening = useCallback(() => {
    const recorder = mediaRecorderRef.current;
    if (!recorder) {
      setIsListening(false);
      clearLocalAudioCapture();
      return;
    }

    if (recorder.state !== "inactive") {
      recorder.stop();
    }
  }, [clearLocalAudioCapture]);

  const gaze = useMemo(
    () => mapWithCalibration(rawGaze, calibrationSamples),
    [rawGaze, calibrationSamples],
  );

  useEffect(() => {
    let active = true;

    const setupCamera = async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: "user",
            frameRate: { ideal: 30, min: 15 },
            width: { ideal: 1280 },
            height: { ideal: 720 },
          },
          audio: false,
        });

        if (!active) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }

        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play();
        }

        setCameraReady(true);
        setStatus("摄像头已就绪，先完成 5 点校准。");
      } catch {
        setStatus("无法打开摄像头，请检查权限。");
      }
    };

    void setupCamera();

    return () => {
      active = false;
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  useEffect(() => {
    return () => {
      recognitionRef.current?.stop();
      const recorder = mediaRecorderRef.current;
      if (recorder && recorder.state !== "inactive") {
        recorder.stop();
      }
      clearLocalAudioCapture();
    };
  }, [clearLocalAudioCapture]);

  useEffect(() => {
    if (!cameraReady || !videoRef.current) {
      return;
    }

    let disposed = false;
    const detector = window.FaceDetector ? new window.FaceDetector() : null;

    const tick = async () => {
      if (disposed || !videoRef.current) {
        return;
      }

      try {
        if (detector) {
          const faces = await detector.detect(videoRef.current);
          const first = faces[0];
          if (first) {
            const v = videoRef.current;
            const centerX =
              (first.boundingBox.x + first.boundingBox.width / 2) /
              v.videoWidth;
            const centerY =
              (first.boundingBox.y + first.boundingBox.height / 2) /
              v.videoHeight;
            setRawGaze({ x: clamp(centerX), y: clamp(centerY) });
          }
        }
      } catch {
        // Ignore detector errors; fallback remains available.
      }

      setTimeout(() => {
        void tick();
      }, 40);
    };

    void tick();

    return () => {
      disposed = true;
    };
  }, [cameraReady]);

  useEffect(() => {
    if (!window.partner) {
      return;
    }
    void window.partner.updateGaze(gaze);
  }, [gaze]);

  useEffect(() => {
    const onMove = (event: MouseEvent) => {
      const panel = document.getElementById("camera-panel");
      if (!panel) {
        return;
      }
      const rect = panel.getBoundingClientRect();
      if (
        event.clientX < rect.left ||
        event.clientX > rect.right ||
        event.clientY < rect.top ||
        event.clientY > rect.bottom
      ) {
        return;
      }

      const x = (event.clientX - rect.left) / rect.width;
      const y = (event.clientY - rect.top) / rect.height;
      setRawGaze({ x: clamp(x), y: clamp(y) });
    };

    window.addEventListener("mousemove", onMove);
    return () => {
      window.removeEventListener("mousemove", onMove);
    };
  }, []);

  const onCalibrationCapture = useCallback(() => {
    if (calibrationStep >= CALIBRATION_POINTS.length) {
      return;
    }

    setCalibrationSamples((prev) => [
      ...prev,
      {
        raw: rawGaze,
        target: CALIBRATION_POINTS[calibrationStep],
      },
    ]);
    setCalibrationStep((s) => s + 1);
  }, [calibrationStep, rawGaze]);

  const toggleListening = useCallback(() => {
    if (speechMode === "local") {
      if (isTranscribing) {
        return;
      }

      if (isListening) {
        stopLocalListening();
      } else {
        void startLocalListening();
      }
      return;
    }

    if (!speechSupported) {
      if (isDesktopShell) {
        setStatus("当前环境没有可用语音入口，请改用下方文本命令。");
      } else {
        setStatus("语音识别不可用。");
      }
      return;
    }

    const recognition = recognitionRef.current;
    if (isListening) {
      recognition?.stop();
      setIsListening(false);
      setStatus("已停止语音监听。");
    } else {
      if (!recognition) {
        const Ctor = window.SpeechRecognition ?? window.webkitSpeechRecognition;
        if (!Ctor) {
          setStatus("语音识别不可用。");
          return;
        }
        const instance = new Ctor();
        instance.continuous = true;
        instance.interimResults = false;
        instance.lang = "zh-CN";
        instance.onresult = (event) => {
          const latest = event.results[event.results.length - 1];
          if (latest?.isFinal) {
            void handleSpeechResult(latest[0].transcript);
          }
        };
        instance.onerror = (event) => {
          setIsListening(false);
          recognitionRef.current?.stop();
          setStatus(
            getSpeechRecognitionErrorMessage(event.error, { isDesktopShell }),
          );
        };
        instance.onend = () => {
          setIsListening(false);
        };
        recognitionRef.current = instance;
      }
      recognitionRef.current?.start();
      setIsListening(true);
      setStatus("开始语音监听，请说命令。");
    }
  }, [
    handleSpeechResult,
    isDesktopShell,
    isListening,
    isTranscribing,
    speechMode,
    speechSupported,
    startLocalListening,
    stopLocalListening,
  ]);

  const speechStatus =
    speechMode === "local"
      ? isTranscribing
        ? "本地转写中"
        : isListening
          ? "本地录音中"
          : "本地待命"
      : speechSupported
        ? isListening
          ? "监听中"
          : "未监听"
        : isDesktopShell
          ? "不可用"
          : "不可用";

  const speechButtonLabel =
    speechMode === "local"
      ? isListening
        ? "结束录音"
        : isTranscribing
          ? "本地转写中..."
          : "开始本地语音"
      : isListening
        ? "停止语音"
        : "开始语音";

  const currentCalibrationPoint =
    CALIBRATION_POINTS[
      Math.min(calibrationStep, CALIBRATION_POINTS.length - 1)
    ];

  return (
    <main className="app-root">
      <header className="top-bar">
        <h1>Partner MVP</h1>
        <p>本地运行 · 摄像头追踪 · 语音命令 · 自动拆解目标</p>
      </header>

      <section className="grid">
        <article id="camera-panel" className="panel camera-panel">
          <video ref={videoRef} autoPlay muted playsInline className="camera" />
          <div
            className="gaze-dot"
            style={{ left: `${gaze.x * 100}%`, top: `${gaze.y * 100}%` }}
            aria-label="gaze-dot"
          />
          {!calibrated && (
            <button
              type="button"
              className="calibration-target"
              style={{
                left: `${currentCalibrationPoint.x * 100}%`,
                top: `${currentCalibrationPoint.y * 100}%`,
              }}
              onClick={onCalibrationCapture}
            >
              校准点 {calibrationStep + 1}/5
            </button>
          )}
        </article>

        <article className="panel">
          <h2>控制台</h2>
          <ul className="stats">
            <li>摄像头：{cameraReady ? "已连接" : "未连接"}</li>
            <li>
              校准：{calibrated ? "完成" : `进行中 (${calibrationStep}/5)`}
            </li>
            <li>语音：{speechStatus}</li>
          </ul>

          <div className="actions">
            <button
              type="button"
              onClick={toggleListening}
              disabled={isTranscribing}
            >
              {speechButtonLabel}
            </button>
            <button
              type="button"
              onClick={() => void sendCommand({ kind: "click_here" })}
            >
              点击注视点
            </button>
            <button
              type="button"
              onClick={() => void sendCommand({ kind: "switch_tab" })}
            >
              切换 Tab
            </button>
            <button
              type="button"
              onClick={() =>
                void sendCommand({
                  kind: "agent_task",
                  goal: "帮我查一下今天的天气",
                })
              }
            >
              示例：自动查天气
            </button>
          </div>

          <div className="manual-command">
            <label htmlFor="manual-command-input">文本命令</label>
            <div className="manual-command-row">
              <input
                id="manual-command-input"
                type="text"
                value={manualCommand}
                onChange={(event) => setManualCommand(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void submitManualCommand();
                  }
                }}
                placeholder="例如：输入 hello / 打开 Safari / 帮我查一下今天的天气"
              />
              <button type="button" onClick={() => void submitManualCommand()}>
                发送文本命令
              </button>
            </div>
          </div>

          <p className="status">状态：{status}</p>
          <p className="transcript">最近语音：{transcript || "（暂无）"}</p>

          {pendingAction && (
            <div className="confirm-box">
              <strong>待确认高风险操作</strong>
              <code>{JSON.stringify(pendingAction)}</code>
              {lastResult?.plan && (
                <ol className="plan-list">
                  {lastResult.plan.map((step, index) => (
                    <li key={`${step.description}-${index}`}>
                      <span>{step.description}</span>
                      <small>
                        {step.risk === "high" ? "需确认" : "低风险"}
                      </small>
                    </li>
                  ))}
                </ol>
              )}
              <button
                type="button"
                onClick={() =>
                  void sendCommand({ kind: "confirm_pending", confirmed: true })
                }
              >
                确认执行
              </button>
            </div>
          )}

          {lastResult?.plan && !pendingAction && (
            <section className="plan-card">
              <h3>自动任务步骤</h3>
              <ol className="plan-list">
                {lastResult.plan.map((step, index) => (
                  <li key={`${step.description}-${index}`}>
                    <span>{step.description}</span>
                    <small>{step.risk === "high" ? "高风险" : "低风险"}</small>
                  </li>
                ))}
              </ol>
            </section>
          )}

          {lastResult && (
            <pre className={`result ${lastResult.ok ? "ok" : "fail"}`}>
              {JSON.stringify(lastResult, null, 2)}
            </pre>
          )}
        </article>
      </section>
    </main>
  );
}

export default App;
