import test from "node:test";
import assert from "node:assert/strict";

import {
  canUseLocalSpeechRecognition,
  canUseSpeechRecognition,
  getSpeechRecognitionErrorMessage,
  getSpeechMode,
} from "./speech.ts";

test("disables built-in speech recognition inside the desktop shell", () => {
  assert.equal(
    canUseSpeechRecognition({
      hasSpeechRecognitionApi: true,
      isDesktopShell: true,
    }),
    false,
  );
});

test("allows built-in speech recognition in a regular browser when the API exists", () => {
  assert.equal(
    canUseSpeechRecognition({
      hasSpeechRecognitionApi: true,
      isDesktopShell: false,
    }),
    true,
  );
});

test("maps the network error to an actionable desktop message", () => {
  assert.equal(
    getSpeechRecognitionErrorMessage("network", { isDesktopShell: true }),
    "当前桌面端默认不支持内置语音识别服务，请改用下方文本命令，或接入原生/云端 STT。",
  );
});

test("enables local speech recognition in the desktop shell when microphone capture is available", () => {
  assert.equal(
    canUseLocalSpeechRecognition({
      hasMediaRecorderApi: true,
      hasUserMediaApi: true,
      isDesktopShell: true,
    }),
    true,
  );
});

test("prefers local speech mode in the desktop shell", () => {
  assert.equal(
    getSpeechMode({
      hasSpeechRecognitionApi: true,
      hasMediaRecorderApi: true,
      hasUserMediaApi: true,
      isDesktopShell: true,
    }),
    "local",
  );
});
