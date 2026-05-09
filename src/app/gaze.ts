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

  const affineCalibration = solveAffineCalibration(samples);
  if (affineCalibration) {
    return {
      x: clamp(applyAffine(raw, affineCalibration.x)),
      y: clamp(applyAffine(raw, affineCalibration.y)),
    };
  }

  const xAxis = solveAxisCalibration(
    samples.map((sample) => ({ raw: sample.raw.x, target: sample.target.x })),
  );
  const yAxis = solveAxisCalibration(
    samples.map((sample) => ({ raw: sample.raw.y, target: sample.target.y })),
  );

  return {
    x: clamp(xAxis ? applyAxis(raw.x, xAxis) : raw.x),
    y: clamp(yAxis ? applyAxis(raw.y, yAxis) : raw.y),
  };
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

type AxisCalibration = {
  slope: number;
  intercept: number;
};

type AffineCoefficients = readonly [number, number, number];

type AffineCalibration = {
  x: AffineCoefficients;
  y: AffineCoefficients;
};

function solveAxisCalibration(
  points: Array<{ raw: number; target: number }>,
): AxisCalibration | null {
  const rawMean = average(points.map((point) => point.raw));
  const targetMean = average(points.map((point) => point.target));
  let numerator = 0;
  let denominator = 0;

  for (const point of points) {
    const rawDelta = point.raw - rawMean;
    numerator += rawDelta * (point.target - targetMean);
    denominator += rawDelta * rawDelta;
  }

  if (denominator <= 0.000001) {
    return null;
  }

  const slope = numerator / denominator;
  return {
    slope,
    intercept: targetMean - slope * rawMean,
  };
}

function applyAxis(raw: number, calibration: AxisCalibration): number {
  return calibration.slope * raw + calibration.intercept;
}

function solveAffineCalibration(
  samples: CalibrationSample[],
): AffineCalibration | null {
  if (samples.length < 3) {
    return null;
  }

  const x = solveAffineAxis(samples, (sample) => sample.target.x);
  const y = solveAffineAxis(samples, (sample) => sample.target.y);
  if (!x || !y) {
    return null;
  }

  return { x, y };
}

function solveAffineAxis(
  samples: CalibrationSample[],
  getTarget: (sample: CalibrationSample) => number,
): AffineCoefficients | null {
  const matrix = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  const vector = [0, 0, 0];

  for (const sample of samples) {
    const input = [sample.raw.x, sample.raw.y, 1];
    const target = getTarget(sample);

    for (let row = 0; row < 3; row += 1) {
      vector[row] += input[row] * target;
      for (let column = 0; column < 3; column += 1) {
        matrix[row][column] += input[row] * input[column];
      }
    }
  }

  return solveThreeByThree(matrix, vector);
}

function applyAffine(raw: GazePoint, coefficients: AffineCoefficients): number {
  return coefficients[0] * raw.x + coefficients[1] * raw.y + coefficients[2];
}

function solveThreeByThree(
  matrix: number[][],
  vector: number[],
): AffineCoefficients | null {
  const augmented = matrix.map((row, index) => [...row, vector[index] ?? 0]);

  for (let pivotIndex = 0; pivotIndex < 3; pivotIndex += 1) {
    let bestRow = pivotIndex;
    for (let row = pivotIndex + 1; row < 3; row += 1) {
      if (
        Math.abs(augmented[row]?.[pivotIndex] ?? 0) >
        Math.abs(augmented[bestRow]?.[pivotIndex] ?? 0)
      ) {
        bestRow = row;
      }
    }

    const pivot = augmented[bestRow]?.[pivotIndex] ?? 0;
    if (Math.abs(pivot) <= 0.000001) {
      return null;
    }

    if (bestRow !== pivotIndex) {
      const nextPivotRow = augmented[pivotIndex];
      augmented[pivotIndex] = augmented[bestRow] ?? [];
      augmented[bestRow] = nextPivotRow ?? [];
    }

    for (let column = pivotIndex; column < 4; column += 1) {
      augmented[pivotIndex][column] =
        (augmented[pivotIndex][column] ?? 0) / pivot;
    }

    for (let row = 0; row < 3; row += 1) {
      if (row === pivotIndex) {
        continue;
      }

      const factor = augmented[row]?.[pivotIndex] ?? 0;
      for (let column = pivotIndex; column < 4; column += 1) {
        augmented[row][column] =
          (augmented[row][column] ?? 0) -
          factor * (augmented[pivotIndex][column] ?? 0);
      }
    }
  }

  return [
    augmented[0]?.[3] ?? 0,
    augmented[1]?.[3] ?? 0,
    augmented[2]?.[3] ?? 0,
  ];
}
