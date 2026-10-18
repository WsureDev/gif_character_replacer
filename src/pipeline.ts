import fs from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import sharp from 'sharp';
import { decodeGif, encodeGif } from './gif.js';
import { ImageProcessor } from './image-processor.js';
import { createOutputDirectory, readAnimation, readSheets, writeJson } from './manifests.js';
import { comparePixels, isOpaque, sha256 } from './pixels.js';
import { planSheets } from './sheets.js';
import { DEFAULT_LAYOUT, type AnimationManifest, type FrameFile, type LayoutOptions } from './types.js';

const images = new ImageProcessor();
const frameFile = (index: number) => `frame-${String(index).padStart(6, '0')}.png`;

async function loadFrame(base: string, frame: FrameFile, animation: AnimationManifest): Promise<{ png: Buffer; rgba: Buffer }> {
  const png = await fs.readFile(path.join(base, frame.file));
  const rgba = await images.readPng(png, animation.width, animation.height);
  if (sha256(rgba) !== frame.rgbaSha256 || isOpaque(rgba) !== frame.opaque) throw new Error(`Frame ${frame.index}: pixels do not match manifest.`);
  return { png, rgba };
}

export async function extract(input: string, out: string): Promise<AnimationManifest> {
  const bytes = await fs.readFile(input);
  const decoded = await decodeGif(bytes);
  await createOutputDirectory(out);
  const frames: FrameFile[] = [];
  for (const [i, rgba] of decoded.frames.entries()) {
    const file = frameFile(i);
    await fs.writeFile(path.join(out, file), await images.rgbaToPng(rgba, decoded.metadata.width, decoded.metadata.height), { flag: 'wx' });
    frames.push({ ...decoded.metadata.frames[i]!, file, rgbaSha256: sha256(rgba), opaque: isOpaque(rgba) });
  }
  const animation: AnimationManifest = {
    version: 1, kind: 'animation', source: { name: path.basename(input), sha256: sha256(bytes), bytes: bytes.length },
    width: decoded.metadata.width, height: decoded.metadata.height, loopCount: decoded.metadata.loopCount,
    pixelAspectRatio: decoded.metadata.pixelAspectRatio, frames,
  };
  await writeJson(path.join(out, 'animation.json'), animation);
  await writeJson(path.join(out, 'source-metadata.json'), decoded.metadata);
  return animation;
}

export async function pack(input: string, out: string, options = DEFAULT_LAYOUT) {
  const animation = await readAnimation(input);
  const manifest = planSheets(animation, options);
  await createOutputDirectory(out);
  for (const sheet of manifest.sheets) {
    const parts = [];
    for (const cell of sheet.cells) {
      const loaded = await loadFrame(path.dirname(input), animation.frames[cell.frameIndex]!, animation);
      parts.push({ input: loaded.png, rect: cell });
    }
    const png = await images.stitchSheet(parts, sheet.width, sheet.height, sheet.background === 'opaque');
    await fs.writeFile(path.join(out, sheet.file), png, { flag: 'wx' });
  }
  await writeJson(path.join(out, 'sheets.json'), manifest);
  return manifest;
}

export async function split(input: string, out: string, editedDirectory?: string): Promise<AnimationManifest> {
  const manifest = await readSheets(input);
  const animation = structuredClone(manifest.animation);
  const base = editedDirectory ?? path.dirname(input);
  await createOutputDirectory(out);
  for (const sheet of manifest.sheets) {
    const bytes = await fs.readFile(path.join(base, sheet.file));
    await images.readPng(bytes, sheet.width, sheet.height);
    const crops = await images.extractFrames(bytes, sheet.cells);
    for (const [i, png] of crops.entries()) {
      const cell = sheet.cells[i]!;
      const rgba = await images.readPng(png, cell.width, cell.height);
      if (cell.opaque && !isOpaque(rgba)) throw new Error(`Sheet ${sheet.file}, frame ${cell.frameIndex}: unexpected transparency in an opaque source frame.`);
      const file = frameFile(cell.frameIndex);
      animation.frames[cell.frameIndex] = {
        ...animation.frames[cell.frameIndex]!, file, rgbaSha256: sha256(rgba), opaque: isOpaque(rgba),
      };
      await fs.writeFile(path.join(out, file), png, { flag: 'wx' });
    }
  }
  await writeJson(path.join(out, 'animation.json'), animation);
  await writeJson(path.join(out, 'split-provenance.json'), {
    inputManifestSha256: sha256(await fs.readFile(input)), edited: !!editedDirectory,
    verification: editedDirectory ? 'size and opaque-frame alpha only; layout drift and character quality still require review' : 'local split',
  });
  return animation;
}

export async function assemble(input: string, out: string, allowQuantization = false) {
  const animation = await readAnimation(input);
  const frames: Buffer[] = [];
  for (const frame of animation.frames) frames.push((await loadFrame(path.dirname(input), frame, animation)).rgba);
  const result = encodeGif(frames, animation, animation.frames.map(f => f.delayMs), allowQuantization);
  // Verify the encoded animation before publishing it, including quantized alpha.
  const decoded = await decodeGif(result.bytes);
  const pixelChecks = frames.map((frame, i) => comparePixels(frame, decoded.frames[i]!));
  if (decoded.metadata.frameCount !== frames.length
    || decoded.metadata.loopCount !== animation.loopCount
    || decoded.metadata.frames.some((f, i) => f.delayMs !== animation.frames[i]!.delayMs)
    || pixelChecks.some(p => p.alphaErrors > 0)) throw new Error('Encoded GIF failed timing, loop, frame count or alpha verification.');
  if (pixelChecks.some((p, i) => !p.exact && !result.quantizedFrames.includes(i))) throw new Error('Unexpected pixel loss in exact-palette GIF encoding.');
  await fs.writeFile(out, result.bytes, { flag: 'wx' });
  return { bytes: result.bytes.length, quantizedFrames: result.quantizedFrames, pixelChecks };
}

