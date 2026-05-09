export type SpeechRecognitionEnvironment = {
  hasSpeechRecognitionApi: boolean;
  isDesktopShell: boolean;
};

export type LocalSpeechRecognitionEnvironment = {
  hasMediaRecorderApi: boolean;
  hasUserMediaApi: boolean;
  isDesktopShell: boolean;
};

export type SpeechModeEnvironment = SpeechRecognitionEnvironment &
  LocalSpeechRecognitionEnvironment;

export type SpeechMode = "browser" | "local" | "manual";

export function canUseSpeechRecognition(
  environment: SpeechRecognitionEnvironment,
): boolean {
  return environment.hasSpeechRecognitionApi && !environment.isDesktopShell;
}

export function canUseLocalSpeechRecognition(
  environment: LocalSpeechRecognitionEnvironment,
): boolean {
  return (
    environment.isDesktopShell &&
    environment.hasMediaRecorderApi &&
    environment.hasUserMediaApi
  );
}

export function getSpeechMode(environment: SpeechModeEnvironment): SpeechMode {
  if (canUseLocalSpeechRecognition(environment)) {
    return "local";
  }

  if (canUseSpeechRecognition(environment)) {
    return "browser";
  }

  return "manual";
}

export function getSpeechRecognitionErrorMessage(
  error: string,
  options: { isDesktopShell: boolean },
): string {
  if (error === "network") {
    if (options.isDesktopShell) {
      return "当前桌面端默认不支持内置语音识别服务，请改用下方文本命令，或接入原生/云端 STT。";
    }

    return "语音识别服务暂时不可用，请检查网络后重试。";
  }

  if (error === "not-allowed" || error === "service-not-allowed") {
    return "语音权限未开启，请检查系统麦克风权限。";
  }

  if (error === "audio-capture") {
    return "未检测到可用麦克风，请检查设备或权限。";
  }

  if (error === "no-speech") {
    return "没有检测到清晰语音，请重试。";
  }

  return `语音识别错误: ${error}`;
}

export function getLocalSpeechRecognitionErrorMessage(error: unknown): string {
  if (error instanceof DOMException) {
    if (error.name === "NotAllowedError") {
      return "麦克风权限未开启，请检查系统设置。";
    }

    if (error.name === "NotFoundError") {
      return "未检测到可用麦克风，请检查设备连接。";
    }
  }

  const message = error instanceof Error ? error.message : String(error ?? "");
  if (/fetch|network|download|model/i.test(message)) {
    return "本地语音模型下载失败，请联网完成首次下载后重试。";
  }

  if (/decode|audio|codec/i.test(message)) {
    return "音频解析失败，请重试。";
  }

  return "本地语音识别失败，请重试。";
}
