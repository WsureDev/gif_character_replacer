import path from 'node:path';
import fs from 'node:fs/promises';
import { prepareSampledAnimation, resizeFinalAnimation } from './sampling.js';
import { prepareAdaptivePlans } from './adaptive-layout.js';
import { readAiPlan } from './ai-plan.js';
import { runImageEdit } from './ai-run.js';
import { recoverImageEdit } from './ai-recover.js';
import { assembleAiBatches } from './ai-assemble.js';
import { readAiConfig, type AiConfig } from './ai-config.js';
import { writeJson } from './manifests.js';
import { draftFingerprint, readTask, writeTask, taskDir, providerIdentity, assetDir, taskActionSchema, type BatchTask } from './lab-store.js';
import { inspectBatch, unusedPath, verifiedFrames } from './batch-state.js';
import { ImageQueue, QueueCancelled, workerImageGate, type ImageGate } from './image-queue.js';
import type { MotionAnalysis } from './motion-analysis.js';
import { sha256 } from './pixels.js';
import { prepareDedup, restoreDedup } from './frame-dedup.js';
import { approvedFrame } from './anchor.js';

export async function prepareDraft(root: string, id: string) {
  const task = await readTask(root, id), dir = taskDir(root, id), settings = task.settings;
  task.progress.message = '正在采样分辨率与帧率';
  await writeTask(root, task);
  let selectedIndices: number[] | undefined;
  if (settings.smartPreset) {
    let analysis: MotionAnalysis;
    try {
      const frozen = path.join(dir, 'frozen-motion-analysis.json');
      const file = await fs.access(frozen).then(() => frozen, () => path.join(assetDir(root, task.gifAsset), 'motion-analysis.json'));
      analysis = JSON.parse(await fs.readFile(file, 'utf8')) as MotionAnalysis;
    }
    catch { throw new Error('请等待完整时间轴分析完成后选择智能抽帧。'); }
    if (analysis.sourceSha256 !== sha256(await fs.readFile(path.join(dir, 'input.gif')))) throw new Error('Motion analysis belongs to a different GIF.');
    selectedIndices = analysis.presets.find(p => p.id === settings.smartPreset)?.indices;
    if (!selectedIndices) throw new Error('该推荐档位已变化，请重新选择。');
    await writeJson(path.join(dir, 'motion-analysis.json'), analysis);
  }
  task.sampling = await prepareSampledAnimation(path.join(dir, 'input.gif'), path.join(dir, 'sampled'), settings.scale, settings.maxFps, settings.frameCount, selectedIndices, settings.anchorTrialFrame);
  const adaptiveOptions = { output: { minWidth: settings.minWidth, maxWidth: settings.maxWidth, minHeight: settings.minHeight, maxHeight: settings.maxHeight },
    minScale: 1, maxFramesPerSheet: settings.maxFramesPerSheet || undefined, gutter: Math.max(16, settings.gutter), margin: Math.max(12, settings.margin) };
  let planningInput = 'sampled/animation.json';
  if (settings.dedupMode && settings.dedupMode !== 'off') {
    task.progress.message = '正在全局匹配相似帧、评估省版阈值并生成还原预览';
    await writeTask(root, task);
    task.dedup = await prepareDedup(path.join(dir, planningInput), path.join(dir, 'sampled/dedup'),
      settings.dedupMode === 'exact' ? 100 : settings.dedupMode === 'custom' ? settings.dedupSimilarity ?? 99.5 : undefined, adaptiveOptions);
    planningInput = 'sampled/dedup/animation.json';
  }
  task.progress.message = '正在计算容量并生成拼版预览';
  await approvedFrame(root, task);
  await writeTask(root, task);
  const plans = await prepareAdaptivePlans({ input: path.join(dir, planningInput),
    reference: task.referenceAssets.map((_, i) => path.join(dir, 'references', `reference-${i + 1}.png`)),
    out: path.join(dir, 'plans'), output: { minWidth: settings.minWidth, maxWidth: settings.maxWidth,
      minHeight: settings.minHeight, maxHeight: settings.maxHeight }, minScale: 1,
    maxFramesPerSheet: settings.maxFramesPerSheet || undefined, gutter: settings.gutter, margin: settings.margin,
    subject: settings.subject, characterNotes: settings.characterNotes, extraPrompt: settings.extraPrompt, registrationMarkers: true, appearanceReference: settings.anchorSourceFrame !== undefined });
  task.sheets = [];
  for (const [index, entry] of plans.plans.entries()) {
    const plan = await readAiPlan(path.join(dir, 'plans', entry.directory, 'plan.json'));
    task.sheets.push({ index, directory: entry.directory, startFrame: entry.frameStart, frames: entry.frameCount,
      columns: plan.layout.columns, rows: plan.layout.rows, width: plan.layout.width, height: plan.layout.height,
      cellWidth: plan.layout.cells[0]!.width, cellHeight: plan.layout.cells[0]!.height, status: 'pending',
      registrationMarkers: !!plan.fiducials, gutter: plan.layout.gutter });
  }
  task.draftHash = await draftFingerprint(dir, task.settings, task.provider);
  task.status = 'draft';
  task.progress = { message: '草稿就绪，请审核拼版后提交', completed: 0, total: task.sheets.length };
  await writeTask(root, task);
  return task;
}

