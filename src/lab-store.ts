import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { sha256 } from './pixels.js';
import { readAiConfig, type AiConfig } from './ai-config.js';
import type { prepareSampledAnimation } from './sampling.js';
import { inspectGif } from './gif.js';
import { samplingOptions, type SamplingOptions } from './sampling-options.js';
import type { DedupSummary } from './frame-dedup.js';

export const settingsSchema = z.object({
  scale: z.number().positive().max(1).default(1), maxFps: z.number().min(0).default(0),
  frameCount: z.number().int().positive().optional(),
  smartPreset: z.enum(['gentle', 'balanced', 'compact']).optional(),
  dedupMode: z.enum(['off', 'auto', 'exact', 'custom']).optional(),
  dedupSimilarity: z.number().min(98).max(100).optional(),
  anchorMode: z.enum(['off', 'frame']).optional(),
  anchorTrialFrame: z.number().int().nonnegative().optional(),
  anchorSourceFrame: z.number().int().nonnegative().optional(),
  outputSize: z.enum(['sampled', 'original']).default('sampled'),
  minWidth: z.number().int().min(256).max(3840).default(1280), minHeight: z.number().int().min(256).max(3840).default(1280),
  maxWidth: z.number().int().min(256).max(3840).default(1280), maxHeight: z.number().int().min(256).max(3840).default(1280),
  maxFramesPerSheet: z.number().int().min(0).max(10000).default(0),
  gutter: z.number().int().min(4).max(64).default(16), margin: z.number().int().min(4).max(64).default(12),
  subject: z.string().trim().min(1).max(1000).default('the main character'),
  characterNotes: z.string().trim().max(3000).default('参考图只定义角色人设与外观；每帧姿势、神态、表情及动作阶段严格沿用原图。'),
  extraPrompt: z.string().trim().max(5000).default(''),
}).strict().refine(s => s.minWidth <= s.maxWidth && s.minHeight <= s.maxHeight, '输出尺寸下限不能大于上限。');
export const taskInputSchema = z.object({ name: z.string().trim().max(120).default(''), gifAsset: z.string().uuid(),
  referenceAssets: z.array(z.string().uuid()).min(1).max(15), settings: settingsSchema }).strict();
export type Settings = z.infer<typeof settingsSchema>;
export interface Asset { id: string; kind: 'gif' | 'reference'; name: string; file: string; bytes: number;
  width: number; height: number; frames?: number; durationMs?: number; samplingOptions?: SamplingOptions }
export interface Provider { model: string; quality: string; signature: string }
export interface BatchTask { index: number; directory: string; startFrame: number; frames: number; columns: number; rows: number;
  width: number; height: number; cellWidth: number; cellHeight: number; status: string; registrationMarkers?: boolean; gutter?: number;
  editDirectory?: string; framesDirectory?: string; processingDirectory?: string; outputFile?: string;
  error?: string; failureStage?: 'generation' | 'processing'; processingAttempts?: number;
  generationAttempts?: { directory: string; startedAt: string; operationId?: string; provider?: Provider }[] }
export const taskActionSchema = z.object({ operationId: z.string().uuid(), draftHash: z.string().regex(/^[a-f0-9]{64}$/),
  kind: z.enum(['continue', 'batch']), sheetIndex: z.number().int().nonnegative().optional(), mode: z.enum(['recover', 'generate']).optional() }).strict()
  .refine(a => a.kind === 'batch' ? a.sheetIndex !== undefined && a.mode !== undefined : a.sheetIndex === undefined && a.mode === undefined, 'Invalid task action.');
