import type { GazePoint } from "../src/lib/intent.ts";

export type GazeOverlaySize = {
  width: number;
  height: number;
};

export type GazeOverlayPoint = {
  x: number;
  y: number;
};

export function resolveGazeOverlayPoint(
  gaze: GazePoint,
  size: GazeOverlaySize,
): GazeOverlayPoint {
  return {
    x: Math.round(clamp(gaze.x) * size.width),
    y: Math.round(clamp(gaze.y) * size.height),
  };
}

export function buildGazeOverlayHtml(): string {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <style>
      html,
      body {
        width: 100%;
        height: 100%;
        margin: 0;
        overflow: hidden;
        background: transparent;
        pointer-events: none;
      }

      #gaze-bubble {
        position: fixed;
        left: 50%;
        top: 50%;
        width: 34px;
        height: 34px;
        border: 2px solid rgba(255, 255, 255, 0.9);
        border-radius: 50%;
        background: rgba(70, 217, 208, 0.38);
        box-shadow: 0 0 24px rgba(70, 217, 208, 0.78), inset 0 0 18px rgba(255, 255, 255, 0.22);
        opacity: 0;
        transform: translate(-50%, -50%);
        transition: left 90ms linear, top 90ms linear, opacity 160ms ease;
      }
    </style>
  </head>
  <body>
    <div id="gaze-bubble" aria-hidden="true"></div>
    <script>
      const bubble = document.getElementById("gaze-bubble");

      window.partnerSetGaze = function partnerSetGaze(point) {
        if (!bubble || !point) {
          return;
        }

        bubble.style.left = String(point.x) + "px";
        bubble.style.top = String(point.y) + "px";
        bubble.style.opacity = "1";
      };
    </script>
  </body>
</html>`;
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}
