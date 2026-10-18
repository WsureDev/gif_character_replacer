import sharp from 'sharp';
import { z } from 'zod';
import type { AiLayout } from './ai-layout.js';

export const fiducialSchema = z.object({ version: z.literal(1), size: z.literal(5), offset: z.literal(2) }).strict();
export type FiducialSpec = z.infer<typeof fiducialSchema>;
export const FIDUCIALS: FiducialSpec = { version: 1, size: 5, offset: 2 };
const colors = [[230, 0, 160], [0, 180, 235], [60, 210, 0], [255, 70, 0]] as const;
const corners = ['TL', 'TR', 'BL', 'BR'] as const;
export function markerPositions(layout: AiLayout) {
  const reach = FIDUCIALS.offset + FIDUCIALS.size;
  return layout.cells.flatMap(cell => corners.map((corner, color) => ({ frame: cell.frameOffset, corner, color,
    x: corner.endsWith('L') ? cell.x - reach : cell.x + cell.width + FIDUCIALS.offset,
    y: corner.startsWith('T') ? cell.y - reach : cell.y + cell.height + FIDUCIALS.offset })));
}
export async function drawFiducials(sheet: Buffer, layout: AiLayout) {
  const patches = await Promise.all(colors.map(async color => {
    const pixels = Buffer.alloc(5 * 5 * 4);
    for (let i = 0; i < 25; i++) { pixels[i * 4] = color[0]; pixels[i * 4 + 1] = color[1]; pixels[i * 4 + 2] = color[2]; pixels[i * 4 + 3] = 255; }
    pixels.fill(0, (2 * 5 + 2) * 4, (2 * 5 + 2) * 4 + 3);
    return sharp(pixels, { raw: { width: 5, height: 5, channels: 4 } }).png().toBuffer();
  }));
  const markers = markerPositions(layout);
  if (markers.some(m => m.x < 0 || m.y < 0 || m.x + 5 > layout.width || m.y + 5 > layout.height)) throw new Error('No room for corner markers.');
  return sharp(sheet).composite(markers.map(m => ({ input: patches[m.color]!, left: m.x, top: m.y }))).png().toBuffer();
}

