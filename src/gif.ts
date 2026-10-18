import { parseGIF, type ParsedGif } from 'gifuct-js';
import gifenc, { type Palette } from 'gifenc';
import sharp from 'sharp';
import { canonicalizeTransparentPixels, isOpaque } from './pixels.js';
import { checkCanvas, type DecodedGif, type FrameMetadata, type GifMetadata } from './types.js';
import { pixelAspectRatio } from './pixel-aspect.js';

const { GIFEncoder, quantize, applyPalette } = gifenc;

export function inspectGif(bytes: Buffer): GifMetadata {
  if (bytes.length > 100 * 1024 * 1024) throw new Error('GIF input exceeds 100 MiB.');
  if (!/^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('ascii'))) throw new Error('Input is not a GIF.');
  const parsed = parseGIF(Uint8Array.from(bytes).buffer);
  const frames: FrameMetadata[] = [];
  let loopCount: number | null = null;
  let pendingControl: Extract<ParsedGif['frames'][number], { image: unknown }>['gce'] | undefined;
  for (const block of parsed.frames) {
    if ('gce' in block && block.gce) pendingControl = block.gce;
    if ('text' in block) throw new Error('GIF plain-text rendering blocks are not supported.');
    if ('application' in block) {
      const app = block.application;
      if (app.id === 'NETSCAPE2.0' || app.id === 'ANIMEXTS1.0') {
        if (app.blocks.length !== 3 || app.blocks[0] !== 1) throw new Error('Malformed GIF loop extension.');
        const count = app.blocks[1]! | (app.blocks[2]! << 8);
        if (loopCount !== null && loopCount !== count) throw new Error('Conflicting GIF loop extensions.');
        loopCount = count;
      }
    }
    if (!('image' in block)) continue;
    const { descriptor } = block.image;
    // Comments/application extensions may occur between a GCE and its image.
    const gce = pendingControl;
    pendingControl = undefined;
    if (gce?.extras.userInput) throw new Error('GIF frames waiting for user input are not supported.');
    if ((gce?.extras.disposal ?? 0) > 3) throw new Error('Reserved GIF disposal method.');
    const { left: x, top: y, width, height } = descriptor;
    if (x + width > parsed.lsd.width || y + height > parsed.lsd.height) throw new Error('GIF frame extends outside the logical screen.');
    checkCanvas(width, height);
    frames.push({
      index: frames.length, delayMs: (gce?.delay ?? 0) * 10,
      hasGraphicControl: !!gce, disposal: gce?.extras.disposal ?? 0,
      sourceRect: { x, y, width, height },
      transparentIndex: gce?.extras.transparentColorGiven ? gce.transparentColorIndex : null,
      localPalette: descriptor.lct.exists, interlaced: descriptor.lct.interlaced,
    });
  }
  checkCanvas(parsed.lsd.width, parsed.lsd.height, frames.length);
  return {
    width: parsed.lsd.width, height: parsed.lsd.height, frameCount: frames.length,
    durationMs: frames.reduce((sum, f) => sum + f.delayMs, 0), loopCount,
    pixelAspectRatio: parsed.lsd.pixelAspectRatio,
    backgroundColorIndex: parsed.lsd.backgroundColorIndex, frames,
  };
}

/** libvips coalesces delta patches and handles disposal; gifuct preserves raw timing. */
export async function decodeGif(bytes: Buffer): Promise<DecodedGif> {
  const metadata = inspectGif(bytes);
  const { data, info } = await sharp(bytes, { animated: true, failOn: 'warning' })
    .ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const stride = metadata.width * metadata.height * 4;
  if (info.width !== metadata.width || data.length !== stride * metadata.frameCount || info.channels !== 4) {
    throw new Error('GIF parser and pixel decoder disagree on canvas or frame count.');
  }
  const frames = metadata.frames.map((_, i) => canonicalizeTransparentPixels(Buffer.from(data.subarray(i * stride, (i + 1) * stride))));
  return { metadata, frames };
}