export type TaskAction = z.infer<typeof taskActionSchema>;
export interface TaskResult { file: string; bytes: number; width: number; height: number; frames: number; durationMs: number }
export interface Task extends z.infer<typeof taskInputSchema> {
  id: string; createdAt: string; updatedAt: string;
  status: 'preparing' | 'draft' | 'queued' | 'running' | 'waiting' | 'completed' | 'failed' | 'interrupted';
  progress: { message: string; completed: number; total: number };
  error?: string; draftHash?: string; submittedAt?: string; provider: Provider | null;
  sampling?: Awaited<ReturnType<typeof prepareSampledAnimation>>;
  dedup?: DedupSummary;
  anchorTrials?: { id: string; operationId: string; frameIndex: number }[];
  trialFor?: { taskId: string; frameIndex: number; sourceIndex: number; autoSubmit: boolean };
  guidedFrom?: { taskId: string; trialId: string; imageSha256: string; imageFile: string };
  anchorApprovals?: { operationId: string; trialId: string; taskId: string }[];
  sheets?: BatchTask[];
  result?: TaskResult; resultHistory?: TaskResult[]; bundleFile?: string;
  executionAction?: TaskAction;
  executionProvider?: Provider;
  actionHistory?: (TaskAction & { requestedAt: string; provider?: Provider })[];
}
export function taskDir(root: string, id: string) { return path.join(root, 'tasks', z.string().uuid().parse(id)); }
export function assetDir(root: string, id: string) { return path.join(root, 'assets', z.string().uuid().parse(id)); }
export async function readTask(root: string, id: string): Promise<Task> {
  return JSON.parse(await fs.readFile(path.join(taskDir(root, id), 'task.json'), 'utf8')) as Task;
}
const writes = new Map<string, Promise<void>>();
export async function writeTask(root: string, task: Task) {
  const target = path.join(taskDir(root, task.id), 'task.json');
  const work = (writes.get(target) ?? Promise.resolve()).catch(() => undefined).then(async () => {
    task.updatedAt = new Date().toISOString();
    const temp = `${target}.${randomUUID()}.tmp`;
    await fs.writeFile(temp, JSON.stringify(task, null, 2) + '\n', { flag: 'wx' });
    await fs.rename(temp, target);
  });
  writes.set(target, work);
  try { await work; } finally { if (writes.get(target) === work) writes.delete(target); }
}
export async function readAsset(root: string, id: string): Promise<Asset> {
  const asset = JSON.parse(await fs.readFile(path.join(assetDir(root, id), 'asset.json'), 'utf8')) as Asset;
  // Older uploads are analyzed on read without modifying their files or existing drafts.
  if (asset.kind === 'gif' && !asset.samplingOptions?.pixelAspect) {
    const metadata = inspectGif(await fs.readFile(path.join(assetDir(root, id), asset.file)));
    asset.frames = metadata.frameCount; asset.durationMs = metadata.durationMs;
    asset.samplingOptions = samplingOptions(metadata);
    asset.width = asset.samplingOptions.pixelAspect.width; asset.height = asset.samplingOptions.pixelAspect.height;
  }
  return asset;
}
export function providerIdentity(config: AiConfig): Provider {
  return { model: config.OPENAI_IMAGE_MODEL, quality: config.OPENAI_IMAGE_QUALITY,
    signature: sha256(Buffer.from(JSON.stringify([config.OPENAI_BASE_URL, config.OPENAI_IMAGE_MODEL, config.OPENAI_IMAGE_QUALITY]))) };
}
export async function configuredProvider(envFile: string): Promise<Provider | null> {
  try { return providerIdentity(await readAiConfig(envFile)); } catch { return null; }
}
/** Only frozen draft inputs enter this digest; task progress and generated output do not. */
export async function draftFingerprint(directory: string, settings: Settings, provider: Provider | null) {
  const hashes: [string, string][] = [];
  async function visit(relative: string) {
    const file = path.join(directory, relative);
    if ((await fs.stat(file)).isDirectory()) {
      for (const name of (await fs.readdir(file)).sort()) await visit(path.join(relative, name));
    } else hashes.push([relative, sha256(await fs.readFile(file))]);
  }
  for (const item of ['input.gif', 'references', 'sampled', 'plans']) await visit(item);
  return sha256(Buffer.from(JSON.stringify({ settings, provider, hashes })));
}

export async function createTask(root: string, input: unknown, provider: Provider | null) {
  const values = taskInputSchema.parse(input);
  const gif = await readAsset(root, values.gifAsset);
  if (gif.kind !== 'gif') throw new Error('请选择 GIF 素材。');
  const options = gif.samplingOptions!, { frameCount, maxFps, scale, maxFramesPerSheet } = values.settings;
  if (values.settings.smartPreset && (frameCount !== undefined || maxFps !== 0)) throw new Error('智能抽帧不能同时设置固定帧数或 FPS。');
  if (values.settings.anchorMode === 'frame' && values.referenceAssets.length > 14) throw new Error('基准帧实验最多使用 14 张角色图，需要为效果参考图预留一个位置。');
  if (values.settings.anchorTrialFrame !== undefined && (values.settings.anchorTrialFrame >= options.frames.max || frameCount !== undefined || maxFps || values.settings.smartPreset)) throw new Error('试生成帧编号不合法或与抽帧设置冲突。');
  if (frameCount !== undefined && (frameCount < options.frames.min || frameCount > options.frames.max || maxFps !== 0)) {
    throw new Error(`此 GIF 可保留 ${options.frames.min}–${options.frames.max} 帧；帧数与 FPS 请选择一种采样方式。`);
  }
  if (maxFps > 0 && (maxFps < options.fps.min - 1e-9 || maxFps > options.fps.max + 1e-9 || !options.fps.max)) {
    throw new Error(`此 GIF 的 FPS 可选范围为 ${options.fps.min.toFixed(3)}–${options.fps.max.toFixed(3)}。`);
  }
  if (scale < 1 / options.resolution.maxLongEdge - 1e-12) throw new Error('采样长边不能小于 1 像素。');
  if (maxFramesPerSheet > options.frames.max) throw new Error(`每版帧数上限不能超过此 GIF 的 ${options.frames.max} 帧。`);
  const refs = await Promise.all(values.referenceAssets.map(id => readAsset(root, id)));
  if (refs.some(a => a.kind !== 'reference')) throw new Error('角色参考必须是图片素材。');
  const task: Task = { ...values, name: values.name || gif.name, id: randomUUID(), provider,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), status: 'preparing',
    progress: { message: '等待生成草稿', completed: 0, total: 0 } };
  const dir = taskDir(root, task.id);
  await fs.mkdir(path.join(dir, 'references'), { recursive: true });
  await fs.copyFile(path.join(assetDir(root, gif.id), gif.file), path.join(dir, 'input.gif'));
  for (const [i, ref] of refs.entries()) await fs.copyFile(path.join(assetDir(root, ref.id), ref.file), path.join(dir, 'references', `reference-${i + 1}.png`));
  await writeTask(root, task);
  return task;
}
