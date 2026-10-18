import path from 'node:path';
import { assertImageSize, fitLayout, type AiLayout } from './ai-layout.js';
import { readAnimation, createOutputDirectory, writeJson } from './manifests.js';
import { prepareAiPlan } from './ai-plan.js';

export interface OutputRange { minWidth: number; maxWidth: number; minHeight: number; maxHeight: number; step?: number }
export interface AdaptiveOptions {
  output: OutputRange;
  minScale?: number;
  gutter?: number;
  margin?: number;
  /** Optional operational cap. No 3x3/5x5 limit is imposed by default. */
  maxFramesPerSheet?: number;
}
interface Choice { width: number; height: number; columns: number; rows: number; count: number; scale: number; utilization: number }

export function planAdaptiveBatches(frameWidth: number, frameHeight: number, frameCount: number, options: AdaptiveOptions) {
  const { minWidth, maxWidth, minHeight, maxHeight } = options.output;
  const step = options.output.step ?? 16;
  const minScale = options.minScale ?? 1, gutter = options.gutter ?? 8, margin = options.margin ?? 12;
  const cap = options.maxFramesPerSheet ?? frameCount;
  if (![frameWidth, frameHeight, frameCount, cap].every(n => Number.isSafeInteger(n) && n > 0)
    || frameCount > 10000 || !Number.isFinite(minScale) || minScale <= 0 || minScale > 4
    || ![gutter, margin].every(n => Number.isInteger(n) && n >= 0)
    || ![minWidth, maxWidth, minHeight, maxHeight].every(n => Number.isInteger(n) && n > 0 && n <= 3840)
    || minWidth > maxWidth || minHeight > maxHeight || !Number.isInteger(step) || step < 16 || step % 16 !== 0) {
    throw new Error('Invalid adaptive output range, source dimensions or scale constraints.');
  }
  const minCellWidth = Math.ceil(frameWidth * minScale), minCellHeight = Math.ceil(frameHeight * minScale);
  const canvases: { width: number; height: number; maxColumns: number; maxRows: number }[] = [];
  for (let width = Math.ceil(minWidth / 16) * 16; width <= maxWidth; width += step) {
    for (let height = Math.ceil(minHeight / 16) * 16; height <= maxHeight; height += step) {
      try { assertImageSize(width, height); } catch { continue; }
      const maxColumns = Math.floor((width - 2 * margin + gutter) / (minCellWidth + gutter));
      const maxRows = Math.floor((height - 2 * margin + gutter) / (minCellHeight + gutter));
      if (maxColumns > 0 && maxRows > 0) canvases.push({ width, height, maxColumns, maxRows });
    }
  }
  if (!canvases.length) throw new Error('No frame fits this output range at minScale; enlarge the range or explicitly lower minScale.');
  function choose(remaining: number): Choice {
    let best: Choice | undefined;
    for (const canvas of canvases) {
      const count = Math.min(remaining, cap, canvas.maxColumns * canvas.maxRows);
      if (best && count < best.count) continue;
      const area = canvas.width * canvas.height;
      if (best && count === best.count && area > best.width * best.height) continue;
      for (let columns = Math.ceil(count / canvas.maxRows); columns <= Math.min(count, canvas.maxColumns); columns++) {
        const rows = Math.ceil(count / columns);
        const tileW = Math.floor((canvas.width - 2 * margin - (columns - 1) * gutter) / columns);
        const tileH = Math.floor((canvas.height - 2 * margin - (rows - 1) * gutter) / rows);
        const scale = Math.min(tileW / frameWidth, tileH / frameHeight);
        if (scale + 1e-9 < minScale) continue;
        const utilization = count * Math.floor(frameWidth * scale) * Math.floor(frameHeight * scale) / area;
        const choice = { width: canvas.width, height: canvas.height, columns, rows, count, scale, utilization };
        if (!best || count > best.count || area < best.width * best.height
          || (area === best.width * best.height && utilization > best.utilization)) best = choice;
      }
    }
    if (!best) throw new Error('No admissible adaptive layout.');
    return best;
  }
  const full = choose(frameCount);
  const sheets: { startFrame: number; frameCount: number; layout: AiLayout }[] = [];
  for (let start = 0; start < frameCount;) {
    const choice = frameCount - start >= full.count ? full : choose(frameCount - start);
    sheets.push({ startFrame: start, frameCount: choice.count,
      layout: fitLayout(frameWidth, frameHeight, choice.count, choice.width, choice.height, choice.columns, gutter, margin) });
    start += choice.count;
  }
  return { version: 1, kind: 'adaptive-image-edit-batches', billingBasis: 'per-output-image',
    objective: 'Minimize output image count; among equal-capacity candidates use less padding/pixels, not token pricing.',
    source: { width: frameWidth, height: frameHeight, frameCount },
    constraints: { output: { ...options.output, step }, minScale, gutter, margin, maxFramesPerSheet: options.maxFramesPerSheet ?? null },
    eligibleCanvases: canvases.length,
    pixelCapacityPerImage: canvases.reduce((max, c) => Math.max(max, c.maxColumns * c.maxRows), 0),
    maxFramesInThisPlan: full.count,
    outputImageCount: sheets.length, totalCostInImagePriceUnits: sheets.length,
    assumptions: 'Same image price across the supplied output range; returned dimensions must still be measured and verified.', sheets };
}

export async function prepareAdaptivePlans(options: AdaptiveOptions & {
  input: string; reference: string[]; out: string; subject: string; characterNotes: string; extraPrompt?: string; registrationMarkers?: boolean; appearanceReference?: boolean;
}) {
  if (options.registrationMarkers) options = { ...options, gutter: Math.max(16, options.gutter ?? 8), margin: Math.max(12, options.margin ?? 12) };
  const source = await readAnimation(options.input);
  if (source.frames.some(f => !f.opaque)) throw new Error('Adaptive AI planning currently supports opaque displayed frames.');
  const batches = planAdaptiveBatches(source.width, source.height, source.frames.length, options);
  await createOutputDirectory(options.out);
  await writeJson(path.join(options.out, 'adaptive.json'), batches);
  const plans = [];
  for (const [i, batch] of batches.sheets.entries()) {
    const directory = `batch-${String(i).padStart(3, '0')}`;
    await prepareAiPlan({ ...options, out: path.join(options.out, directory), startFrame: batch.startFrame,
      frameCount: batch.frameCount, columns: batch.layout.columns, size: `${batch.layout.width}x${batch.layout.height}`,
      gutter: batch.layout.gutter, margin: batch.layout.margin, promptVersion: 'adaptive-pose-expression-v3' });
    plans.push({ directory, frameStart: batch.startFrame, frameCount: batch.frameCount });
  }
  return { outputImageCount: batches.outputImageCount, billingBasis: batches.billingBasis,
    maxFramesInThisPlan: batches.maxFramesInThisPlan, plans, note: 'Prepared offline only; no API requests were sent.' };
}
