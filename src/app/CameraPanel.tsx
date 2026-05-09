import type { RefObject } from "react";

import { type GazePoint } from "../lib/intent";

export type CameraPanelProps = {
  calibrated: boolean;
  calibrationStep: number;
  currentCalibrationPoint: GazePoint;
  gaze: GazePoint;
  onCalibrationCapture: () => void;
  videoRef: RefObject<HTMLVideoElement | null>;
};

export function CameraPanel(props: CameraPanelProps) {
  const {
    calibrated,
    calibrationStep,
    currentCalibrationPoint,
    gaze,
    onCalibrationCapture,
    videoRef,
  } = props;

  return (
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
          className="button calibration-target"
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
  );
}
