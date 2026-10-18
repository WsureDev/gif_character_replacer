import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { checkCanvas, type AnimationManifest, type SheetManifest } from './types.js';

const integer = z.number().int().nonnegative();
const dimension = z.number().int().positive().max(65535);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const file = z.string().min(1).refine(p => !path.isAbsolute(p) && !p.includes('\\')
  && p.split('/').every(part => part !== '..' && part !== '.' && part !== ''), 'Expected a local relative path.');
const rect = z.object({ x: integer, y: integer, width: dimension, height: dimension });
const frame = z.object({
  index: integer, delayMs: integer.max(655350).refine(n => n % 10 === 0),
  hasGraphicControl: z.boolean(), disposal: integer.max(3), sourceRect: rect,
  transparentIndex: integer.max(255).nullable(), localPalette: z.boolean(), interlaced: z.boolean(),
  file, rgbaSha256: digest, opaque: z.boolean(),
}).strict();
const animationSchema: z.ZodType<AnimationManifest> = z.object({
  version: z.literal(1), kind: z.literal('animation'),
  source: z.object({ name: z.string(), sha256: digest, bytes: integer }).strict(),
  width: dimension, height: dimension, loopCount: integer.max(65535).nullable(),
  pixelAspectRatio: integer.max(255), frames: z.array(frame).min(1).max(10000),
}).strict();
const sheetSchema: z.ZodType<SheetManifest> = z.object({
  version: z.literal(1), kind: z.literal('sheets'), purpose: z.literal('lossless-local-roundtrip'),
  animation: animationSchema,
  sheets: z.array(z.object({
    file, width: dimension, height: dimension, columns: dimension, rows: dimension,
    background: z.enum(['opaque', 'transparent']),
    cells: z.array(rect.extend({ frameIndex: integer, opaque: z.boolean() }).strict()).min(1),
  }).strict()).min(1),
}).strict();

export function validateAnimation(value: unknown): AnimationManifest {
  const animation = animationSchema.parse(value);
  checkCanvas(animation.width, animation.height, animation.frames.length);
  const files = new Set<string>();
  for (const [index, frame] of animation.frames.entries()) {
    if (frame.index !== index || files.has(frame.file)) throw new Error('Animation frame indexes/files must be unique and ordered.');
    if (frame.sourceRect.x + frame.sourceRect.width > animation.width
      || frame.sourceRect.y + frame.sourceRect.height > animation.height) throw new Error('Source frame rectangle is out of bounds.');
    files.add(frame.file);
  }
  return animation;
}

export function validateSheets(value: unknown): SheetManifest {
  const manifest = sheetSchema.parse(value);
  validateAnimation(manifest.animation);
  const seen = new Set<number>();
  const files = new Set<string>();
  let nextIndex = 0;
  for (const sheet of manifest.sheets) {
    checkCanvas(sheet.width, sheet.height);
    if (files.has(sheet.file)) throw new Error('Duplicate sheet file.');
    files.add(sheet.file);
    if (sheet.cells.length > sheet.rows * sheet.columns) throw new Error('Too many cells for sheet grid.');
    for (const [i, cell] of sheet.cells.entries()) {
      const frame = manifest.animation.frames[cell.frameIndex];
      if (!frame || seen.has(cell.frameIndex) || cell.frameIndex !== nextIndex++) throw new Error('Missing, duplicated or reordered frame in sheets.');
      if (cell.width !== manifest.animation.width || cell.height !== manifest.animation.height
        || cell.x + cell.width > sheet.width || cell.y + cell.height > sheet.height) throw new Error('Invalid cell geometry.');
      if (cell.opaque !== frame.opaque || (sheet.background === 'opaque') !== cell.opaque) throw new Error('Sheet background policy disagrees with source frames.');
      for (const earlier of sheet.cells.slice(0, i)) {
        if (cell.x < earlier.x + earlier.width && earlier.x < cell.x + cell.width
          && cell.y < earlier.y + earlier.height && earlier.y < cell.y + cell.height) throw new Error('Sheet cells overlap.');
      }
      seen.add(cell.frameIndex);
    }
  }
  if (seen.size !== manifest.animation.frames.length) throw new Error('Sheets do not cover every frame exactly once.');
  return manifest;
}

export async function readAnimation(file: string): Promise<AnimationManifest> {
  return validateAnimation(JSON.parse(await fs.readFile(file, 'utf8')));
}
export async function readSheets(file: string): Promise<SheetManifest> {
  return validateSheets(JSON.parse(await fs.readFile(file, 'utf8')));
}
export async function writeJson(file: string, value: unknown): Promise<void> {
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
}

/** Every operation claims a new directory so inputs and previous trials are never overwritten. */
export async function createOutputDirectory(directory: string): Promise<void> {
  await fs.mkdir(path.dirname(path.resolve(directory)), { recursive: true });
  await fs.mkdir(directory);
}