function exactPalette(rgba: Buffer, reserveTransparency: boolean): { palette: Palette; indexed: Uint8Array; transparent: boolean } | null {
  const transparent = reserveTransparency;
  const palette: Palette = transparent ? [[0, 0, 0]] : [];
  const lookup = new Map<number, number>();
  const indexed = new Uint8Array(rgba.length / 4);
  for (let i = 0; i < rgba.length; i += 4) {
    const a = rgba[i + 3]!;
    if (a !== 0 && a !== 255) throw new Error('GIF cannot represent partial alpha; choose an explicit matte/threshold policy first.');
    if (a === 0) continue;
    const key = (rgba[i]! << 16) | (rgba[i + 1]! << 8) | rgba[i + 2]!;
    let index = lookup.get(key);
    if (index === undefined) {
      if (palette.length === 256) return null;
      index = palette.length;
      lookup.set(key, index);
      palette.push([rgba[i]!, rgba[i + 1]!, rgba[i + 2]!]);
    }
    indexed[i / 4] = index;
  }
  if (palette.length === 1) palette.push([0, 0, 0]);
  return { palette, indexed, transparent };
}

export function encodeGif(frames: Buffer[], metadata: Pick<GifMetadata, 'width' | 'height' | 'loopCount' | 'pixelAspectRatio'>,
  delays: number[], allowQuantization = false): { bytes: Buffer; quantizedFrames: number[] } {
  const { width, height, loopCount } = metadata;
  checkCanvas(width, height, frames.length);
  pixelAspectRatio(metadata.pixelAspectRatio);
  if (frames.length !== delays.length) throw new Error('Frame/delay count mismatch.');
  if (loopCount !== null && (!Number.isInteger(loopCount) || loopCount < 0 || loopCount > 65535)) throw new Error('Invalid GIF loop count.');
  const gif = GIFEncoder();
  const quantizedFrames: number[] = [];
  // Even an opaque display frame must clear to transparent before the next frame
  // when the animation has transparency. Otherwise disposal=2 leaves a matte.
  const reserveTransparency = frames.some(frame => !isOpaque(frame));
  for (const [i, rgba] of frames.entries()) {
    const delay = delays[i]!;
    if (!Number.isInteger(delay) || delay < 0 || delay > 655350 || delay % 10 !== 0) throw new Error('GIF delay must be an exact multiple of 10 ms (0..655350).');
    if (rgba.length !== width * height * 4) throw new Error(`Frame ${i}: incorrect RGBA size.`);
    for (let p = 3; p < rgba.length; p += 4) {
      if (rgba[p] !== 0 && rgba[p] !== 255) throw new Error('GIF cannot represent partial alpha; choose an explicit matte/threshold policy first.');
    }
    let indexed = exactPalette(rgba, reserveTransparency);
    if (!indexed) {
      if (!allowQuantization) throw new Error(`Frame ${i} exceeds GIF palette capacity. Re-run with --allow-quantization to measure color loss.`);
      const palette = quantize(rgba, reserveTransparency ? 255 : 256, { format: 'rgb565' });
      const pixels = applyPalette(rgba, palette, 'rgb565');
      if (reserveTransparency) {
        palette.unshift([0, 0, 0]);
        for (let p = 0; p < pixels.length; p++) pixels[p] = rgba[p * 4 + 3] === 0 ? 0 : pixels[p]! + 1;
      }
      indexed = { palette, indexed: pixels, transparent: reserveTransparency };
      quantizedFrames.push(i);
    }
    gif.writeFrame(indexed.indexed, width, height, {
      palette: indexed.palette, delay, repeat: loopCount ?? -1, dispose: 2,
      transparent: indexed.transparent, transparentIndex: 0,
    });
  }
  gif.finish();
  const bytes = Buffer.from(gif.bytes());
  // gifenc writes zero here; preserve the validated GIF logical-screen metadata on native round trips.
  bytes[12] = metadata.pixelAspectRatio;
  return { bytes, quantizedFrames };
}
