import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { readAiPlan, type AiPlan } from './ai-plan.js';
import { createOutputDirectory, writeJson } from './manifests.js';
import { validateEditedSheet, makePreviews } from './ai-run.js';
import { sha256 } from './pixels.js';
import { ImageProcessor } from './image-processor.js';
import { registerFiducials } from './fiducials.js';

function runs(values: number[]): { start: number; end: number }[] {
  const result = [];
  for (let i = 0; i < values.length;) {
    if (values[i]! < 0.99) { i++; continue; }
    const start = i;
    while (i < values.length && values[i]! >= 0.99) i++;
    result.push({ start, end: i });
  }
  return result;
}

/** Offline-only recovery: actual white gutter bands must corroborate near-uniform scaling. */
export async function recoverLayout(bytes: Buffer, plan: AiPlan) {
  if (plan.fiducials) {
    const found = await registerFiducials(bytes, plan.layout);
    const derived: AiPlan = { ...plan, layout: { ...plan.layout, width: found.width, height: found.height, cells: found.cells, scale: plan.layout.scale * found.sx } };
    const validation = await validateEditedSheet(bytes, derived, 2);
    if (!validation.passed) throw new Error(`角标已定位，图像检查未通过：非不透明像素 ${validation.nonOpaquePixels ?? '未知'}；分隔带变色 ${((validation.changedGutterFraction ?? 0) * 100).toFixed(2)}%（上限 8%，已排除 2 px 边缘过渡）。`);
    return { derived, registration: { requestedSize: `${plan.layout.width}x${plan.layout.height}`, actualSize: `${found.width}x${found.height}`,
      sx: found.sx, sy: found.sy, maxBoundaryDistance: null, verticalBands: [], horizontalBands: [], cells: found.cells,
      method: found.method, matches: found.matches, validation, note: 'Four detected corner features define each content rectangle; trimming and fill resize are recorded in crop-report.json.' } };
  }
  const { data, info } = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const sx = info.width / plan.layout.width, sy = info.height / plan.layout.height;
  if (Math.abs(sx / sy - 1) > 0.002) throw new Error('Output is not uniformly scaled; refusing coordinate recovery.');
  const columns = Array<number>(info.width).fill(0), rows = Array<number>(info.height).fill(0);
  for (let y = 0; y < info.height; y++) for (let x = 0; x < info.width; x++) {
    const p = (y * info.width + x) * 4;
    if (data[p + 3] !== 255) throw new Error('Unexpected transparency; recovery never flattens output.');
    if (Math.min(data[p]!, data[p + 1]!, data[p + 2]!) >= 245) { columns[x]!++; rows[y]!++; }
  }
  const verticalBands = runs(columns.map(n => n / info.height));
  const horizontalBands = runs(rows.map(n => n / info.width));
  const maxBoundaryDistance = 4;
  function boundary(expected: number, bands: { start: number; end: number }[], edge: 'start' | 'end'): number {
    const distances = bands.map(band => ({ value: band[edge], delta: Math.abs(band[edge] - expected) }))
      .filter(b => b.delta <= maxBoundaryDistance).sort((a, b) => a.delta - b.delta);
    if (!distances.length) throw new Error(`No reliable white band within ${maxBoundaryDistance}px of expected boundary ${expected.toFixed(2)}.`);
    return distances[0]!.value;
  }
  const cells = plan.layout.cells.map(c => {
    const x = boundary(c.x * sx, verticalBands, 'end');
    const y = boundary(c.y * sy, horizontalBands, 'end');
    const right = boundary((c.x + c.width) * sx, verticalBands, 'start');
    const bottom = boundary((c.y + c.height) * sy, horizontalBands, 'start');
    if (right <= x || bottom <= y) throw new Error('Invalid recovered cell.');
    return { ...c, x, y, width: right - x, height: bottom - y };
  });
  const derived: AiPlan = { ...plan, layout: { ...plan.layout, width: info.width, height: info.height, cells, scale: plan.layout.scale * sx } };
  const validation = await validateEditedSheet(bytes, derived);
  if (!validation.passed) throw new Error('Recovered boundaries failed alpha/padding validation.');
  return { derived, registration: { requestedSize: `${plan.layout.width}x${plan.layout.height}`,
    actualSize: `${info.width}x${info.height}`, sx, sy, maxBoundaryDistance,
    verticalBands, horizontalBands, cells, validation,
    note: 'Observed white-band edges, not a blind full-image resize. Frame content and motion still require visual review.' } };
}

export async function recoverImageEdit(planFile: string, editedFile: string, out: string) {
  const plan = await readAiPlan(planFile);
  const bytes = await fs.readFile(editedFile);
  const { derived, registration } = await recoverLayout(bytes, plan);
  const inputs = new Map<string, Buffer>();
  const images = new ImageProcessor();
  for (const f of plan.frames) {
    const source = await fs.readFile(path.join(path.dirname(planFile), f.file));
    if (sha256(await images.readPng(source, plan.source.width, plan.source.height)) !== f.rgbaSha256) throw new Error('Source frame hash mismatch.');
    inputs.set(f.file, source);
  }
  await createOutputDirectory(out);
  await fs.writeFile(path.join(out, 'edited-sheet.png'), bytes, { flag: 'wx' });
  await writeJson(path.join(out, 'registration.json'), { ...registration, sourcePlanSha256: sha256(await fs.readFile(planFile)), outputSha256: sha256(bytes) });
  const previews = await makePreviews(bytes, derived, out, inputs);
  await writeJson(path.join(out, 'preview-metadata.json'), previews);
  return { registration, previews };
}
