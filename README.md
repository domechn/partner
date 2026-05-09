# partner

本仓库实现了一个本地可运行的 Electron + React + TypeScript MVP：

- 摄像头实时画面预览
- 注视光点（MediaPipe 眼部 landmarks + FaceDetector + 鼠标回退模拟）
- 桌面级注视水泡 overlay，并把注视点上下文提供给本地 AI
- 5 点校准流程
- 本地 Ollama 对话回复，默认使用 Qwen3-VL-4B，并随用户轮次附带最近摄像头画面和当前屏幕截图
- Qwen3-TTS 语音回复，默认请求最轻量的 `Qwen/Qwen3-TTS-12Hz-0.6B-Base`；不可用时回退 macOS 系统 TTS
- 语音命令解析（点击这里 / 输入 xxx / 切换 tab / 打开 xxx / 模糊目标）
- Electron IPC 动作执行、自动目标拆解与高风险操作二次确认

## 运行

```bash
npm install
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
- 对话默认连接 `http://127.0.0.1:11434` 的 Ollama，模型默认 `qwen3-vl:4b`；可用 `PARTNER_OLLAMA_BASE_URL` 和 `PARTNER_OLLAMA_MODEL` 覆盖。每次用户提交语音/文本时会附带一张最近摄像头 JPEG 画面和一张当前主显示器屏幕截图给视觉模型，用于理解“这个软件”“屏幕上这个位置”等指代。
- macOS 首次读取屏幕内容可能需要在系统设置中授予屏幕录制权限；如果未授权，应用会继续对话，但视觉模型只能看到摄像头画面和注视点上下文。
- Qwen3-TTS 默认模型为 `Qwen/Qwen3-TTS-12Hz-0.6B-Base`；可用 `PARTNER_HF_TOKEN` 或 `HF_TOKEN` 访问 HuggingFace Inference API，也可用 `PARTNER_QWEN_TTS_ENDPOINT` 指向自托管 TTS endpoint，或用 `PARTNER_QWEN_TTS_MODEL` 覆盖模型。若 Qwen3-TTS 请求失败，会回退到 macOS `say`。
- macOS TTS 回退默认中文 voice 为 `Tingting`、英文 voice 为 `Samantha`；可用 `PARTNER_TTS_ZH_VOICE`、`PARTNER_TTS_EN_VOICE`、`PARTNER_TTS_VOICE` 和 `PARTNER_TTS_RATE` 调整。
- 目前动作执行主要在 Electron 窗口内模拟，`open_app` 会按平台尝试本地打开应用。
- 控制电脑部分参考 UI-TARS-desktop 的 operator/action 思路：先把用户目标拆成 `click/type/hotkey/open/wait/finished` 等步骤，再逐步执行。
- 对不够明确的语音需求，应用会先按规则规划：查找类需求打开浏览器搜索、打开类需求启动应用或链接、输入类需求写入当前焦点；涉及打开应用或链接时需要确认。
- 复杂 OCR、多模态模型推理、毫秒级全链路优化仍需在后续阶段继续完善。
