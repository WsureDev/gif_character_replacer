# 参与开发

需要 Node.js 20.19 或更高版本，建议使用 Node.js 22/24 LTS。项目使用 TypeScript，不需要 Python、GPU 或图像生成服务才能运行测试。

```bash
npm ci
npm run typecheck
npm test
npm run build
```

测试使用合成 GIF 和模拟 HTTP 响应，不应依赖真实 API Key 或产生生图费用。修改 GIF 编码、采样或恢复逻辑时，应验证帧序、逐帧时长、循环计数、透明度和来源映射；修改队列或 provider 时，应验证重试不会隐式产生额外请求，且凭据不进入任务文件。

`src/` 是处理链与 HTTP 服务，`web/` 是浏览器界面，`test/` 包含可独立运行的回归用例。编译产物在 `dist/` 和 `dist-web/`，不提交它们。

请先说明问题和复现步骤，再提交聚焦该问题的修改。涉及界面时，描述你验证的操作流程；涉及供应商兼容性时，说明响应结构和 HTTP 状态，但移除 API Key、secret、私人图片和带鉴权参数的链接。

不要提交 `.env`、真实用户素材、生成结果、浏览器存储导出或实验日志。新增代码默认按项目许可证贡献；复用第三方实现时保留来源和许可证，并更新 `THIRD_PARTY_NOTICES.md`。
