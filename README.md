# partner

本仓库实现了一个本地可运行的 Electron + React + TypeScript MVP：

- 摄像头实时画面预览
- 注视光点（MediaPipe 眼部 landmarks + FaceDetector + 鼠标回退模拟）
- 桌面级注视水泡 overlay，并把注视点上下文提供给本地 AI
- 5 点校准流程
- Python Partner 服务负责本地 AI 对话，使用 Gemma 4 E2B LiteRT-LM 处理语音/文本/画面输入
- 本地 TTS 语音回复；中文在 macOS 上使用系统中文语音，其他文本默认使用 Kokoro，并通过 WebSocket 流式传回 Electron 渲染端播放
- 语音命令解析（点击这里 / 输入 xxx / 切换 tab / 打开 xxx / 模糊目标）
- Electron IPC 动作执行、自动目标拆解与高风险操作二次确认

## 运行

```bash
npm install
cd python && uv sync && cd ..
npm run dev
```

## 构建与校验

```bash
npm run lint
npm run build
npm test
```

## 说明

- 该版本是 MVP，优先打通“摄像头 + 注视点 + 语音 + 执行动作”闭环。
- 眼部追踪优先使用 MediaPipe FaceLandmarker；首次加载需要联网获取 MediaPipe wasm/model 资源，失败时自动退回 FaceDetector 或鼠标模拟。
- 桌面水泡 overlay 默认开启；如需关闭可设置 `PARTNER_GAZE_OVERLAY=0`。
- 对话默认由 Electron 启动 `python/server.py`，服务监听 `127.0.0.1:8765`；可用 `PARTNER_SERVER_PORT` 覆盖端口。首次运行会从 Hugging Face 下载 `litert-community/gemma-4-E2B-it-litert-lm` 的 LiteRT-LM 模型。
- 语音和文本输入都会通过 WebSocket 发给 Python Partner 服务；当前主路径不使用 Ollama fallback。
- 每次用户提交语音/文本时会附带最近摄像头 JPEG 画面和当前主屏幕截图，用于同时理解“这个”“我指的内容”和“我屏幕上的这个”之类的指代。
- macOS 首次读取屏幕内容可能需要在系统设置中授予屏幕录制权限；如果未授权，应用会继续对话，但视觉模型只能看到摄像头画面和注视点上下文。
- TTS 默认使用 Kokoro 的 Apple Silicon MLX 后端，未安装时回退 `kokoro-onnx`；中文播报会在 macOS 上自动改用系统中文语音（默认 `Tingting`，可用 `PARTNER_TTS_ZH_VOICE` 覆盖）。可设置 `KOKORO_ONNX=1` 强制 Kokoro 使用 ONNX。
- 目前动作执行主要在 Electron 窗口内模拟，`open_app` 会按平台尝试本地打开应用。
- 控制电脑部分参考 UI-TARS-desktop 的 operator/action 思路：先把用户目标拆成 `click/type/hotkey/open/wait/finished` 等步骤，再逐步执行。
- 对不够明确的语音需求，应用会先按规则规划：查找类需求打开浏览器搜索、打开类需求启动应用或链接、输入类需求写入当前焦点；涉及打开应用或链接时需要确认。
- 复杂 OCR、多模态模型推理、毫秒级全链路优化仍需在后续阶段继续完善。
