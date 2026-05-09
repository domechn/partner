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

export type UseCameraGazeOptions = {
  onStatusChange: (status: string) => void;
};

export type UseCameraGazeResult = {
  cameraReady: boolean;
  calibrated: boolean;
  calibrationStep: number;
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
        let nextGaze: GazePoint | null = null;

        if (
          faceLandmarker &&
          video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA
        ) {
          const result = faceLandmarker.detectForVideo(
            video,
            performance.now(),
          );
          nextGaze = estimateGazeFromFaceLandmarks(
            result.faceLandmarks?.[0] ?? [],
          );
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
            nextGaze = { x: clamp(centerX), y: clamp(centerY) };
          }
        }

        if (nextGaze) {
          setRawGaze(nextGaze);
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
  }, [cameraReady, reportTrackingStatus]);

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

    setCalibrationSamples((previous) => [
      ...previous,
      {
        raw: rawGaze,
        target: CALIBRATION_POINTS[calibrationStep],
      },
    ]);
    setCalibrationStep((step) => step + 1);
  }, [calibrationStep, rawGaze]);

  return {
    cameraReady,
    calibrated,
    calibrationStep,
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
