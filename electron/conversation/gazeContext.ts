import type { GazePoint } from "../../src/lib/intent.ts";

export function buildConversationSystemPrompt(
  basePrompt: string,
  gaze: GazePoint,
): string {
  return [basePrompt.trim(), formatGazeContextForPrompt(gaze)]
    .filter(Boolean)
    .join("\n");
}

export function formatGazeContextForPrompt(gaze: GazePoint): string {
  const x = clamp(gaze.x);
  const y = clamp(gaze.y);
  const area = describeGazeArea(x, y);

  return [
    `当前用户注视点：${area} (x=${formatPercent(x)}, y=${formatPercent(y)})。`,
    "当用户说“这里”“这个”“那里”或类似指代时，把它理解为该注视点附近的屏幕位置。",
  ].join("");
}

function describeGazeArea(x: number, y: number): string {
  const horizontal = x < 0.34 ? "左" : x > 0.66 ? "右" : "中";
  const vertical = y < 0.34 ? "上" : y > 0.66 ? "下" : "中";

  if (horizontal === "中" && vertical === "中") {
    return "屏幕中央";
  }

  if (horizontal === "中") {
    return `屏幕${vertical}方区域`;
  }

  if (vertical === "中") {
    return `屏幕${horizontal}侧区域`;
  }

  return `屏幕${horizontal}${vertical}区域`;
}

function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}
