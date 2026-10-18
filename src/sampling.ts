import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { decodeGif } from './gif.js';
import { sha256, isOpaque, opaqueRgb } from './pixels.js';
import { createOutputDirectory, readAnimation, writeJson } from './manifests.js';
import { assemble } from './pipeline.js';
import type { AnimationManifest } from './types.js';
import { checkCanvas } from './types.js';
import { squarePixelSize } from './pixel-aspect.js';

/** Sample on the source timeline. GIF centiseconds and the total duration remain exact. */
export function sampleTimeline(delays: number[], maxFps: number, frameCount?: number) {
  if (!delays.length || delays.some(n => !Number.isInteger(n) || n < 0 || n % 10 || n > 655350)
    || !Number.isFinite(maxFps) || maxFps < 0) throw new Error('Invalid frame delays or FPS limit.');
  const total = delays.reduce((sum, n) => sum + n, 0);
  const unchanged = () => delays.map((delayMs, sourceIndex) => ({ sourceIndex, delayMs }));
  if (frameCount !== undefined) {
    if (!Number.isInteger(frameCount) || frameCount < 1 || frameCount > delays.length || maxFps !== 0) {
      throw new Error('保留帧数必须在原始帧数范围内，且不能同时设置 FPS。');
    }
    if (frameCount === delays.length) return unchanged();
    if (!total) throw new Error('原 GIF 的帧时长全部为 0，无法减少帧数；请保留全部原帧。');
    const starts: number[] = [];
    let elapsed = 0;
    for (const delay of delays) { starts.push(elapsed); elapsed += delay; }
    const indexes = [0];
    let candidate = 0;
    for (let i = 1; i < frameCount; i++) {
      const time = total * i / frameCount;
      while (candidate < delays.length - 1 && starts[candidate + 1]! <= time) candidate++;
      indexes.push(Math.min(delays.length - (frameCount - i), Math.max(indexes.at(-1)! + 1, candidate)));
    }
    const selected = indexes.map((sourceIndex, i) => ({ sourceIndex,
      delayMs: (i + 1 < indexes.length ? starts[indexes[i + 1]!]! : total) - starts[sourceIndex]! }));
    if (selected.some(f => f.delayMs > 655350)) throw new Error('采样后的单帧时长超过 GIF 上限，请增加保留帧数。');
    return selected;
  }
  if (!maxFps) return unchanged();
  if (!total) throw new Error('原 GIF 的帧时长全部为 0，无法按时间降帧率；请选择保留原帧率。');
  const count = Math.min(delays.length, Math.max(1, Math.floor(total * maxFps / 1000 + 1e-9)));
  if (count === delays.length) return unchanged();
  const result: { sourceIndex: number; delayMs: number }[] = [];
  const totalCs = total / 10;
  let index = 0, end = delays[0]!;
  for (let i = 0; i < count; i++) {
    const start = Math.floor(i * totalCs / count) * 10;
    const stop = Math.floor((i + 1) * totalCs / count) * 10;
    while (index < delays.length - 1 && end <= start) end += delays[++index]!;
    const last = result.at(-1);
    if (last?.sourceIndex === index && last.delayMs + stop - start <= 655350) last.delayMs += stop - start;
    else result.push({ sourceIndex: index, delayMs: stop - start });
  }
  if (result.some(f => f.delayMs > 655350)) throw new Error('采样后的单帧时长超过 GIF 上限，请提高帧率。');
  return result;
}

export function sampleSelectedFrames(delays: number[], indices: number[]) {
  if (!indices.length || indices[0] !== 0 || indices.some((n, i) => !Number.isInteger(n) || n < 0 || n >= delays.length || (i > 0 && n <= indices[i - 1]!))) {
    throw new Error('Invalid content-aware frame selection.');
  }
  const selected = indices.map((sourceIndex, i) => ({ sourceIndex,
    delayMs: delays.slice(sourceIndex, indices[i + 1] ?? delays.length).reduce((sum, d) => sum + d, 0) }));
  if (selected.some(f => f.delayMs > 655350)) throw new Error('智能抽帧后的单帧时长超过 GIF 上限。');
  return selected;
}

