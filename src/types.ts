export interface Rect { x: number; y: number; width: number; height: number }
export interface FrameMetadata {
  index: number;
  delayMs: number;
  hasGraphicControl: boolean;
  disposal: number;
  sourceRect: Rect;
  transparentIndex: number | null;
  localPalette: boolean;
  interlaced: boolean;
}
export interface GifMetadata {
  width: number;
  height: number;
  frameCount: number;
  durationMs: number;
  /** Raw NETSCAPE count: null = no extension, 0 = infinite, n = n repetitions. */
  loopCount: number | null;
  pixelAspectRatio: number;
  backgroundColorIndex: number;
  frames: FrameMetadata[];
}
export interface DecodedGif {
  metadata: GifMetadata;
  frames: Buffer[];
}
export interface FrameFile extends FrameMetadata {
  file: string;
  rgbaSha256: string;
  opaque: boolean;
}
export interface AnimationManifest {
  version: 1;
  kind: 'animation';
  source: { name: string; sha256: string; bytes: number };
  width: number;
  height: number;
  loopCount: number | null;
  pixelAspectRatio: number;
  frames: FrameFile[];
}
export interface Cell extends Rect { frameIndex: number; opaque: boolean }
export interface Sheet {
  file: string;
  width: number;
  height: number;
  columns: number;
  rows: number;
  background: 'opaque' | 'transparent';
  cells: Cell[];
}
export interface SheetManifest {
  version: 1;
  kind: 'sheets';
  purpose: 'lossless-local-roundtrip';
  animation: AnimationManifest;
  sheets: Sheet[];
}
export interface LayoutOptions { columns: number; batchSize: number; gutter: number; margin: number }

export const DEFAULT_LAYOUT: LayoutOptions = { columns: 3, batchSize: 9, gutter: 16, margin: 16 };
export const MAX_DECODED_BYTES = 512 * 1024 * 1024;

export function checkCanvas(width: number, height: number, frameCount = 1): void {
  if (![width, height, frameCount].every(x => Number.isSafeInteger(x) && x > 0)
    || width > 65535 || height > 65535 || frameCount > 10000
    || width * height * frameCount * 4 > MAX_DECODED_BYTES) {
    throw new Error('Invalid canvas or decoded RGBA data exceeds the 512 MiB limit.');
  }
}
