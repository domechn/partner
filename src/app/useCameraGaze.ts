import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { type GazePoint } from "../lib/intent";
import {
  CALIBRATION_POINTS,
  clamp,
  estimateGazeFromFaceLandmarks,
  type FaceLandmark,
  getCurrentCalibrationPoint,
  mapWithCalibration,
  type CalibrationSample,
} from "./gaze";

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

type GazeTrackingSource = "eye" | "face" | "mouse";

type TimedGazeSample = {
  point: GazePoint;
  receivedAtMs: number;
};

type FaceLandmarkerResult = {
  faceLandmarks?: FaceLandmark[][];
};

type FaceLandmarkerLike = {
  detectForVideo: (
    source: HTMLVideoElement,
    timestampMs: number,
  ) => FaceLandmarkerResult;
  close?: () => void;
};

type MediaPipeTasksVision = {
  FilesetResolver: {
    forVisionTasks: (wasmBaseUrl: string) => Promise<unknown>;
  };
  FaceLandmarker: {
    createFromOptions: (
      vision: unknown,
      options: Record<string, unknown>,
    ) => Promise<FaceLandmarkerLike>;
  };
};

declare global {
  interface Window {
    FaceDetector?: FaceDetectorCtor;
  }
}

const MEDIAPIPE_VERSION = "0.10.35";
const MEDIAPIPE_WASM_BASE_URL = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MEDIAPIPE_VERSION}/wasm`;
const FACE_LANDMARKER_MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/latest/face_landmarker.task";
const CAMERA_GAZE_STALE_MS = 1200;
const CALIBRATION_SAMPLE_WINDOW_MS = 700;
const MAX_RECENT_EYE_GAZE_SAMPLES = 16;
const GAZE_SMOOTHING = 0.35;

export type UseCameraGazeOptions = {
  onStatusChange: (status: string) => void;
};

export type UseCameraGazeResult = {
  cameraReady: boolean;
  calibrated: boolean;
  calibrationStep: number;
  captureConversationImage: () => string | undefined;
  currentCalibrationPoint: GazePoint;
  gaze: GazePoint;
  onCalibrationCapture: () => void;
  videoRef: React.RefObject<HTMLVideoElement | null>;
};

export function useCameraGaze(
  options: UseCameraGazeOptions,
): UseCameraGazeResult {
  const { onStatusChange } = options;
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const trackingStatusRef = useRef("");
  const lastCameraGazeAtRef = useRef(0);
  const recentEyeGazeSamplesRef = useRef<TimedGazeSample[]>([]);
  const smoothedGazeRef = useRef<GazePoint>({ x: 0.5, y: 0.5 });

  const [cameraReady, setCameraReady] = useState(false);
  const [rawGaze, setRawGaze] = useState<GazePoint>({ x: 0.5, y: 0.5 });
  const [calibrationSamples, setCalibrationSamples] = useState<
    CalibrationSample[]
  >([]);
  const [calibrationStep, setCalibrationStep] = useState(0);

  const calibrated = calibrationStep >= CALIBRATION_POINTS.length;
  const gaze = useMemo(
    () => mapWithCalibration(rawGaze, calibrationSamples),
    [rawGaze, calibrationSamples],
  );

  const updateRawGaze = useCallback(
    (point: GazePoint, source: GazeTrackingSource) => {
      const nowMs = performance.now();
      const nextPoint = { x: clamp(point.x), y: clamp(point.y) };
      const smoothedPoint =
        source === "mouse"
          ? nextPoint
          : smoothGaze(smoothedGazeRef.current, nextPoint);

      smoothedGazeRef.current = smoothedPoint;

      if (source === "eye" || source === "face") {
        lastCameraGazeAtRef.current = nowMs;
      }

      if (source === "eye") {
        recentEyeGazeSamplesRef.current = [
          ...recentEyeGazeSamplesRef.current.filter(
            (sample) =>
              nowMs - sample.receivedAtMs <= CALIBRATION_SAMPLE_WINDOW_MS * 2,
          ),
          { point: smoothedPoint, receivedAtMs: nowMs },
        ].slice(-MAX_RECENT_EYE_GAZE_SAMPLES);
      }

      setRawGaze(smoothedPoint);
    },
    [],
  );

  const reportTrackingStatus = useCallback(
    (nextStatus: string) => {
      if (trackingStatusRef.current === nextStatus) {
        return;
      }

      trackingStatusRef.current = nextStatus;
      onStatusChange(nextStatus);
    },
    [onStatusChange],
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
          stream.getTracks().forEach((track) => track.stop());
          return;
        }

        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play();
        }

        setCameraReady(true);
        onStatusChange("摄像头已就绪，先完成 5 点校准。");
      } catch {
        onStatusChange("无法打开摄像头，请检查权限。");
      }
    };

    void setupCamera();

    return () => {
      active = false;
      streamRef.current?.getTracks().forEach((track) => track.stop());
    };
  }, [onStatusChange]);

  useEffect(() => {
    if (!cameraReady || !videoRef.current) {
      return;
    }

    let disposed = false;
    let timer: number | undefined;
    let faceLandmarker: FaceLandmarkerLike | null = null;
    const detector = window.FaceDetector ? new window.FaceDetector() : null;

    void createMediaPipeFaceLandmarker()
      .then((nextLandmarker) => {
        if (disposed) {
          nextLandmarker.close?.();
          return;
        }

        faceLandmarker = nextLandmarker;
        reportTrackingStatus("眼部追踪已启动，桌面水泡会跟随你的注视位置。");
      })
      .catch(() => {
        if (detector) {
          reportTrackingStatus("眼部模型暂不可用，已使用人脸位置估算注视点。");
          return;
        }

        reportTrackingStatus(
          "当前环境缺少眼部追踪能力，可先用鼠标在画面内模拟注视点。",
        );
      });

    const tick = async () => {
      if (disposed || !videoRef.current) {
        return;
      }

      try {
        const video = videoRef.current;
        let nextGaze: { point: GazePoint; source: GazeTrackingSource } | null =
          null;

        if (
          faceLandmarker &&
          video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA
        ) {
          const result = faceLandmarker.detectForVideo(
            video,
            performance.now(),
          );
          const eyeGaze = estimateGazeFromFaceLandmarks(
            result.faceLandmarks?.[0] ?? [],
          );
          if (eyeGaze) {
            nextGaze = { point: eyeGaze, source: "eye" };
          }
        }

        if (!nextGaze && detector) {
          const faces = await detector.detect(video);
          const first = faces[0];
          if (first) {
            const centerX =
              (first.boundingBox.x + first.boundingBox.width / 2) /
              video.videoWidth;
            const centerY =
              (first.boundingBox.y + first.boundingBox.height / 2) /
              video.videoHeight;
            nextGaze = {
              point: { x: clamp(centerX), y: clamp(centerY) },
              source: "face",
            };
          }
        }

        if (nextGaze) {
          updateRawGaze(nextGaze.point, nextGaze.source);
        }
      } catch {
        // Ignore detector errors; mouse fallback remains available.
      }

      timer = window.setTimeout(() => {
        void tick();
      }, 40);
    };

    void tick();

    return () => {
      disposed = true;
      if (timer !== undefined) {
        window.clearTimeout(timer);
      }
      faceLandmarker?.close?.();
    };
  }, [cameraReady, reportTrackingStatus, updateRawGaze]);

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

      if (
        performance.now() - lastCameraGazeAtRef.current <=
        CAMERA_GAZE_STALE_MS
      ) {
        return;
      }

      updateRawGaze({ x: clamp(x), y: clamp(y) }, "mouse");
    };

    window.addEventListener("mousemove", onMove);
    return () => {
      window.removeEventListener("mousemove", onMove);
    };
  }, [updateRawGaze]);

  const getRecentEyeGazeAverage = useCallback((): GazePoint | null => {
    const nowMs = performance.now();
    const recentSamples = recentEyeGazeSamplesRef.current.filter(
      (sample) => nowMs - sample.receivedAtMs <= CALIBRATION_SAMPLE_WINDOW_MS,
    );
    recentEyeGazeSamplesRef.current = recentSamples;

    if (recentSamples.length === 0) {
      return null;
    }

    return averageGaze(recentSamples.map((sample) => sample.point));
  }, []);

  const captureConversationImage = useCallback((): string | undefined => {
    const video = videoRef.current;
    if (!video || video.videoWidth <= 0 || video.videoHeight <= 0) {
      return undefined;
    }

    const maxWidth = 640;
    const scale = Math.min(1, maxWidth / video.videoWidth);
    const width = Math.max(1, Math.round(video.videoWidth * scale));
    const height = Math.max(1, Math.round(video.videoHeight * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;

    const context = canvas.getContext("2d");
    if (!context) {
      return undefined;
    }

    context.drawImage(video, 0, 0, width, height);
    return canvas
      .toDataURL("image/jpeg", 0.72)
      .replace(/^data:image\/jpeg;base64,/, "");
  }, []);

  const onCalibrationCapture = useCallback(() => {
    if (calibrationStep >= CALIBRATION_POINTS.length) {
      return;
    }

    const calibrationRawGaze = getRecentEyeGazeAverage();
    if (!calibrationRawGaze) {
      onStatusChange(
        "还没有稳定的眼部追踪样本，校准不会记录鼠标位置。请看向摄像头，等水泡开始跟随眼睛后再点校准。",
      );
      return;
    }

    const nextStep = calibrationStep + 1;

    setCalibrationSamples((previous) => [
      ...previous,
      {
        raw: calibrationRawGaze,
        target: CALIBRATION_POINTS[calibrationStep],
      },
    ]);
    setCalibrationStep(nextStep);
    onStatusChange(
      nextStep >= CALIBRATION_POINTS.length
        ? "校准完成，桌面水泡会使用你的眼动样本重新映射屏幕位置。"
        : `已记录第 ${nextStep} 个校准点，请继续看向下一个点。`,
    );
  }, [calibrationStep, getRecentEyeGazeAverage, onStatusChange]);

  return {
    cameraReady,
    calibrated,
    calibrationStep,
    captureConversationImage,
    currentCalibrationPoint: getCurrentCalibrationPoint(calibrationStep),
    gaze,
    onCalibrationCapture,
    videoRef,
  };
}

async function createMediaPipeFaceLandmarker(): Promise<FaceLandmarkerLike> {
  const { FaceLandmarker, FilesetResolver } =
    (await import("@mediapipe/tasks-vision")) as MediaPipeTasksVision;
  const vision = await FilesetResolver.forVisionTasks(MEDIAPIPE_WASM_BASE_URL);

  return FaceLandmarker.createFromOptions(vision, {
    baseOptions: {
      delegate: "GPU",
      modelAssetPath: FACE_LANDMARKER_MODEL_URL,
    },
    numFaces: 1,
    runningMode: "VIDEO",
  });
}

function smoothGaze(previous: GazePoint, next: GazePoint): GazePoint {
  return {
    x: clamp(previous.x + (next.x - previous.x) * GAZE_SMOOTHING),
    y: clamp(previous.y + (next.y - previous.y) * GAZE_SMOOTHING),
  };
}

function averageGaze(points: GazePoint[]): GazePoint {
  return {
    x: clamp(points.reduce((sum, point) => sum + point.x, 0) / points.length),
    y: clamp(points.reduce((sum, point) => sum + point.y, 0) / points.length),
  };
}
