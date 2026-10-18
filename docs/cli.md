# CLI 使用说明

在项目目录执行 `npm ci`。`npm run cli -- --help` 列出完整参数；编译后也可使用 `node dist/cli.js`。

示例假设自有素材位于 `materials/gifs/example.gif` 和 `materials/references/character.png`。这些素材不随仓库分发，也不会被 Git 跟踪。输出目录必须是新目录。

## 离线处理

```bash
npm run cli -- inspect --input ./materials/gifs/example.gif
npm run cli -- roundtrip --input ./materials/gifs/example.gif --out /tmp/gif-character-replacer/roundtrip-001
```

也可分步执行：

```bash
npm run cli -- extract --input ./materials/gifs/example.gif --out /tmp/gif-character-replacer/demo/frames
npm run cli -- pack --input /tmp/gif-character-replacer/demo/frames/animation.json --out /tmp/gif-character-replacer/demo/sheets --columns 3 --batch-size 9
npm run cli -- split --input /tmp/gif-character-replacer/demo/sheets/sheets.json --out /tmp/gif-character-replacer/demo/restored
npm run cli -- assemble --input /tmp/gif-character-replacer/demo/restored/animation.json --out /tmp/gif-character-replacer/demo/result.gif
```

`batch --input-dir DIR --out DIR` 批量验证素材并生成本地 HTML 对照报告。以上操作不读取供应商密钥，也不调用图片接口。

## 规划与生图

先用离线规划查看实际输入拼版：

```bash
npm run cli -- ai-auto-plan \
  --input /tmp/gif-character-replacer/demo/frames/animation.json \
  --reference ./materials/references/character.png \
  --output-min 1024x1024 --output-max 1536x1536 \
  --min-scale 1 --gutter 16 --margin 12 \
  --out /tmp/gif-character-replacer/plans-001
```

`ai-plan` 可手动选择连续帧，支持 `--start`、`--frames`、`--columns`、`--size`、`--subject`、`--character-notes` 和 `--extra-prompt`。`--reference` 可重复使用。

填写 `.env` 后，`ai-check --env .env` 只读取模型列表。模型出现在列表中不代表参数已经验证。

**以下命令会发送一次真实生图请求：**

```bash
npm run cli -- ai-edit \
  --input /tmp/gif-character-replacer/plans-001/batch-000/plan.json \
  --out /tmp/gif-character-replacer/edit-001 --env .env
```

每次请求 `n=1`、PNG、不透明背景，自动重试关闭。返回图、请求参数、状态及校验结果保留；已有输出目录不会再次提交。

## 本地恢复与组装

`ai-recover` 只处理已有完整拼版，不重新生图：

```bash
npm run cli -- ai-recover \
  --input /tmp/gif-character-replacer/plans-001/batch-000/plan.json \
  --against /tmp/gif-character-replacer/edit-001/edited-sheet.png \
  --out /tmp/gif-character-replacer/recovered-001
```

有角标时使用角标定位，无角标时需要白色分隔带佐证。不能验证边界时停止，不猜测坐标。

`ai-assemble --input bundle.json --out DIR` 将完整批次合成 GIF。示例：

```json
{
  "version": 1,
  "source": "source/animation.json",
  "batches": [
    {
      "id": "batch-000",
      "plan": "plans/batch-000/plan.json",
      "frames": "recovered-000/frames",
      "origin": "generated"
    }
  ]
}
```

路径相对 `bundle.json`。批次必须完整覆盖原清单，帧哈希、时长、参考图和透明度会校验。Web 去重任务还需要映射还原，不能把代表帧集合直接作为完整动画，详见 [Web 说明](web-lab.md)。

`ai-report --input-dir DIR --out DIR/report` 生成本地对照页。安装 FFmpeg 后，`verify --input ORIGINAL --against OUTPUT --out REPORT.json` 可独立核对解码结果；FFmpeg 不是常规启动和测试的必需依赖。
