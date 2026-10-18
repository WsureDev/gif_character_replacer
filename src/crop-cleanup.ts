import type { Rect } from './types.js';

type Edge = 'left' | 'right' | 'top' | 'bottom';
export function edgeWhiteFraction(rgba: Uint8Array, width: number, rect: Rect, edge: Edge, depth = 0) {
  const vertical = edge === 'left' || edge === 'right', length = vertical ? rect.height : rect.width;
  let white = 0;
  for (let i = 0; i < length; i++) {
    const x = vertical ? rect.x + (edge === 'left' ? depth : rect.width - 1 - depth) : rect.x + i;
    const y = vertical ? rect.y + i : rect.y + (edge === 'top' ? depth : rect.height - 1 - depth);
    const p = (y * width + x) * 4;
    if (Math.min(rgba[p]!, rgba[p + 1]!, rgba[p + 2]!) >= 232) white++;
  }
  return white / length;
}

/** Only remove gutter-like edges absent from the source; never interpret a white scene as transparency. */
export function cleanCrop(sheet: Uint8Array, sheetWidth: number, rect: Rect, source: Uint8Array, sourceWidth: number, sourceHeight: number) {
  const edges: Edge[] = ['left', 'right', 'top', 'bottom'];
  const sourceRect = { x: 0, y: 0, width: sourceWidth, height: sourceHeight };
  const trims: Record<Edge, number> = { left: 0, right: 0, top: 0, bottom: 0 };
  const sourceWhite: Record<Edge, number> = { left: 0, right: 0, top: 0, bottom: 0 };
  for (const edge of edges) {
    sourceWhite[edge] = edgeWhiteFraction(source, sourceWidth, sourceRect, edge);
    if (sourceWhite[edge] > 0.7) continue;
    const max = Math.max(0, Math.min(24, Math.floor((edge === 'left' || edge === 'right' ? rect.width : rect.height) * 0.04)));
    while (trims[edge] < max && edgeWhiteFraction(sheet, sheetWidth, rect, edge, trims[edge]) >= 0.97) trims[edge]++;
  }
  // Exclude subpixel gutter blends as well as pure-white padding, before resampling.
  const guard = Math.max(0, Math.min(2, Math.floor((Math.min(rect.width, rect.height) - 1) / 4)));
  const crop = { x: rect.x + trims.left + guard, y: rect.y + trims.top + guard,
    width: rect.width - trims.left - trims.right - 2 * guard,
    height: rect.height - trims.top - trims.bottom - 2 * guard };
  if (crop.width < 1 || crop.height < 1) throw new Error('No content remains after gutter exclusion.');
  const remainingWhite = Object.fromEntries(edges.map(edge => [edge, edgeWhiteFraction(sheet, sheetWidth, crop, edge)]));
  for (const edge of edges) if (sourceWhite[edge] < 0.2 && remainingWhite[edge]! >= 0.97) {
    throw new Error(`新增的整条白边仍存在（${edge}），保留返回图，拒绝生成带分隔边的 GIF。`);
  }
  return { crop, trims, guard, sourceWhite, remainingWhite, fit: 'fill' as const };
}
