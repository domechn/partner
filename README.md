# partner

本仓库实现了一个本地可运行的 Electron + React + TypeScript MVP：

- 摄像头实时画面预览
- 注视光点（MediaPipe 眼部 landmarks + FaceDetector + 鼠标回退模拟）
- 桌面级注视水泡 overlay，并把注视点上下文提供给本地 AI
- 5 点校准流程
- 本地 Ollama 对话回复，Ollama 暂不可用时会给出可见兜底回复
- macOS 系统 TTS 播放回复，按中文/英文自动选择 voice
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
- 对话默认连接 `http://127.0.0.1:11434` 的 Ollama，模型默认 `qwen2.5:7b`；可用 `PARTNER_OLLAMA_BASE_URL` 和 `PARTNER_OLLAMA_MODEL` 覆盖。
- macOS TTS 默认中文 voice 为 `Tingting`、英文 voice 为 `Samantha`；可用 `PARTNER_TTS_ZH_VOICE`、`PARTNER_TTS_EN_VOICE`、`PARTNER_TTS_VOICE` 和 `PARTNER_TTS_RATE` 调整。
- 目前动作执行主要在 Electron 窗口内模拟，`open_app` 会按平台尝试本地打开应用。
- 控制电脑部分参考 UI-TARS-desktop 的 operator/action 思路：先把用户目标拆成 `click/type/hotkey/open/wait/finished` 等步骤，再逐步执行。
- 对不够明确的语音需求，应用会先按规则规划：查找类需求打开浏览器搜索、打开类需求启动应用或链接、输入类需求写入当前焦点；涉及打开应用或链接时需要确认。
- 复杂 OCR、多模态模型推理、毫秒级全链路优化仍需在后续阶段继续完善。
