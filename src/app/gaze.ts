import { type GazePoint } from "../lib/intent.ts";

export type FaceLandmark = {
  x: number;
  y: number;
  z?: number;
};

export type CalibrationSample = {
  raw: GazePoint;
  target: GazePoint;
};

export const CALIBRATION_POINTS: GazePoint[] = [
  { x: 0.1, y: 0.1 },
  { x: 0.9, y: 0.1 },
  { x: 0.5, y: 0.5 },
  { x: 0.1, y: 0.9 },
  { x: 0.9, y: 0.9 },
];

export function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}

export function mapWithCalibration(
  raw: GazePoint,
  samples: CalibrationSample[],
): GazePoint {
  if (samples.length < 2) {
    return raw;
  }

  const xRangeRaw =
    Math.max(...samples.map((sample) => sample.raw.x)) -
    Math.min(...samples.map((sample) => sample.raw.x));
  const yRangeRaw =
    Math.max(...samples.map((sample) => sample.raw.y)) -
    Math.min(...samples.map((sample) => sample.raw.y));

  const xRangeTarget =
    Math.max(...samples.map((sample) => sample.target.x)) -
    Math.min(...samples.map((sample) => sample.target.x));
  const yRangeTarget =
    Math.max(...samples.map((sample) => sample.target.y)) -
    Math.min(...samples.map((sample) => sample.target.y));

  if (xRangeRaw <= 0.001 || yRangeRaw <= 0.001) {
    return raw;
  }

  const xMinRaw = Math.min(...samples.map((sample) => sample.raw.x));
  const yMinRaw = Math.min(...samples.map((sample) => sample.raw.y));
  const xMinTarget = Math.min(...samples.map((sample) => sample.target.x));
  const yMinTarget = Math.min(...samples.map((sample) => sample.target.y));

  const x = ((raw.x - xMinRaw) / xRangeRaw) * xRangeTarget + xMinTarget;
  const y = ((raw.y - yMinRaw) / yRangeRaw) * yRangeTarget + yMinTarget;

  return { x: clamp(x), y: clamp(y) };
}

export function getCurrentCalibrationPoint(step: number): GazePoint {
  return CALIBRATION_POINTS[Math.min(step, CALIBRATION_POINTS.length - 1)];
}

export function estimateGazeFromFaceLandmarks(
  landmarks: FaceLandmark[],
): GazePoint | null {
  const leftEye = measureEyeGaze(landmarks, {
    outerCorner: 33,
    innerCorner: 133,
    upperLid: 159,
    lowerLid: 145,
    irisCenter: 468,
  });
  const rightEye = measureEyeGaze(landmarks, {
    outerCorner: 362,
    innerCorner: 263,
    upperLid: 386,
    lowerLid: 374,
    irisCenter: 473,
  });

  if (!leftEye && !rightEye) {
    return null;
  }

  const eyes = [leftEye, rightEye].filter(
    (eye): eye is { xRatio: number; yRatio: number } => eye !== null,
  );
  const xRatio = average(eyes.map((eye) => eye.xRatio));
  const yRatio = average(eyes.map((eye) => eye.yRatio));

  return {
    x: clamp(0.5 + (xRatio - 0.5) * 1.85),
    y: clamp(0.5 + (yRatio - 0.5) * 1.85),
  };
}

function measureEyeGaze(
  landmarks: FaceLandmark[],
  indices: {
    outerCorner: number;
    innerCorner: number;
    upperLid: number;
    lowerLid: number;
    irisCenter: number;
  },
): { xRatio: number; yRatio: number } | null {
  const outerCorner = landmarks[indices.outerCorner];
  const innerCorner = landmarks[indices.innerCorner];
  const upperLid = landmarks[indices.upperLid];
  const lowerLid = landmarks[indices.lowerLid];
  const irisCenter = landmarks[indices.irisCenter];

  if (!outerCorner || !innerCorner || !upperLid || !lowerLid || !irisCenter) {
    return null;
  }

  const xMin = Math.min(outerCorner.x, innerCorner.x);
  const xMax = Math.max(outerCorner.x, innerCorner.x);
  const yMin = Math.min(upperLid.y, lowerLid.y);
  const yMax = Math.max(upperLid.y, lowerLid.y);
  const xRange = xMax - xMin;
  const yRange = yMax - yMin;

  if (xRange <= 0.001 || yRange <= 0.001) {
    return null;
  }

  return {
    xRatio: clamp((irisCenter.x - xMin) / xRange),
    yRatio: clamp((irisCenter.y - yMin) / yRange),
  };
}

function average(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}
