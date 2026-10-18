import { checkCanvas, type AnimationManifest, type LayoutOptions, type SheetManifest } from './types.js';
import { validateSheets } from './manifests.js';

/** Stage 1: native-size packing only. These layouts do not assert Image API eligibility. */
export function planSheets(animation: AnimationManifest, options: LayoutOptions): SheetManifest {
  const { columns, batchSize, gutter, margin } = options;
  if (![columns, batchSize].every(n => Number.isInteger(n) && n > 0 && n <= 256)
    || ![gutter, margin].every(n => Number.isInteger(n) && n >= 0 && n <= 1024)) throw new Error('Invalid sheet layout options.');
  const sheets: SheetManifest['sheets'] = [];
  for (let start = 0; start < animation.frames.length;) {
    const opaque = animation.frames[start]!.opaque;
    let end = start;
    while (end < animation.frames.length && end - start < batchSize && animation.frames[end]!.opaque === opaque) end++;
    const count = end - start;
    const cols = Math.min(columns, count);
    const rows = Math.ceil(count / cols);
    const width = 2 * margin + cols * animation.width + (cols - 1) * gutter;
    const height = 2 * margin + rows * animation.height + (rows - 1) * gutter;
    checkCanvas(width, height);
    sheets.push({
      file: `sheet-${String(sheets.length).padStart(4, '0')}.png`, width, height, columns: cols, rows,
      background: opaque ? 'opaque' : 'transparent',
      cells: animation.frames.slice(start, end).map((f, i) => ({
        frameIndex: f.index, opaque, x: margin + i % cols * (animation.width + gutter),
        y: margin + Math.floor(i / cols) * (animation.height + gutter), width: animation.width, height: animation.height,
      })),
    });
    start = end;
  }
  return validateSheets({ version: 1, kind: 'sheets', purpose: 'lossless-local-roundtrip', animation, sheets });
}
