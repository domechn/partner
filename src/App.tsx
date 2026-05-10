import { useState } from "react";
import "./App.css";
import { CameraPanel } from "./app/CameraPanel";
import { ConversationPanel } from "./app/ConversationPanel";
import { useCameraGaze } from "./app/useCameraGaze";
import { usePartnerConversation } from "./app/usePartnerConversation";

function App() {
  const [status, setStatus] = useState("等待摄像头初始化...");
  const {
    cameraReady,
    calibrated,
    calibrationStep,
    captureConversationImage,
    currentCalibrationPoint,
    gaze,
    onCalibrationCapture,
    videoRef,
  } = useCameraGaze({ onStatusChange: setStatus });
  const {
    canStreamConversation,
    clearConversationConfirmation,
    confirmConversationAction,
    conversationInput,
    conversationSnapshot,
    isStartingConversation,
    isTranscribing,
    lastAutomationResult,
    setConversationInput,
    startConversation,
    stopConversation,
    submitConversationInput,
    transcript,
  } = usePartnerConversation({
    captureImage: captureConversationImage,
    gaze,
    onStatusChange: setStatus,
  });

  return (
    <main className="app-root">
      <header className="top-bar">
        <div className="brand-block">
          <h1>Partner MVP</h1>
          <p>本地运行 · 摄像头追踪 · 持续对话</p>
        </div>

        <p className="status-banner">状态：{status}</p>

        <div className="action-bar" aria-label="会话控制">
          <button
            type="button"
            className="button button-primary"
            onClick={() => void startConversation()}
            disabled={isStartingConversation || conversationSnapshot.isActive}
          >
            {isStartingConversation
              ? "正在开启对话..."
              : conversationSnapshot.isActive
                ? "对话进行中"
                : "开启对话"}
          </button>
          <button
            type="button"
            className="button button-secondary"
            onClick={() => void stopConversation()}
            disabled={!conversationSnapshot.isActive}
          >
            停止对话
          </button>
        </div>
      </header>

      <section className="grid">
        <CameraPanel
          calibrated={calibrated}
          calibrationStep={calibrationStep}
          currentCalibrationPoint={currentCalibrationPoint}
          gaze={gaze}
          onCalibrationCapture={onCalibrationCapture}
          videoRef={videoRef}
        />
        <ConversationPanel
          calibrated={calibrated}
          calibrationStep={calibrationStep}
          cameraReady={cameraReady}
          canStreamConversation={canStreamConversation}
          clearConversationConfirmation={clearConversationConfirmation}
          confirmConversationAction={confirmConversationAction}
          conversationInput={conversationInput}
          conversationSnapshot={conversationSnapshot}
          isTranscribing={isTranscribing}
          lastAutomationResult={lastAutomationResult}
          setConversationInput={setConversationInput}
          submitConversationInput={submitConversationInput}
          transcript={transcript}
        />
      </section>
    </main>
  );
}

export default App;
