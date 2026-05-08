# partner

本仓库实现了一个本地可运行的 Electron + React + TypeScript MVP：

- 摄像头实时画面预览
- 注视光点（FaceDetector + 鼠标回退模拟）
- 5 点校准流程
- 语音命令解析（点击这里 / 输入 xxx / 切换 tab / 打开 xxx）
- Electron IPC 动作执行与高风险操作二次确认

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
- 目前动作执行主要在 Electron 窗口内模拟，`open_app` 会按平台尝试本地打开应用。
- 复杂 OCR、多模态模型推理、毫秒级全链路优化仍需在后续阶段继续完善。