/** Submission validates the exact reviewed draft; the caller serializes this transition. */
export async function approveDraft(root: string, id: string, hash: string, config: AiConfig) {
  const task = await readTask(root, id);
  if (!task.draftHash || hash !== task.draftHash) throw new Error('草稿版本不一致，请重新打开并审核。');
  if (['queued', 'running', 'completed'].includes(task.status)) return { task, enqueued: false };
  if (task.status !== 'draft') throw new Error('只有准备完成的草稿可以提交。');
  if (task.settings.anchorMode === 'frame') throw new Error('请先选帧试生成并确认效果，然后提交带基准图的新草稿。');
  if (task.provider?.signature !== providerIdentity(config).signature) throw new Error('服务端模型或接口配置已变化，请重新生成草稿。');
  if (await draftFingerprint(taskDir(root, id), task.settings, task.provider) !== hash) throw new Error('草稿内容已变化，请重新生成预览后提交。');
  task.status = 'queued'; task.submittedAt = new Date().toISOString();
  task.progress.message = '已提交，等待执行';
  await writeTask(root, task);
  return { task, enqueued: true };
}

export async function approveTaskAction(root: string, id: string, input: unknown, config?: AiConfig) {
  const action = taskActionSchema.parse(input), task = await readTask(root, id), dir = taskDir(root, id);
  if (!task.submittedAt || !task.draftHash || action.draftHash !== task.draftHash) throw new Error('请先审核并提交这个草稿。');
  if (task.actionHistory?.some(a => a.operationId === action.operationId)) return { task, enqueued: false };
  if (['preparing', 'queued', 'running', 'draft'].includes(task.status)) throw new Error('任务正在处理中，请等待后再重试。');
  if (!task.sheets?.length || (action.kind === 'batch' && !task.sheets.some(s => s.index === action.sheetIndex))) throw new Error('找不到该版任务。');
  if (await draftFingerprint(dir, task.settings, task.provider) !== task.draftHash) throw new Error('已审核输入发生变化，请重新生成草稿。');
  let needsGeneration = action.kind === 'batch' && action.mode === 'generate';
  for (const sheet of task.sheets) {
    if (action.kind === 'batch' && sheet.index !== action.sheetIndex) continue;
    const info = await inspectBatch(dir, task, sheet);
    if (action.mode === 'recover' && !info.hasOutput) throw new Error('这一版还没有返回图，无法本地重切。');
    if (action.kind === 'continue' && !info.hasOutput && info.hasAttempt) {
      throw new Error(`第 ${sheet.index + 1} 版已有请求记录但没有返回图，请在该版手动选择“重试生图”，以免重复发送。`);
    }
    if (action.kind === 'continue' && !info.hasOutput) needsGeneration = true;
  }
  if (needsGeneration && !config) throw new Error('请先选择一个可用的生图 provider。');
  // A manual action explicitly uses the currently configured provider. Frozen image
  // inputs keep their original review hash; this execution's provider is audited separately.
  if (needsGeneration) task.executionProvider = providerIdentity(config!);
  task.executionAction = action;
  task.actionHistory = [...(task.actionHistory ?? []), { ...action, requestedAt: new Date().toISOString(), ...(needsGeneration ? { provider: task.executionProvider } : {}) }];
  task.status = 'queued'; delete task.error;
  task.progress.message = action.kind === 'continue' ? '已排队：复用已有输出，继续剩余任务'
    : `已排队：第 ${action.sheetIndex! + 1} 版${action.mode === 'recover' ? '本地重切，不生图' : '重新生图 1 张'}`;
  await writeTask(root, task);
  return { task, enqueued: true };
}

