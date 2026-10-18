import fs from 'node:fs/promises';
import path from 'node:path';
import { availableParallelism } from 'node:os';
import { Worker } from 'node:worker_threads';
import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { inspectGif } from './gif.js';
import { sha256 } from './pixels.js';
import { calculateMotionJob, type MotionJob } from './motion-metrics.js';
import { squarePixelSize } from './pixel-aspect.js';

export type MotionPresetId = 'gentle' | 'balanced' | 'compact';
export interface MotionPreset { id: MotionPresetId; label: string; indices: number[]; frames: number; averageFps: number;
  reduction: number; maxError: number; meanError: number; busiestWindowFps: number }
export interface MotionAnalysis { version: 1; sourceSha256: string; width: number; height: number; frames: number; durationMs: number;
  thumbnail: { width: number; height: number }; workers: number; adjacentPairsEvaluated: number; elapsedMs: number;
  adjacentScores: number[]; similarFraction: number; recommendedId: MotionPresetId;
  windows: { startMs: number; endMs: number; motion: number; peakFrame: number; frameCount: number }[]; presets: MotionPreset[] }
export type AnalysisState = { status: 'queued' | 'analyzing' | 'ready' | 'failed'; message: string; completedPairs?: number; totalPairs?: number;
  analysis?: ReturnType<typeof publicMotion>; error?: string };
export function publicMotion(a: MotionAnalysis) {
  return { ...a, adjacentScores: undefined, presets: a.presets.map(({ indices: _indices, ...preset }) => preset) };
}
async function runWorker(job: MotionJob): Promise<ReturnType<typeof calculateMotionJob>> {
  return new Promise((resolve, reject) => {
    const file = new URL(import.meta.url.endsWith('.ts') ? './motion-worker.ts' : './motion-worker.js', import.meta.url);
    // Do not inherit test-runner/V8/STDIN flags that Worker does not accept.
    const worker = new Worker(file, { workerData: job, execArgv: import.meta.url.endsWith('.ts') ? ['--import', 'tsx'] : [] });
    let received = false;
    worker.once('message', result => { received = true; resolve(result as ReturnType<typeof calculateMotionJob>); });
    worker.once('error', reject);
    worker.once('exit', code => { if (code !== 0 || !received) reject(new Error('Motion analysis worker exited without a result.')); });
  });
}

