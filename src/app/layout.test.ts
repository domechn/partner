import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const workspaceRoot = process.cwd();

function readWorkspaceFile(path: string): string {
  return readFileSync(join(workspaceRoot, path), "utf8");
}

test("keeps the live conversation visible as a lower-left overlay", () => {
  const css = readWorkspaceFile("src/App.css");

  assert.match(css, /\.app-root\s*\{[^}]*height:\s*100vh;/s);
  assert.match(css, /\.app-root\s*\{[^}]*overflow:\s*hidden;/s);
  assert.match(css, /\.conversation-panel\s*\{[^}]*position:\s*absolute;/s);
  assert.match(css, /\.conversation-panel\s*\{[^}]*left:\s*20px;/s);
  assert.match(css, /\.conversation-panel\s*\{[^}]*bottom:\s*20px;/s);
  assert.match(css, /\.conversation-turns\s*\{[^}]*overflow-y:\s*auto;/s);
});

test("uses the shared button style across app controls", () => {
  const app = readWorkspaceFile("src/App.tsx");
  const cameraPanel = readWorkspaceFile("src/app/CameraPanel.tsx");
  const conversationPanel = readWorkspaceFile("src/app/ConversationPanel.tsx");

  assert.equal((app.match(/className="button /g) ?? []).length, 2);
  assert.match(cameraPanel, /className="button calibration-target"/);
  assert.equal(
    (conversationPanel.match(/className="button /g) ?? []).length,
    3,
  );
});
