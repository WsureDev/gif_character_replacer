import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { readAnimation, createOutputDirectory, writeJson } from './manifests.js';
import { readAiPlan } from './ai-plan.js';
import { ImageProcessor } from './image-processor.js';
import { sha256, isOpaque } from './pixels.js';
import { assemble } from './pipeline.js';
import type { AnimationManifest } from './types.js';

const bundleSchema = z.object({
  version: z.literal(1), source: z.string().min(1),
  approvedFrame: z.object({ sourceIndex: z.number().int().nonnegative(), file: z.string().min(1), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict().optional(),
  batches: z.array(z.object({
    id: z.string().min(1), plan: z.string().min(1), frames: z.string().min(1),
    origin: z.enum(['generated', 'reused']),
  }).strict()).min(1),
}).strict();

/** Join all original frame indexes exactly once. Never replace missing edited frames with originals. */
export async function assembleAiBatches(bundleFile: string, out: string) {
  const bundle = bundleSchema.parse(JSON.parse(await fs.readFile(bundleFile, 'utf8')));
  const base = path.dirname(path.resolve(bundleFile));
  const source = await readAnimation(path.resolve(base, bundle.source));
  const images = new ImageProcessor();
  const records = new Map<number, { png: Buffer; rgbaSha256: string; batchId: string; origin: string }>();
  const ids = new Set<string>();
  let referenceHashes: string | undefined;
  const batchReports = [];
  for (const batch of bundle.batches) {
    if (ids.has(batch.id)) throw new Error('Duplicate batch ID.');
    ids.add(batch.id);
    const planPath = path.resolve(base, batch.plan);
    const plan = await readAiPlan(planPath);
    if (plan.source.sha256 !== source.source.sha256 || plan.source.width !== source.width
      || plan.source.height !== source.height || plan.source.totalFrames !== source.frames.length
      || plan.source.loopCount !== source.loopCount) throw new Error(`Batch ${batch.id} belongs to a different source animation.`);
    const hashes = JSON.stringify(plan.references.map(r => r.sha256));
    if (referenceHashes !== undefined && hashes !== referenceHashes) throw new Error('Batches use different character references.');
    referenceHashes = hashes;
    for (const [i, frame] of plan.frames.entries()) {
      const original = source.frames[frame.sourceIndex]!;
      if (original.rgbaSha256 !== frame.rgbaSha256 || original.delayMs !== frame.delayMs) throw new Error(`Frame ${frame.sourceIndex}: source hash/timing mismatch.`);
      if (records.has(frame.sourceIndex)) throw new Error(`Duplicate edited frame ${frame.sourceIndex}.`);
      const file = path.resolve(base, batch.frames, `frame-${String(i).padStart(4, '0')}.png`);
      const png = await fs.readFile(file);
      const rgba = await images.readPng(png, source.width, source.height);
      if (!isOpaque(rgba)) throw new Error(`Unexpected transparency in edited frame ${frame.sourceIndex}.`);
      records.set(frame.sourceIndex, { png, rgbaSha256: sha256(rgba), batchId: batch.id, origin: batch.origin });
    }
    batchReports.push({ id: batch.id, origin: batch.origin, firstFrame: plan.frames[0]!.sourceIndex,
      lastFrame: plan.frames.at(-1)!.sourceIndex, frames: plan.frames.length, planSha256: sha256(await fs.readFile(planPath)) });
  }
  const missing = source.frames.filter(f => !records.has(f.index)).map(f => f.index);
  if (missing.length) throw new Error(`Missing edited frames: ${missing.join(', ')}. Refusing a partial full-length GIF.`);
  if (bundle.approvedFrame) {
    const anchor = bundle.approvedFrame, record = records.get(anchor.sourceIndex);
    if (!record) throw new Error('Approved frame is outside the animation.');
    const png = await fs.readFile(path.resolve(base, anchor.file)), rgba = await images.readPng(png, source.width, source.height);
    if (sha256(png) !== anchor.sha256 || !isOpaque(rgba)) throw new Error('Approved frame hash/opacity mismatch.');
    records.set(anchor.sourceIndex, { ...record, png, rgbaSha256: sha256(rgba), origin: 'approved-reference' });
  }
  await createOutputDirectory(out);
  await fs.mkdir(path.join(out, 'frames'));
  const animation: AnimationManifest = structuredClone(source);
  const provenance = [];
  for (const frame of animation.frames) {
    const record = records.get(frame.index)!;
    frame.file = `frames/frame-${String(frame.index).padStart(6, '0')}.png`;
    frame.rgbaSha256 = record.rgbaSha256;
    frame.opaque = true;
    await fs.writeFile(path.join(out, frame.file), record.png, { flag: 'wx' });
    provenance.push({ frameIndex: frame.index, delayMs: frame.delayMs, batchId: record.batchId, origin: record.origin, rgbaSha256: record.rgbaSha256 });
  }
  await writeJson(path.join(out, 'animation.json'), animation);
  const encoded = await assemble(path.join(out, 'animation.json'), path.join(out, 'edited.gif'), true);
  const report = {
    source: source.source, width: source.width, height: source.height, frameCount: source.frames.length,
    durationMs: source.frames.reduce((sum, f) => sum + f.delayMs, 0), loopCount: source.loopCount,
    batches: batchReports, originalFrameCoverage: 'complete, unique and ordered',
    reusedBatches: batchReports.filter(b => b.origin === 'reused').length,
    generatedBatches: batchReports.filter(b => b.origin === 'generated').length,
    checks: { frameCount: true, originalDelays: true, originalLoop: true, opaque: true },
    outputBytes: encoded.bytes, sizeRatio: encoded.bytes / source.source.bytes,
    quantizedFrames: encoded.quantizedFrames.length, pixelChecks: encoded.pixelChecks,
    scope: 'Complete GIF assembly; per-frame character precision and size optimization are deferred.',
  };
  await writeJson(path.join(out, 'assembly-report.json'), report);
  await writeJson(path.join(out, 'frame-provenance.json'), provenance);
  return { output: path.join(out, 'edited.gif'), frameCount: report.frameCount, durationMs: report.durationMs,
    reusedBatches: report.reusedBatches, generatedBatches: report.generatedBatches, outputBytes: report.outputBytes };
}