export async function executeTask(root: string, id: string, config: AiConfig | undefined,
  edit: typeof runImageEdit = runImageEdit, imageGate: ImageGate = new ImageQueue(2), recover: typeof recoverImageEdit = recoverImageEdit) {
  const task = await readTask(root, id), dir = taskDir(root, id);
  if (task.status !== 'queued' || !task.submittedAt || !task.draftHash || !task.sheets?.length) throw new Error('任务尚未提交。');
  if (task.settings.anchorMode === 'frame') throw new Error('基准帧实验需要先确认试生成效果。');
  if (await draftFingerprint(dir, task.settings, task.provider) !== task.draftHash) throw new Error('已审核草稿发生变化，任务未发送。');
  const action = task.executionAction, generated = new Set<number>();
  task.status = 'running';
  delete task.error;
  await writeTask(root, task);
  let firstError: unknown;
  async function processSheet(sheet: BatchTask) {
    const plan = `plans/${sheet.directory}/plan.json`;
    let info = await inspectBatch(dir, task, sheet);
    const regenerate = action?.kind === 'batch' && action.mode === 'generate';
    const forceRecovery = action?.kind === 'batch' && action.mode === 'recover';
    delete sheet.error; delete sheet.failureStage;
    if (regenerate || !info.hasOutput) {
      if (firstError) throw new QueueCancelled();
      if (forceRecovery) throw new Error('该版没有可重切的返回图。');
      if (!regenerate && info.hasAttempt) throw new Error(`第 ${sheet.index + 1} 版已有请求记录，未自动重发；请手动选择重试生图。`);
      if (!config || (task.executionProvider ?? task.provider)?.signature !== providerIdentity(config).signature) throw new Error('接口配置在排队后发生变化，未发送新请求；请重新选择继续或重试。');
      sheet.status = 'queued';
      task.progress.message = `第 ${sheet.index + 1} 版等待生图名额`;
      await writeTask(root, task);
      const release = await imageGate.acquire(task.id, sheet.index);
      try {
        if (firstError) throw new QueueCancelled();
        if (!sheet.generationAttempts) sheet.generationAttempts = info.hasAttempt ? [{ directory: info.editDirectory, startedAt: task.submittedAt! }] : [];
        const output = await unusedPath(dir, `edit-${sheet.index}`);
        sheet.editDirectory = output; delete sheet.framesDirectory; delete sheet.processingDirectory;
        sheet.generationAttempts.push({ directory: output, startedAt: new Date().toISOString(), operationId: action?.operationId, provider: providerIdentity(config) });
        sheet.status = 'requesting';
        task.progress.completed = task.sheets!.filter(s => s.status === 'done').length;
        task.progress.message = `正在生成第 ${sheet.index + 1} / ${task.sheets!.length} 张（${sheet.frames} 帧）`;
        await writeTask(root, task);
        const result = await edit(path.join(dir, plan), path.join(dir, output), config);
        generated.add(sheet.index); sheet.outputFile = `${output}/edited-sheet.png`;
        if (result.previews) sheet.framesDirectory = `${output}/frames`;
      } catch (error) {
        // Cancel this task's waiting requests before releasing a failed API slot.
        if (!(error instanceof QueueCancelled)) { firstError ??= error ?? new Error('Image request failed'); imageGate.cancelPending(task.id); }
        throw error;
      } finally { release(); }
      info = await inspectBatch(dir, task, sheet);
    }
    sheet.outputFile = info.currentOutput;
    let frames = forceRecovery ? undefined : await verifiedFrames(dir, task, sheet);
    if (!frames) {
      sheet.status = 'splitting';
      task.progress.completed = task.sheets!.filter(s => s.status === 'done').length;
      sheet.processingAttempts = (sheet.processingAttempts ?? 0) + 1;
      const recovered = await unusedPath(dir, `recovered-${sheet.index}`);
      sheet.processingDirectory = recovered;
      task.progress.message = `正在切第 ${sheet.index + 1} 版，复用已返回图片`;
      await writeTask(root, task);
      await recover(path.join(dir, plan), path.join(dir, info.currentOutput), path.join(dir, recovered));
      frames = `${recovered}/frames`;
    }
    sheet.framesDirectory = frames; sheet.status = 'done';
    task.progress.completed = task.sheets!.filter(s => s.status === 'done').length;
    await writeTask(root, task);
  }
  const targets = task.sheets.filter(s => action?.kind !== 'batch' || s.index === action.sheetIndex);
  const known = await Promise.all(targets.map(s => inspectBatch(dir, task, s)));
  // Validate/recover saved images before spending on unsubmitted batches.
  const existing = targets.filter((_, i) => known[i]!.hasOutput && !(action?.kind === 'batch' && action.mode === 'generate'));
  const fresh = targets.filter(s => !existing.includes(s));
  for (const group of [existing, fresh]) {
  await Promise.allSettled(group.map(async sheet => {
    try { await processSheet(sheet); }
    catch (error) {
      if (error instanceof QueueCancelled) { if (sheet.status === 'queued') sheet.status = 'pending'; }
      else {
        firstError ??= error ?? new Error('Unknown batch processing failure'); imageGate.cancelPending(task.id);
        sheet.failureStage = sheet.status === 'splitting' ? 'processing' : 'generation';
        sheet.status = 'failed';
        const message = error instanceof Error ? error.message : String(error);
        sheet.error = (config ? message.split(config.OPENAI_API_KEY).join('[REDACTED]') : message).slice(0, 1500);
        task.progress.message = `第 ${sheet.index + 1} 版失败，等待已发出的请求结束；尚未开始的请求已取消排队`;
      }
      task.progress.completed = task.sheets!.filter(s => s.status === 'done').length;
      await writeTask(root, task);
    }
  }));
  if (firstError) throw firstError;
  }
  if (task.sheets.some(s => s.status !== 'done')) {
    task.status = 'waiting'; task.progress.message = `已完成 ${task.progress.completed}/${task.sheets.length} 版，可继续剩余任务`;
    delete task.executionAction;
    await writeTask(root, task); return task;
  }
  task.progress.message = '全部版图已切帧，正在合成 GIF';
  await writeTask(root, task);
  const batches = [];
  for (const sheet of task.sheets) {
    const frames = await verifiedFrames(dir, task, sheet);
    if (!frames) throw new Error(`第 ${sheet.index + 1} 版的处理结果不完整，请重试切图。`);
    batches.push({ id: sheet.directory, plan: `plans/${sheet.directory}/plan.json`, frames, origin: generated.has(sheet.index) ? 'generated' : 'reused' });
  }
  const bundleFile = await unusedPath(dir, 'bundle', '.json'), finalDirectory = await unusedPath(dir, 'final');
  const deduplicated = !!task.settings.dedupMode && task.settings.dedupMode !== 'off';
  const anchor = await approvedFrame(root, task);
  await writeJson(path.join(dir, bundleFile), { version: 1, source: deduplicated ? 'sampled/dedup/animation.json' : 'sampled/animation.json', batches,
    ...(anchor ? { approvedFrame: anchor } : {}) });
  const representativeDirectory = deduplicated ? await unusedPath(dir, 'representative-final') : finalDirectory;
  let final = await assembleAiBatches(path.join(dir, bundleFile), path.join(dir, representativeDirectory));
  if (deduplicated) {
    task.progress.message = '代表帧已完成，正在按映射还原完整时间轴'; await writeTask(root, task);
    const restored = await restoreDedup(path.join(dir, 'sampled/animation.json'), path.join(dir, 'sampled/dedup/animation.json'),
      path.join(dir, representativeDirectory, 'animation.json'), path.join(dir, 'sampled/dedup/mapping.json'), path.join(dir, finalDirectory));
    final = { ...final, ...restored };
  }
  const sample = task.sampling!;
  let file = `${finalDirectory}/edited.gif`, bytes = final.outputBytes, width = sample.sampled.width, height = sample.sampled.height;
  if (task.settings.outputSize === 'original' && (width !== sample.original.width || height !== sample.original.height)) {
    width = sample.original.width; height = sample.original.height;
    const resizedDirectory = await unusedPath(dir, 'final-original');
    const resized = await resizeFinalAnimation(path.join(dir, finalDirectory, 'animation.json'), path.join(dir, resizedDirectory), width, height);
    file = `${resizedDirectory}/edited.gif`; bytes = resized.bytes;
  }
  if (task.result) task.resultHistory = [...(task.resultHistory ?? []), task.result];
  task.bundleFile = bundleFile;
  task.result = { file, bytes, width, height, frames: final.frameCount, durationMs: final.durationMs };
  delete task.executionAction;
  task.status = 'completed'; task.progress.message = '完成，可以预览和下载 GIF';
  await writeTask(root, task);
  return task;
}

