declare module 'gifenc' {
  export type Palette = number[][];
  export function GIFEncoder(): {
    writeFrame(index: Uint8Array, width: number, height: number, options: {
      palette?: Palette;
      delay: number;
      repeat: number;
      dispose: number;
      transparent: boolean;
      transparentIndex?: number;
    }): void;
    finish(): void;
    bytes(): Uint8Array;
  };
  export function quantize(rgba: Uint8Array, maxColors: number, options?: {
    format?: 'rgb565' | 'rgba4444';
    oneBitAlpha?: boolean;
  }): Palette;
  export function applyPalette(rgba: Uint8Array, palette: Palette, format?: 'rgb565' | 'rgba4444'): Uint8Array;
  const api: { GIFEncoder: typeof GIFEncoder; quantize: typeof quantize; applyPalette: typeof applyPalette };
  export default api;
}