export async function roundtrip(input: string, out: string, options: LayoutOptions = DEFAULT_LAYOUT, allowQuantization = false) {
  const started = performance.now();
  await createOutputDirectory(out);
  const original = await fs.readFile(input);
  await fs.writeFile(path.join(out, 'original.gif'), original, { flag: 'wx' });
  const source = await extract(input, path.join(out, 'frames'));
  const sheets = await pack(path.join(out, 'frames/animation.json'), path.join(out, 'sheets'), options);
  const restored = await split(path.join(out, 'sheets/sheets.json'), path.join(out, 'restored'));
  const pngExact = source.frames.every((f, i) => f.rgbaSha256 === restored.frames[i]!.rgbaSha256);
  if (!pngExact) throw new Error('PNG sheet roundtrip changed frame pixels.');
  const encoded = await assemble(path.join(out, 'restored/animation.json'), path.join(out, 'roundtrip.gif'), allowQuantization);
  const report = {
    version: 1, source: source.source, width: source.width, height: source.height,
    frames: source.frames.length, durationMs: source.frames.reduce((n, f) => n + f.delayMs, 0),
    loopCount: source.loopCount, opaqueFrames: source.frames.filter(f => f.opaque).length,
    delaysMs: [...new Set(source.frames.map(f => f.delayMs))].sort((a, b) => a - b),
    sourceDisposals: [...new Set(source.frames.map(f => f.disposal))],
    sheetCount: sheets.sheets.length, layout: options,
    sheets: sheets.sheets.map(s => ({ file: s.file, width: s.width, height: s.height, frames: s.cells.length, background: s.background })),
    checks: { pngPixelExact: pngExact, gifPixelExact: encoded.pixelChecks.every(p => p.exact), frameCount: true, delays: true, loop: true, alpha: true },
    encoding: { mode: 'full-frame palette baseline; size optimization not yet enabled', outputBytes: encoded.bytes,
      sizeRatio: encoded.bytes / original.length, quantizedFrames: encoded.quantizedFrames },
    pixelChecks: encoded.pixelChecks,
    elapsedMs: Math.round(performance.now() - started),
    versions: { node: process.version, sharp: sharp.versions.sharp, vips: sharp.versions.vips },
    visualReview: 'pending; automated checks cover pixels and timing, not character editing',
  };
  await writeJson(path.join(out, 'report.json'), report);
  return report;
}

export async function batch(inputDirectory: string, out: string, options = DEFAULT_LAYOUT, allowQuantization = false) {
  const names = (await fs.readdir(inputDirectory)).filter(name => /\.gif$/i.test(name)).sort();
  if (!names.length) throw new Error('No GIF files found.');
  await createOutputDirectory(out);
  const results = [];
  for (const [i, name] of names.entries()) {
    const directory = `case-${String(i + 1).padStart(2, '0')}`;
    try {
      const report = await roundtrip(path.join(inputDirectory, name), path.join(out, directory), options, allowQuantization);
      results.push({ name, directory, status: 'completed' as const, report });
      console.error(`${i + 1}/${names.length} ${name}: ${report.frames} frames, PNG exact=${report.checks.pngPixelExact}, GIF exact=${report.checks.gifPixelExact}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      results.push({ name, directory, status: 'failed' as const, error: message });
      console.error(`${i + 1}/${names.length} ${name}: FAILED: ${message}`);
    }
  }
  const report = { version: 1, results };
  await writeJson(path.join(out, 'batch-report.json'), report);
  const escape = (text: string) => text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
  const sections = results.map(result => {
    if (result.status !== 'completed') return `<section><h2>${escape(result.name)}</h2><p>${escape(result.error)}</p></section>`;
    const r = result.report;
    return `<section><h2>${escape(result.name)}</h2><p>${r.width}×${r.height} · ${r.frames} 帧 · ${r.durationMs} ms · ${r.sheetCount} 版 · PNG 像素一致：${r.checks.pngPixelExact} · GIF 像素一致：${r.checks.gifPixelExact} · 体积 ${(r.encoding.sizeRatio * 100).toFixed(1)}%</p><div class="pair"><figure><figcaption>原始 GIF</figcaption><img src="${result.directory}/original.gif"></figure><figure><figcaption>无 AI 往返 GIF</figcaption><img src="${result.directory}/roundtrip.gif"></figure></div><p><a href="${result.directory}/report.json">验证报告</a> · <a href="${result.directory}/sheets/sheet-0000.png">首张拼版</a></p></section>`;
  }).join('\n');
  await fs.writeFile(path.join(out, 'index.html'), `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>GIF 无 AI 往返测试</title><style>body{font:16px system-ui;margin:2rem;background:#eee;color:#222}section{background:white;padding:1rem;margin:1rem 0;border-radius:8px}.pair{display:flex;flex-wrap:wrap;gap:1rem}figure{margin:0}img{max-width:400px;max-height:400px;background:repeating-conic-gradient(#ddd 0% 25%,#fff 0% 50%) 0/20px 20px}p{line-height:1.6}a{color:#1455aa}</style><h1>GIF 无 AI 往返测试</h1><p>本页比较拆帧、拼版、切帧与合成结果。两张 GIF 的浏览器播放起点不保证同步；时序是否一致以报告检查为准。本阶段尚未替换角色，也尚未优化 GIF 体积。</p>${sections}</html>`, { flag: 'wx' });
  return report;
}
