import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { z } from 'zod';
import { readAnimation, createOutputDirectory, writeJson } from './manifests.js';
import { sha256 } from './pixels.js';
import { assemble } from './pipeline.js';
import { planAdaptiveBatches, type AdaptiveOptions } from './adaptive-layout.js';

const mappingSchema = z.object({
  version: z.literal(1), sourceManifestSha256: z.string(), representativeManifestSha256: z.string(),
  representatives: z.array(z.number().int().nonnegative()).min(1),
  mapping: z.array(z.number().int().nonnegative()).min(1),
});
export interface DedupSummary {
  sourceFrames: number; uniqueFrames: number; reusedFrames: number; exactReuses: number;
  similarity: number; recommendedSimilarity: number; baselineSheets: number; sheets: number;
  maxError: number; meanError: number; elapsedMs: number;
  examples: { frame: number; representative: number; similarity: number }[];
  candidates: { similarity: number; uniqueFrames: number; sheets: number; maxError: number; meanError: number }[];
}

/** Full-resolution differences: local blocks protect small features; a peak guard rejects large pixel changes. */
export function dedupDifference(a: Uint8Array, b: Uint8Array, width: number, height: number) {
  if (a.length !== width * height * 4 || b.length !== a.length) throw new Error('Invalid dedup frame size.');
  const sums = new Float64Array(256), counts = new Uint32Array(256);
  let total = 0, changed = 0, peak = 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const p = (y * width + x) * 4;
    if (a[p + 3] !== 255 || b[p + 3] !== 255) throw new Error('Dedup requires opaque frames.');
    const dr = Math.abs(a[p]! - b[p]!), dg = Math.abs(a[p + 1]! - b[p + 1]!), db = Math.abs(a[p + 2]! - b[p + 2]!);
    const error = (dr + dg + db) / 765;
    peak = Math.max(peak, dr / 255, dg / 255, db / 255);
    total += error; if (Math.max(dr, dg, db) > 12) changed++;
    const block = Math.min(15, Math.floor(y * 16 / height)) * 16 + Math.min(15, Math.floor(x * 16 / width));
    sums[block]! += error; counts[block]!++;
  }
  let local = 0;
  for (let i = 0; i < 256; i++) if (counts[i]) local = Math.max(local, sums[i]! / counts[i]!);
  return { error: Math.max(total / (width * height), local, changed / (width * height) * 0.5), peak };
}

export async function prepareDedup(input: string, out: string, requested: number | undefined, options: AdaptiveOptions): Promise<DedupSummary> {
  const started = Date.now(), sourceBytes = await fs.readFile(input), source = await readAnimation(input);
  if (requested !== undefined && (!Number.isFinite(requested) || requested < 98 || requested > 100)) throw new Error('去重相似度范围为 98–100。');
  const frames: Buffer[] = [], descriptors: Buffer[] = [];
  for (const frame of source.frames) {
    const png = await fs.readFile(path.join(path.dirname(input), frame.file));
    const rgba = await sharp(png).ensureAlpha().raw().toBuffer();
    if (sha256(rgba) !== frame.rgbaSha256) throw new Error('Dedup source hash mismatch.');
    frames.push(rgba);
    descriptors.push(await sharp(png).resize(8, 8, { fit: 'fill' }).removeAlpha().raw().toBuffer());
  }
  const cache = new Map<string, ReturnType<typeof dedupDifference>>();
  function cluster(similarity: number) {
    const tolerance = (100 - similarity) / 100, representatives: number[] = [], mapping: number[] = [], errors: number[] = [];
    const exact = new Map<string, number>(); let exactReuses = 0;
    for (const [i, frame] of source.frames.entries()) {
      const duplicate = exact.get(frame.rgbaSha256);
      if (duplicate !== undefined) { mapping.push(duplicate); errors.push(0); exactReuses++; continue; }
      let match: number | undefined, bestError = Infinity;
      if (tolerance > 0) {
        // Search the entire history of representatives, then verify the nearest candidates at full resolution.
        const nearest: { index: number; distance: number }[] = [];
        for (const [index, representative] of representatives.entries()) {
          const a = descriptors[i]!, b = descriptors[representative]!;
          let distance = 0; for (let k = 0; k < a.length; k++) distance += Math.abs(a[k]! - b[k]!);
          distance /= a.length * 255;
          if (distance <= tolerance + 1 / 255) nearest.push({ index, distance });
        }
        nearest.sort((a, b) => a.distance - b.distance || a.index - b.index);
        for (const candidate of nearest.slice(0, 8)) {
          const representative = representatives[candidate.index]!, key = `${i}:${representative}`;
          let difference = cache.get(key);
          if (!difference) {
            difference = dedupDifference(frames[i]!, frames[representative]!, source.width, source.height);
            if (cache.size < 100000) cache.set(key, difference);
          }
          if (difference.peak <= 0.15 && difference.error <= tolerance + 1e-12 && difference.error < bestError) {
            match = candidate.index; bestError = difference.error;
          }
        }
      }
      if (match === undefined) { match = representatives.length; representatives.push(i); exact.set(frame.rgbaSha256, match); bestError = 0; }
      // Only representative hashes enter the exact lookup: no transitive approximate matches.
      mapping.push(match); errors.push(bestError);
    }
    const totalDuration = source.frames.reduce((sum, f) => sum + f.delayMs, 0);
    return { similarity, representatives, mapping, errors, exactReuses,
      uniqueFrames: representatives.length, sheets: planAdaptiveBatches(source.width, source.height, representatives.length, options).outputImageCount,
      maxError: errors.reduce((a, b) => Math.max(a, b), 0),
      meanError: errors.reduce((sum, e, i) => sum + e * (totalDuration ? source.frames[i]!.delayMs : 1), 0) / (totalDuration || errors.length) };
  }
  const trials = [100, 99.75, 99.5, 99, 98.5, 98].map(cluster);
  // Recommend the strictest point achieving the best sheet count within the conservative >=99% band.
  const safe = trials.filter(c => c.similarity >= 99 && c.meanError <= 0.003);
  const recommended = safe.reduce((a, b) => b.sheets < a.sheets ? b : a);
  const selected = requested === undefined ? recommended : trials.find(c => c.similarity === requested) ?? cluster(requested);
  await createOutputDirectory(out);
  const unique = structuredClone(source);
  unique.frames = selected.representatives.map((sourceIndex, index) => ({ ...source.frames[sourceIndex]!, index, file: `frame-${String(index).padStart(6, '0')}.png` }));
  for (const [i, sourceIndex] of selected.representatives.entries()) await fs.copyFile(path.join(path.dirname(input), source.frames[sourceIndex]!.file), path.join(out, unique.frames[i]!.file));
  await writeJson(path.join(out, 'animation.json'), unique);
  await writeJson(path.join(out, 'mapping.json'), { version: 1, sourceManifestSha256: sha256(sourceBytes),
    representativeManifestSha256: sha256(await fs.readFile(path.join(out, 'animation.json'))),
    representatives: selected.representatives, mapping: selected.mapping });
  const summary: DedupSummary = { sourceFrames: source.frames.length, uniqueFrames: unique.frames.length,
    reusedFrames: source.frames.length - unique.frames.length, exactReuses: selected.exactReuses,
    similarity: selected.similarity, recommendedSimilarity: recommended.similarity,
    baselineSheets: planAdaptiveBatches(source.width, source.height, source.frames.length, options).outputImageCount,
    sheets: selected.sheets, maxError: selected.maxError, meanError: selected.meanError, elapsedMs: Date.now() - started,
    examples: selected.mapping.map((representative, frame) => ({ frame, representative: selected.representatives[representative]!, similarity: 100 * (1 - selected.errors[frame]!) }))
      .filter(e => e.frame !== e.representative).sort((a, b) => a.similarity - b.similarity || a.frame - b.frame).slice(0, 4),
    candidates: trials.map(({ similarity, uniqueFrames, sheets, maxError, meanError }) => ({ similarity, uniqueFrames, sheets, maxError, meanError })) };
  await writeJson(path.join(out, 'report.json'), { ...summary, algorithm: 'global-nearest8-full-resolution-local16-peakguard-v1', errors: selected.errors });
  await restoreDedup(input, path.join(out, 'animation.json'), path.join(out, 'animation.json'), path.join(out, 'mapping.json'), path.join(out, 'preview'));
  return summary;
}

