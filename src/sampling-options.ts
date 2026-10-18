import type { GifMetadata } from './types.js';
import { squarePixelSize } from './pixel-aspect.js';

/** An area-halving ladder, bounded by this GIF's actual pixel dimensions. */
export function samplingOptions(metadata: Pick<GifMetadata, 'width' | 'height' | 'frames' | 'durationMs'> & { pixelAspectRatio?: number }) {
  const pixelAspect = squarePixelSize(metadata.width, metadata.height, metadata.pixelAspectRatio ?? 0);
  const { width, height } = pixelAspect, { durationMs } = metadata;
  const count = metadata.frames.length, longEdge = Math.max(width, height);
  const resolutions = [];
  let previous = 0;
  for (let i = 0; ; i++) {
    const edge = Math.max(1, Math.round(longEdge / 2 ** (i / 2)));
    if (edge !== previous) resolutions.push({ longEdge: edge, scale: edge / longEdge,
      width: Math.max(1, Math.round(width * edge / longEdge)), height: Math.max(1, Math.round(height * edge / longEdge)) });
    previous = edge;
    if (edge === 1) break;
  }
  const minFrames = durationMs ? Math.max(1, Math.ceil(durationMs / 655350)) : count;
  const counts = new Set<number>([count, minFrames]);
  for (let divisor = 2; Math.round(count / divisor) > minFrames; divisor *= 2) counts.add(Math.round(count / divisor));
  const framePresets = [...counts].sort((a, b) => b - a);
  const averageFps = durationMs ? count * 1000 / durationMs : 0;
  return {
    pixelAspect,
    resolution: { minLongEdge: 1, maxLongEdge: longEdge, presets: resolutions },
    frames: { min: minFrames, max: count, presets: framePresets },
    fps: { min: durationMs ? minFrames * 1000 / durationMs : 0, max: averageFps,
      presets: durationMs ? framePresets.map(n => ({ value: n * 1000 / durationMs, frameBudget: n })) : [] },
    variableFrameTiming: new Set(metadata.frames.map(f => f.delayMs)).size > 1,
    canReduceFrames: durationMs > 0 && count > minFrames,
  };
}
export type SamplingOptions = ReturnType<typeof samplingOptions>;
