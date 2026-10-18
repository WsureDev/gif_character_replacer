import { z } from 'zod';

const int = z.number().int().nonnegative();
const positive = z.number().int().positive();
export const aiLayoutSchema = z.object({
  width: positive, height: positive, columns: positive, rows: positive, frameCount: positive,
  sourceWidth: positive, sourceHeight: positive, margin: int, gutter: int,
  scale: z.number().positive(), utilization: z.number().min(0).max(1),
  cells: z.array(z.object({ frameOffset: int, x: int, y: int, width: positive, height: positive }).strict()),
}).strict();
export type AiLayout = z.infer<typeof aiLayoutSchema>;

export function assertImageSize(width: number, height: number): void {
  if (![width, height].every(n => Number.isInteger(n) && n > 0 && n % 16 === 0)
    || Math.max(width, height) > 3840 || Math.max(width, height) / Math.min(width, height) > 3
    || width * height < 655360 || width * height > 8294400) {
    throw new Error(`Unsupported GPT Image 2.5 size ${width}x${height}: multiples of 16, edge <=3840, aspect <=3, area 655360..8294400 required.`);
  }
}

export function parseImageSize(size: string): [number, number] {
  if (!/^\d+x\d+$/.test(size)) throw new Error('Use an explicit WIDTHxHEIGHT image size.');
  const [width, height] = size.split('x').map(Number) as [number, number];
  assertImageSize(width, height);
  return [width, height];
}

export function fitLayout(sourceWidth: number, sourceHeight: number, frameCount: number,
  width: number, height: number, columns: number, gutter = 16, margin = 16): AiLayout {
  assertImageSize(width, height);
  if (![sourceWidth, sourceHeight, frameCount, columns].every(n => Number.isInteger(n) && n > 0)
    || frameCount > 10000 || columns > frameCount || ![gutter, margin].every(n => Number.isInteger(n) && n >= 0)) throw new Error('Invalid layout inputs.');
  const rows = Math.ceil(frameCount / columns);
  const tileWidth = Math.floor((width - 2 * margin - (columns - 1) * gutter) / columns);
  const tileHeight = Math.floor((height - 2 * margin - (rows - 1) * gutter) / rows);
  const scale = Math.min(tileWidth / sourceWidth, tileHeight / sourceHeight);
  const contentWidth = Math.floor(sourceWidth * scale), contentHeight = Math.floor(sourceHeight * scale);
  if (contentWidth < 1 || contentHeight < 1) throw new Error('No space for frame content.');
  const cells = Array.from({ length: frameCount }, (_, i) => ({
    frameOffset: i, x: margin + i % columns * (tileWidth + gutter) + Math.floor((tileWidth - contentWidth) / 2),
    y: margin + Math.floor(i / columns) * (tileHeight + gutter) + Math.floor((tileHeight - contentHeight) / 2),
    width: contentWidth, height: contentHeight,
  }));
  return { width, height, columns, rows, frameCount, sourceWidth, sourceHeight, margin, gutter,
    scale, utilization: frameCount * contentWidth * contentHeight / (width * height), cells };
}

/** Ranks geometry only: effective source detail and occupied area, not unmeasured AI quality. */
export function chooseLayout(sourceWidth: number, sourceHeight: number, frameCount: number, size: string): AiLayout {
  const [width, height] = parseImageSize(size);
  if (![sourceWidth, sourceHeight, frameCount].every(n => Number.isInteger(n) && n > 0) || frameCount > 10000) throw new Error('Invalid source geometry.');
  let best: { columns: number; area: number; squareness: number } | undefined;
  for (let columns = 1; columns <= frameCount; columns++) {
    const rows = Math.ceil(frameCount / columns);
    const tileWidth = Math.floor((width - 32 - (columns - 1) * 16) / columns);
    const tileHeight = Math.floor((height - 32 - (rows - 1) * 16) / rows);
    const scale = Math.min(tileWidth / sourceWidth, tileHeight / sourceHeight);
    if (scale <= 0) continue;
    const w = Math.floor(sourceWidth * scale), h = Math.floor(sourceHeight * scale);
    if (w < 1 || h < 1) continue;
    const area = w * h, squareness = Math.abs(columns - rows);
    if (!best || area > best.area || (area === best.area && squareness < best.squareness)) best = { columns, area, squareness };
  }
  if (!best) throw new Error('No grid fits the requested canvas and gutter.');
  return fitLayout(sourceWidth, sourceHeight, frameCount, width, height, best.columns);
}

export function candidateLayouts(sourceWidth: number, sourceHeight: number, frameCount: number): AiLayout[] {
  const sizes = new Set(['1024x1024', '1536x1024', '1024x1536']);
  for (let columns = 1; columns <= Math.min(frameCount, 8); columns++) {
    const rows = Math.ceil(frameCount / columns);
    let width = columns * sourceWidth + (columns - 1) * 16 + 32;
    let height = rows * sourceHeight + (rows - 1) * 16 + 32;
    const factor = Math.max(1, Math.sqrt(655360 / (width * height)));
    width = Math.ceil(width * factor / 16) * 16; height = Math.ceil(height * factor / 16) * 16;
    try { assertImageSize(width, height); sizes.add(`${width}x${height}`); } catch { /* Exclude invalid geometry. */ }
  }
  return [...sizes].map(size => chooseLayout(sourceWidth, sourceHeight, frameCount, size))
    .sort((a, b) => (Math.min(b.scale, 1) ** 2 * b.utilization) - (Math.min(a.scale, 1) ** 2 * a.utilization)
      || a.width * a.height - b.width * b.height);
}

export function validateAiLayout(value: unknown): AiLayout {
  const layout = aiLayoutSchema.parse(value);
  const expected = fitLayout(layout.sourceWidth, layout.sourceHeight, layout.frameCount,
    layout.width, layout.height, layout.columns, layout.gutter, layout.margin);
  if (JSON.stringify(layout.cells) !== JSON.stringify(expected.cells)) throw new Error('Cell coordinates do not match layout.');
  return expected;
}