/** Every adjacent pair is evaluated, including chunk boundaries; no prefix-only probe. */
export async function analyzeMotion(bytes: Buffer, onProgress?: (completed: number, total: number) => Promise<void>, concurrency = Math.min(4, availableParallelism())): Promise<MotionAnalysis> {
  const start = performance.now(), metadata = inspectGif(bytes), count = metadata.frameCount;
  const display = squarePixelSize(metadata.width, metadata.height, metadata.pixelAspectRatio);
  const factor = Math.min(1, 96 / display.width, 96 / display.height);
  const width = Math.max(1, Math.round(display.width * factor)), height = Math.max(1, Math.round(display.height * factor));
  const { data, info } = await sharp(bytes, { animated: true, failOn: 'warning' }).resize(width, height, { fit: 'fill' })
    .flatten({ background: 'white' }).toColourspace('srgb').removeAlpha().raw().toBuffer({ resolveWithObject: true });
  if (info.width !== width || info.channels !== 3 || data.length !== width * height * count * 3) throw new Error('Motion thumbnails do not cover all GIF frames.');
  const shared = new SharedArrayBuffer(data.length); new Uint8Array(shared).set(data);
  const workers = Math.max(1, Math.min(Math.floor(concurrency), Math.max(1, count - 1)));
  const scores = Array<number>(count).fill(0), seen = new Uint8Array(count);
  let complete = 0;
  await Promise.all(Array.from({ length: workers }, async (_, index) => {
    const from = 1 + Math.floor((count - 1) * index / workers), to = 1 + Math.floor((count - 1) * (index + 1) / workers);
    if (from === to) return;
    const result = await runWorker({ kind: 'pairs', data: shared, width, height, start: from, end: to });
    if (!result.scores) throw new Error('Invalid pair analysis result.');
    for (let i = from; i < to; i++) { scores[i] = result.scores[i - from]!; seen[i] = seen[i]! + 1; }
    complete += to - from; await onProgress?.(complete, count - 1);
  }));
  if (complete !== count - 1 || seen.slice(1).some(n => n !== 1)) throw new Error('Incomplete or duplicate timeline coverage.');
  const delays = metadata.frames.map(f => f.delayMs), starts: number[] = [];
  let elapsed = 0; for (const delay of delays) { starts.push(elapsed); elapsed += delay; }
  const windowMs = Math.max(250, Math.ceil(metadata.durationMs / 64 / 10) * 10);
  const windows = Array.from({ length: Math.max(1, Math.ceil(metadata.durationMs / windowMs)) }, (_, i) => ({ startMs: i * windowMs,
    endMs: Math.min(metadata.durationMs, (i + 1) * windowMs), motion: 0, peakFrame: 0, frameCount: 0 }));
  for (let i = 0; i < count; i++) { const w = windows[Math.min(windows.length - 1, Math.floor(starts[i]! / windowMs))]!;
    w.motion += scores[i]!; w.frameCount++; if (scores[i]! > scores[w.peakFrame]!) w.peakFrame = i; }
  const specifications = [ ['gentle', '保守保真', 0.025], ['balanced', '均衡推荐', 0.055], ['compact', '优先省张数', 0.11] ] as const;
  const selections = specifications.map(([id, label, threshold]) => {
    const keep = new Set([0]); let accumulated = 0, last = 0;
    for (let i = 1; i < count; i++) {
      accumulated += scores[i]!;
      if (scores[i]! >= 0.28) { keep.add(i - 1); keep.add(i); accumulated = 0; last = i; }
      else if (accumulated >= threshold || (accumulated >= 0.004 && starts[i]! - starts[last]! >= 500)
        || starts[i]! + delays[i]! - starts[last]! > 655350) { keep.add(i); last = i; accumulated = 0; }
    }
    // Anchor every locally active interval, so a long still intro cannot dilute later motion.
    for (const w of windows) if (w.motion >= 0.015) keep.add(w.peakFrame);
    if (accumulated >= 0.004) keep.add(count - 1);
    if (!metadata.durationMs) for (let i = 0; i < count; i++) keep.add(i);
    return { id, label, indices: [...keep].sort((a, b) => a - b) };
  });
  const evaluations: Awaited<ReturnType<typeof runWorker>>[] = [];
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(workers, selections.length) }, async () => {
    for (let i = next++; i < selections.length; i = next++) evaluations[i] = await runWorker({ kind: 'evaluate', data: shared, width, height,
      start: 0, end: count, selection: selections[i]!.indices, delays });
  }));
  const presets = selections.map((selection, i): MotionPreset => {
    const evaluation = evaluations[i]!;
    const sourcePeakFps = Math.max(0, ...delays.filter(d => d > 0).map(d => 1000 / d));
    return { ...selection, frames: selection.indices.length, averageFps: metadata.durationMs ? selection.indices.length * 1000 / metadata.durationMs : 0,
      reduction: 1 - selection.indices.length / count, maxError: evaluation.maxError ?? 0, meanError: evaluation.meanError ?? 0,
      busiestWindowFps: Math.min(sourcePeakFps, Math.max(0, ...windows.map(w => w.endMs > w.startMs
        ? selection.indices.filter(index => starts[index]! >= w.startMs && starts[index]! < w.endMs).length * 1000 / (w.endMs - w.startMs) : 0))) };
  }).filter((p, i, all) => !all.slice(0, i).some(other => other.indices.join(',') === p.indices.join(',')));
  return { version: 1, sourceSha256: sha256(bytes), width: metadata.width, height: metadata.height, frames: count,
    durationMs: metadata.durationMs, thumbnail: { width, height }, workers, adjacentPairsEvaluated: complete,
    elapsedMs: Math.round(performance.now() - start), adjacentScores: scores,
    similarFraction: count > 1 ? scores.slice(1).filter(score => score < 0.008).length / (count - 1) : 1,
    recommendedId: presets.some(p => p.id === 'balanced') ? 'balanced' : 'gentle', windows, presets };
}

export async function writeAnalysisState(directory: string, state: AnalysisState) {
  await fs.mkdir(directory, { recursive: true });
  const tmp = path.join(directory, `analysis-${randomUUID()}.tmp`);
  await fs.writeFile(tmp, JSON.stringify(state)); await fs.rename(tmp, path.join(directory, 'analysis-state.json'));
}
export async function readAnalysisState(directory: string): Promise<AnalysisState | null> {
  try { return JSON.parse(await fs.readFile(path.join(directory, 'analysis-state.json'), 'utf8')) as AnalysisState; }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; }
}
export async function analyzeAsset(directory: string) {
  try {
    await writeAnalysisState(directory, { status: 'analyzing', message: '正在解码完整时间轴缩略帧' });
    const report = await analyzeMotion(await fs.readFile(path.join(directory, 'source.gif')), async (completedPairs, totalPairs) => {
      await writeAnalysisState(directory, { status: 'analyzing', message: '正在并发比较完整时间轴', completedPairs, totalPairs });
    });
    const tmp = path.join(directory, `motion-${randomUUID()}.tmp`);
    await fs.writeFile(tmp, JSON.stringify(report)); await fs.rename(tmp, path.join(directory, 'motion-analysis.json'));
    await writeAnalysisState(directory, { status: 'ready', message: '完整时间轴分析完成', completedPairs: report.adjacentPairsEvaluated,
      totalPairs: report.adjacentPairsEvaluated, analysis: publicMotion(report) });
  } catch (e) { await writeAnalysisState(directory, { status: 'failed', message: '本地分析失败，仍可手动设置采样', error: e instanceof Error ? e.message : String(e) }); }
}
