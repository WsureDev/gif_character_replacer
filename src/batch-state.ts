import fs from 'node:fs/promises';
import path from 'node:path';
import { taskDir, readTask, type Task, type BatchTask } from './lab-store.js';
import { trialImage } from './anchor.js';
import { sha256 } from './pixels.js';

export async function exists(file: string) {
  try { await fs.access(file); return true; } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false; throw e; }
}
async function json<T>(file: string): Promise<T | null> {
  try { return JSON.parse(await fs.readFile(file, 'utf8')) as T; }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT' || e instanceof SyntaxError) return null; throw e; }
}
/** Reserve a fresh name for every retry; existing billable requests and outputs stay intact. */
export async function unusedPath(directory: string, base: string, extension = '') {
  for (let revision = 1; ; revision++) {
    const relative = `${base}${revision === 1 ? '' : `-v${revision}`}${extension}`;
    if (!await exists(path.join(directory, relative))) return relative;
  }
}
export async function inspectBatch(directory: string, task: Task, sheet: BatchTask) {
  const editDirectory = sheet.editDirectory ?? `edit-${sheet.index}`;
  const currentOutput = `${editDirectory}/edited-sheet.png`;
  const hasOutput = await exists(path.join(directory, currentOutput));
  const hasAttempt = await exists(path.join(directory, editDirectory));
  const result = await json<{ status: number; elapsedMs: number; previews?: { frames: number }; validation?: { actualSize: string } }>(path.join(directory, editDirectory, 'result.json'));
  const state = await json<{ state: string; status?: number; message?: string; elapsedMs?: number }>(path.join(directory, editDirectory, 'status.json'));
  const displayOutput = hasOutput ? currentOutput : sheet.outputFile && await exists(path.join(directory, sheet.outputFile)) ? sheet.outputFile : undefined;
  let framesDirectory: string | undefined;
  const bundleFile = task.bundleFile ?? (task.result ? path.join(path.dirname(path.dirname(task.result.file)), 'bundle.json') : 'bundle.json');
  const bundle = await json<{ batches: { id: string; frames: string }[] }>(path.join(directory, bundleFile));
  const bundled = bundle?.batches.find(b => b.id === sheet.directory);
  const candidates = [sheet.framesDirectory,
    bundled ? path.relative(directory, path.resolve(directory, path.dirname(bundleFile), bundled.frames)) : undefined,
    result?.previews ? `${editDirectory}/frames` : undefined, `recovered-${sheet.index}/frames`];
  for (const candidate of candidates) {
    if (!candidate || !await exists(path.join(directory, candidate))) continue;
    const names = new Set(await fs.readdir(path.join(directory, candidate)));
    if (Array.from({ length: sheet.frames }, (_, i) => `frame-${String(i).padStart(4, '0')}.png`).every(f => names.has(f))) { framesDirectory = candidate; break; }
  }
  return { editDirectory, currentOutput, hasOutput, hasAttempt, displayOutput, framesDirectory,
    requestState: state?.state, httpStatus: result?.status ?? state?.status, elapsedMs: result?.elapsedMs ?? state?.elapsedMs, actualSize: result?.validation?.actualSize,
    uncertain: hasAttempt && !hasOutput && (!state || ['unknown', 'in-flight'].includes(state.state) || (state.status ?? 0) >= 500) };
}
export async function verifiedFrames(directory: string, task: Task, sheet: BatchTask) {
  const info = await inspectBatch(directory, task, sheet);
  if (!info.hasOutput || !info.framesDirectory) return undefined;
  if (info.framesDirectory === `${info.editDirectory}/frames`) {
    const result = await json<{ previews?: { frames: number } }>(path.join(directory, info.editDirectory, 'result.json'));
    if (result?.previews?.frames === sheet.frames) return info.framesDirectory;
    return undefined;
  }
  const recovered = path.dirname(info.framesDirectory);
  const registration = await json<{ outputSha256: string; sourcePlanSha256: string }>(path.join(directory, recovered, 'registration.json'));
  const preview = await json<{ frames: number }>(path.join(directory, recovered, 'preview-metadata.json'));
  if (!registration || preview?.frames !== sheet.frames) return undefined;
  const [output, plan] = await Promise.all([fs.readFile(path.join(directory, info.currentOutput)), fs.readFile(path.join(directory, 'plans', sheet.directory, 'plan.json'))]);
  return registration.outputSha256 === sha256(output) && registration.sourcePlanSha256 === sha256(plan) ? info.framesDirectory : undefined;
}

/** Include saved outputs even when processing failed, including tasks created before retries existed. */
export async function describeTask(root: string, task: Task) {
  const directory = taskDir(root, task.id);
  const sheets = await Promise.all((task.sheets ?? []).map(async sheet => {
    const info = await inspectBatch(directory, task, sheet);
    const failed = ['failed', 'interrupted'].includes(task.status) && ['requesting', 'splitting', 'failed'].includes(sheet.status);
    return { ...sheet, status: failed ? 'failed' : sheet.status, outputFile: info.displayOutput, canRecover: info.hasOutput,
      hasAttempt: info.hasAttempt, uncertain: info.uncertain, httpStatus: info.httpStatus, elapsedMs: info.elapsedMs, actualSize: info.actualSize,
      error: sheet.error ?? (failed ? task.error : undefined),
      failureStage: sheet.failureStage ?? (failed ? info.hasOutput ? 'processing' : 'generation' : undefined),
      generationCount: sheet.generationAttempts?.length ?? (info.hasAttempt ? 1 : 0),
      outputIsPrevious: !!info.displayOutput && !info.hasOutput };
  }));
  const anchorPreviews = await Promise.all((task.anchorTrials ?? []).map(async entry => {
    const trial = await readTask(root, entry.id), image = await trialImage(root, trial);
    return { id: trial.id, frameIndex: entry.frameIndex, status: trial.status, error: trial.error,
      imageFile: image?.file, imageSha256: image?.sha256 };
  }));
  return { ...task, sheets, anchorPreviews, resumeInfo: { existingImages: sheets.filter(s => s.canRecover).length,
    newImages: sheets.filter(s => !s.canRecover && !s.hasAttempt).length,
    manualGenerationRequired: sheets.filter(s => !s.canRecover && s.hasAttempt).length,
    completed: sheets.filter(s => s.status === 'done').length } };
}