export async function prepareSampledAnimation(input: string, out: string, scale: number, maxFps: number, frameCount?: number, selectedIndices?: number[], singleSourceIndex?: number) {
  if (!Number.isFinite(scale) || scale <= 0 || scale > 1) throw new Error('采样尺寸必须大于 0，且不能超过原图。');
  const bytes = await fs.readFile(input);
  const decoded = await decodeGif(bytes);
  const original = decoded.metadata;
  const display = squarePixelSize(original.width, original.height, original.pixelAspectRatio);
  const delays = original.frames.map(f => f.delayMs);
  if (singleSourceIndex !== undefined && (!Number.isInteger(singleSourceIndex) || singleSourceIndex < 0 || singleSourceIndex >= delays.length)) throw new Error('Invalid trial frame.');
  const selected = singleSourceIndex !== undefined ? [{ sourceIndex: singleSourceIndex, delayMs: delays[singleSourceIndex]! }]
    : selectedIndices ? sampleSelectedFrames(delays, selectedIndices) : sampleTimeline(delays, maxFps, frameCount);
  const width = Math.max(1, Math.round(display.width * scale));
  const height = Math.max(1, Math.round(display.height * scale));
  checkCanvas(width, height, selected.length);
  await createOutputDirectory(out);
  const animation: AnimationManifest = { version: 1, kind: 'animation',
    source: { name: path.basename(input), bytes: bytes.length, sha256: sha256(bytes) },
    width, height, loopCount: original.loopCount, pixelAspectRatio: 0, frames: [] };
  for (const [index, selection] of selected.entries()) {
    const source = decoded.frames[selection.sourceIndex]!;
    if (!isOpaque(source)) throw new Error('该 GIF 含透明显示帧；当前换角流程支持不透明 GIF，包括纯白背景。');
    const png = await sharp(opaqueRgb(source), { raw: { width: original.width, height: original.height, channels: 3 } })
      .resize(width, height, { fit: 'fill', kernel: 'lanczos3' }).png().toBuffer();
    const rgba = await sharp(png).ensureAlpha().raw().toBuffer();
    const file = `frame-${String(index).padStart(6, '0')}.png`;
    await fs.writeFile(path.join(out, file), png, { flag: 'wx' });
    animation.frames.push({ index, delayMs: selection.delayMs, hasGraphicControl: true, disposal: 1,
      sourceRect: { x: 0, y: 0, width, height }, transparentIndex: null, localPalette: false, interlaced: false,
      file, rgbaSha256: sha256(rgba), opaque: true });
  }
  await writeJson(path.join(out, 'animation.json'), animation);
  const summary = { pixelAspect: display, original: { width: display.width, height: display.height, frames: original.frameCount,
    durationMs: original.durationMs, averageFps: original.durationMs ? original.frameCount * 1000 / original.durationMs : 0,
    loopCount: original.loopCount },
    sampled: { width, height, frames: selected.length, durationMs: selected.reduce((n, f) => n + f.delayMs, 0),
      averageFps: selected.reduce((sum, f) => sum + f.delayMs, 0) ? selected.length * 1000 / selected.reduce((sum, f) => sum + f.delayMs, 0) : 0 },
    scale, maxFps, ...(frameCount !== undefined ? { frameCount } : {}), ...(selectedIndices ? { contentAware: true } : {}), mapping: selected };
  await writeJson(path.join(out, 'sampling.json'), summary);
  await assemble(path.join(out, 'animation.json'), path.join(out, 'preview.gif'), true);
  return summary;
}

export async function resizeFinalAnimation(input: string, out: string, width: number, height: number) {
  const animation = await readAnimation(input);
  const sourceWidth = animation.width, sourceHeight = animation.height;
  await createOutputDirectory(out);
  animation.width = width; animation.height = height;
  for (const frame of animation.frames) {
    const { data, info } = await sharp(await fs.readFile(path.join(path.dirname(input), frame.file))).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    if (info.width !== sourceWidth || info.height !== sourceHeight || sha256(data) !== frame.rgbaSha256) throw new Error('Final resize source differs from manifest.');
    const png = await sharp(opaqueRgb(data), { raw: { width: sourceWidth, height: sourceHeight, channels: 3 } }).resize(width, height, { fit: 'fill' }).png().toBuffer();
    frame.file = `frame-${String(frame.index).padStart(6, '0')}.png`;
    frame.sourceRect = { x: 0, y: 0, width, height };
    frame.rgbaSha256 = sha256(await sharp(png).ensureAlpha().raw().toBuffer());
    await fs.writeFile(path.join(out, frame.file), png, { flag: 'wx' });
  }
  await writeJson(path.join(out, 'animation.json'), animation);
  return assemble(path.join(out, 'animation.json'), path.join(out, 'edited.gif'), true);
}
