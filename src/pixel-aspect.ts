import { checkCanvas } from './types.js';

/** GIF89a: 0 means unspecified; otherwise pixel width / height = (byte + 15) / 64. */
export function pixelAspectRatio(value: number) {
  if (!Number.isInteger(value) || value < 0 || value > 255) throw new Error('Invalid GIF pixel aspect ratio byte.');
  return value === 0 ? 1 : (value + 15) / 64;
}

/** Expand the compressed axis so AI PNGs and browser previews have square pixels without distorting display proportions. */
export function squarePixelSize(width: number, height: number, aspectByte = 0) {
  const ratio = pixelAspectRatio(aspectByte);
  const displayWidth = ratio >= 1 ? Math.round(width * ratio) : width;
  const displayHeight = ratio >= 1 ? height : Math.round(height / ratio);
  checkCanvas(displayWidth, displayHeight);
  return { width: displayWidth, height: displayHeight, ratio, aspectByte, rasterWidth: width, rasterHeight: height, corrected: ratio !== 1 };
}
