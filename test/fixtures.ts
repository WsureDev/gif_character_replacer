import { GifWriter, GifReader, type FrameOptions } from 'omggif';

export const COLORS = [0x000000, 0xffffff, 0xff0000, 0x00ff00, 0x0000ff, 0x777777, 0xffff00, 0xff00ff];
export interface FixtureFrame { x?: number; y?: number; width?: number; height?: number; pixels: number[]; options?: FrameOptions }

export function fixture(width: number, height: number, frames: FixtureFrame[], loop?: number, palette = COLORS): Buffer {
  const buffer = Buffer.alloc(1024 * 1024);
  const writer = new GifWriter(buffer, width, height, { palette, ...(loop === undefined ? {} : { loop }) });
  for (const f of frames) writer.addFrame(f.x ?? 0, f.y ?? 0, f.width ?? width, f.height ?? height, f.pixels, f.options);
  return Buffer.from(buffer.subarray(0, writer.end()));
}

export function interlacedFixture(): Buffer {
  const width = 2, height = 9;
  const rows = [0, 8, 4, 2, 6, 1, 3, 5, 7];
  const gif = fixture(width, height, [{ pixels: rows.flatMap(y => [y % 8, y % 8]), options: { delay: 1 } }]);
  const offset = new GifReader(gif).frameInfo(0).data_offset - 1;
  if (gif[offset] !== 0) throw new Error('Unexpected fixture descriptor.');
  gif[offset] = 0x40;
  return gif;
}

export function pixel(frame: Buffer, width: number, x: number, y: number): number[] {
  return [...frame.subarray((y * width + x) * 4, (y * width + x + 1) * 4)];
}