/** Restore each timeline slot from its edited representative; never fall back to unedited frames. */
export async function restoreDedup(sourceFile: string, representativeFile: string, editedFile: string, mappingFile: string, out: string) {
  const map = mappingSchema.parse(JSON.parse(await fs.readFile(mappingFile, 'utf8')));
  const source = await readAnimation(sourceFile), representatives = await readAnimation(representativeFile), edited = await readAnimation(editedFile);
  if (sha256(await fs.readFile(sourceFile)) !== map.sourceManifestSha256 || sha256(await fs.readFile(representativeFile)) !== map.representativeManifestSha256
    || map.mapping.length !== source.frames.length || map.representatives.length !== representatives.frames.length
    || edited.frames.length !== representatives.frames.length || edited.width !== source.width || edited.height !== source.height
    || edited.loopCount !== source.loopCount || edited.source.sha256 !== source.source.sha256
    || new Set(map.representatives).size !== map.representatives.length
    || map.mapping.some(i => i >= map.representatives.length)) throw new Error('Invalid dedup mapping or edited source.');
  for (const [i, index] of map.representatives.entries()) {
    if (!source.frames[index] || map.mapping[index] !== i || representatives.frames[i]!.rgbaSha256 !== source.frames[index]!.rgbaSha256) throw new Error('Invalid dedup representative.');
  }
  const pngs = await Promise.all(edited.frames.map(async frame => {
    const png = await fs.readFile(path.join(path.dirname(editedFile), frame.file));
    const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    if (info.width !== source.width || info.height !== source.height || sha256(data) !== frame.rgbaSha256 || data.some((v, i) => i % 4 === 3 && v !== 255)) throw new Error('Invalid edited representative pixels.');
    return png;
  }));
  await createOutputDirectory(out);
  const restored = structuredClone(source);
  for (const frame of restored.frames) {
    const representative = map.mapping[frame.index]!;
    frame.file = `frame-${String(frame.index).padStart(6, '0')}.png`;
    frame.rgbaSha256 = edited.frames[representative]!.rgbaSha256;
    await fs.writeFile(path.join(out, frame.file), pngs[representative]!, { flag: 'wx' });
  }
  await writeJson(path.join(out, 'animation.json'), restored);
  await writeJson(path.join(out, 'restoration.json'), { mappingSha256: sha256(await fs.readFile(mappingFile)),
    editedManifestSha256: sha256(await fs.readFile(editedFile)), frames: map.mapping.map((representative, index) => ({ index, representative, sourceRepresentative: map.representatives[representative], delayMs: source.frames[index]!.delayMs })) });
  const encoded = await assemble(path.join(out, 'animation.json'), path.join(out, 'edited.gif'), true);
  return { output: path.join(out, 'edited.gif'), outputBytes: encoded.bytes, frameCount: restored.frames.length, durationMs: restored.frames.reduce((sum, f) => sum + f.delayMs, 0) };
}
