import { createHash } from 'node:crypto';

export function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function isOpaque(rgba: Uint8Array): boolean {
  for (let i = 3; i < rgba.length; i += 4) if (rgba[i] !== 255) return false;
  return true;
}

/** Remove only a verified constant alpha channel before resampling; never matte or threshold real transparency. */
export function opaqueRgb(rgba: Uint8Array): Buffer {
  if (!rgba.length || rgba.length % 4 || !isOpaque(rgba)) throw new Error('Opaque resize requires alpha=255 for every input pixel.');
  const rgb = Buffer.allocUnsafe(rgba.length / 4 * 3);
  for (let p = 0, q = 0; p < rgba.length; p += 4, q += 3) {
    rgb[q] = rgba[p]!; rgb[q + 1] = rgba[p + 1]!; rgb[q + 2] = rgba[p + 2]!;
  }
  return rgb;
}

/** RGB under alpha=0 has no displayed meaning. Keep a canonical form for hashes. */
export function canonicalizeTransparentPixels(rgba: Buffer): Buffer {
  for (let i = 0; i < rgba.length; i += 4) {
    if (rgba[i + 3] === 0) rgba.fill(0, i, i + 3);
  }
  return rgba;
}

export function comparePixels(expected: Uint8Array, actual: Uint8Array) {
  if (expected.length !== actual.length) throw new Error('Cannot compare different canvas sizes.');
  let changedPixels = 0;
  let alphaErrors = 0;
  let squaredError = 0;
  let maxChannelError = 0;
  for (let i = 0; i < expected.length; i += 4) {
    let changed = false;
    if (expected[i + 3] !== actual[i + 3]) alphaErrors++;
    for (let c = 0; c < 4; c++) {
      if (c < 3 && expected[i + 3] === 0 && actual[i + 3] === 0) continue;
      const d = Math.abs(expected[i + c]! - actual[i + c]!);
      if (d) changed = true;
      maxChannelError = Math.max(maxChannelError, d);
      if (c < 3) squaredError += d * d;
    }
    if (changed) changedPixels++;
  }
  return {
    exact: changedPixels === 0, changedPixels, alphaErrors, maxChannelError,
    rgbRmse: Math.sqrt(squaredError / (expected.length / 4 * 3)),
  };
}