export async function failTask(root: string, id: string, error: unknown, key?: string) {
  const task = await readTask(root, id);
  task.status = 'failed';
  const message = error instanceof Error ? error.message : String(error);
  task.error = (key ? message.split(key).join('[REDACTED]') : message).slice(0, 1500);
  const sheet = task.sheets?.find(s => ['requesting', 'splitting'].includes(s.status));
  if (sheet) { sheet.failureStage = sheet.status === 'requesting' ? 'generation' : 'processing'; sheet.status = 'failed'; sheet.error = task.error; }
  task.progress.completed = task.sheets?.filter(s => s.status === 'done').length ?? 0;
  task.progress.message = '处理停止，已有图片已保存；可手动重试对应版或继续剩余任务';
  await writeTask(root, task);
}

export async function runJob(mode: string, root: string, id: string, envFile: string, suppliedConfig?: AiConfig | null) {
  let config: AiConfig | undefined;
  const gate = workerImageGate();
  try {
    if (mode === 'prepare') await prepareDraft(root, id);
    else {
      if (suppliedConfig !== undefined) config = suppliedConfig ?? undefined;
      else try { config = await readAiConfig(envFile); } catch { /* CLI compatibility; web workers always receive an explicit config or null. */ }
      await executeTask(root, id, config, runImageEdit, gate);
    }
  } catch (error) { await failTask(root, id, error, config?.OPENAI_API_KEY); }
  finally { gate.close?.(); }
}