export interface MarkerComponent { id: number; color: number; x: number; y: number; width: number; height: number; area: number }
/** Redrawn tiny tags can mix neighboring hues. Association also checks their positions and geometry. */
function hueLabel(r: number, g: number, b: number) {
  const max = Math.max(r, g, b), min = Math.min(r, g, b), chroma = max - min;
  if (max < 115 || chroma < 60 || chroma / max < 0.4) return 0;
  let hue = max === r ? 60 * ((g - b) / chroma) : max === g ? 60 * ((b - r) / chroma + 2) : 60 * ((r - g) / chroma + 4);
  if (hue < 0) hue += 360;
  return (hue >= 280 && hue <= 350 ? 1 : 0) | (hue >= 170 && hue <= 220 ? 2 : 0)
    | (hue >= 60 && hue <= 170 ? 4 : 0) | (hue <= 60 || hue >= 310 ? 8 : 0);
}
/** Detect colored connected components once, then associate four distinct markers per cell. */
export async function registerFiducials(bytes: Buffer, layout: AiLayout) {
  try { return await registerColors(bytes, layout, false); }
  catch (error) {
    if (!(error instanceof Error) || !error.message.includes('缺失')) throw error;
    return registerColors(bytes, layout, true);
  }
}
async function registerColors(bytes: Buffer, layout: AiLayout, useHue: boolean) {
  const { data, info } = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const labels = new Uint8Array(info.width * info.height), queue = new Int32Array(labels.length);
  for (let i = 0; i < labels.length; i++) {
    if (data[i * 4 + 3] !== 255) throw new Error('Unexpected transparency in marked output.');
    if (useHue) { labels[i] = hueLabel(data[i * 4]!, data[i * 4 + 1]!, data[i * 4 + 2]!); continue; }
    for (let c = 0; c < colors.length; c++) {
      const color = colors[c]!;
      if ((data[i * 4]! - color[0]) ** 2 + (data[i * 4 + 1]! - color[1]) ** 2 + (data[i * 4 + 2]! - color[2]) ** 2 < 65 ** 2) { labels[i] = 1 << c; break; }
    }
  }
  const sx = info.width / layout.width, sy = info.height / layout.height;
  const blobs: MarkerComponent[] = [];
  for (let colorIndex = 0; colorIndex < 4; colorIndex++) for (let p = 0; p < labels.length; p++) {
    const color = 1 << colorIndex; if (!(labels[p]! & color)) continue;
    let start = 0, end = 1, sumX = 0, sumY = 0, minX = info.width, maxX = 0, minY = info.height, maxY = 0;
    queue[0] = p; labels[p]! &= ~color;
    while (start < end) {
      const index = queue[start++]!, x = index % info.width, y = Math.floor(index / info.width);
      sumX += x + 0.5; sumY += y + 0.5; minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      for (const neighbor of [x ? index - 1 : -1, x + 1 < info.width ? index + 1 : -1, y ? index - info.width : -1, y + 1 < info.height ? index + info.width : -1]) {
        if (neighbor >= 0 && (labels[neighbor]! & color)) { labels[neighbor]! &= ~color; queue[end++] = neighbor; }
      }
    }
    const width = maxX - minX + 1, height = maxY - minY + 1;
    if (end >= Math.max(2, 4 * sx * sy) && end <= 100 * sx * sy && width <= 14 * sx && height <= 14 * sy
      && width >= (useHue ? Math.floor(2 * sx) : 2 * sx) && height >= (useHue ? Math.floor(2 * sy) : 2 * sy)) blobs.push({ id: blobs.length, color: colorIndex, x: sumX / end, y: sumY / end, width, height, area: end });
  }
  const used = new Set<number>();
  const matches: (MarkerComponent & { frame: number; corner: typeof corners[number] })[] = [];
  const expected = markerPositions(layout);
  const cells = layout.cells.map(cell => {
    const cellMarkers = expected.slice(cell.frameOffset * 4, cell.frameOffset * 4 + 4);
    const choices = cellMarkers.map(marker => {
      const ex = (marker.x + 2.5) * sx, ey = (marker.y + 2.5) * sy;
      const radius = Math.max(10, Math.min(cell.width * sx, cell.height * sy) * 0.08);
      const candidates = blobs.filter(b => b.color === marker.color && !used.has(b.id) && Math.abs(b.x - ex) <= radius && Math.abs(b.y - ey) <= radius
        && (!useHue || matches.every(m => Math.hypot(m.x - b.x, m.y - b.y) >= Math.max(1.5, 2 * Math.min(sx, sy)))))
        .sort((a, b) => Math.hypot(a.x - ex, a.y - ey) - Math.hypot(b.x - ex, b.y - ey));
      if (!candidates.length) throw new Error(`第 ${cell.frameOffset + 1} 格缺失 ${marker.corner} 定位标记，已保留返回图，拒绝猜测切图。`);
      return candidates.slice(0, useHue ? 5 : 1);
    });
    let found: MarkerComponent[] = [], bestScore = Infinity;
    for (const tl of choices[0]!) for (const tr of choices[1]!) for (const bl of choices[2]!) for (const br of choices[3]!) {
      const group = [tl, tr, bl, br];
      const alignment = [tl.x - bl.x, tr.x - br.x, tl.y - tr.y, bl.y - br.y];
      if (Math.max(...alignment.map(Math.abs)) > 4 || tr.x <= tl.x || bl.y <= tl.y) continue;
      const score = alignment.reduce((sum, d) => sum + d * d, 0) * 4 + group.reduce((sum, b, i) => {
        const m = cellMarkers[i]!; return sum + ((b.x - (m.x + 2.5) * sx) ** 2 + (b.y - (m.y + 2.5) * sy) ** 2) * 0.2;
      }, 0);
      if (score < bestScore) { bestScore = score; found = group; }
    }
    if (!found.length) throw new Error(`第 ${cell.frameOffset + 1} 格定位标记不构成稳定矩形。`);
    for (const [i, match] of found.entries()) { used.add(match.id); matches.push({ frame: cell.frameOffset, corner: cellMarkers[i]!.corner, ...match }); }
    const [tl, tr, bl, br] = found as [MarkerComponent, MarkerComponent, MarkerComponent, MarkerComponent];
    const left = (tl.x + bl.x) / 2, right = (tr.x + br.x) / 2, top = (tl.y + tr.y) / 2, bottom = (bl.y + br.y) / 2;
    const localSx = (right - left) / (cell.width + 9), localSy = (bottom - top) / (cell.height + 9);
    if (localSx <= 0 || localSy <= 0 || Math.max(Math.abs(tl.x - bl.x), Math.abs(tr.x - br.x), Math.abs(tl.y - tr.y), Math.abs(bl.y - br.y)) > 4) {
      throw new Error(`第 ${cell.frameOffset + 1} 格定位标记不构成稳定矩形：${found.map(m => `${m.x.toFixed(1)},${m.y.toFixed(1)}`).join(' / ')}。`);
    }
    const x = Math.ceil(left + 4.5 * localSx), y = Math.ceil(top + 4.5 * localSy);
    const r = Math.floor(right - 4.5 * localSx), b = Math.floor(bottom - 4.5 * localSy);
    if (x < 0 || y < 0 || r > info.width || b > info.height || r <= x || b <= y) throw new Error('Invalid marker-registered content rectangle.');
    return { ...cell, x, y, width: r - x, height: b - y };
  });
  return { width: info.width, height: info.height, cells, matches, method: useHue ? 'four-corner-hue-components-v2' : 'four-corner-color-components-v1', sx, sy };
}
