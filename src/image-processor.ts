/**
 * Adapted from restyle-sprites ImageProcessor.ts (MIT, Alex Wegener, 2026).
 * Source: aebd96e499b931eca60b4fa9c7dd83851ea098ee; see THIRD_PARTY_NOTICES.md.
 * Extends its Sharp extract/composite operations to explicit 2D coordinates.
 */
import sharp from 'sharp';
import { checkCanvas, type Rect } from './types.js';
import { canonicalizeTransparentPixels } from './pixels.js';

export class ImageProcessor {
  async rgbaToPng(rgba: Buffer, width: number, height: number): Promise<Buffer> {
    checkCanvas(width, height);
    if (rgba.length !== width * height * 4) throw new Error('Invalid RGBA byte count.');
    return sharp(rgba, { raw: { width, height, channels: 4 } }).png().toBuffer();
  }

  async readPng(bytes: Buffer, width: number, height: number): Promise<Buffer> {
    const metadata = await sharp(bytes).metadata();
    if (metadata.format !== 'png' || metadata.width !== width || metadata.height !== height || (metadata.pages ?? 1) !== 1) {
      throw new Error(`Expected one ${width}x${height} PNG; refusing automatic resize/crop.`);
    }
    return canonicalizeTransparentPixels(await sharp(bytes).ensureAlpha().raw().toBuffer());
  }

  async extractFrames(sheetPng: Buffer, rects: Rect[]): Promise<Buffer[]> {
    const frames: Buffer[] = [];
    for (const rect of rects) {
      frames.push(await sharp(sheetPng)
        .extract({ left: rect.x, top: rect.y, width: rect.width, height: rect.height })
        .png().toBuffer());
    }
    return frames;
  }

  async stitchSheet(frames: { input: Buffer; rect: Rect }[], width: number, height: number,
    opaque: boolean): Promise<Buffer> {
    checkCanvas(width, height);
    const composite = frames.map(({ input, rect }) => ({ input, left: rect.x, top: rect.y }));
    return sharp({ create: { width, height, channels: 4,
      background: { r: 255, g: 255, b: 255, alpha: opaque ? 1 : 0 } } })
      .composite(composite).png().toBuffer();
  }
}
