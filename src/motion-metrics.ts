/** RGB/block differences retain small moving subjects even on a mostly static background. */
export function frameDifference(data: Uint8Array, width: number, height: number, a: number, b: number) {
  const stride = width * height * 3, blocks = new Float64Array(64), counts = new Uint32Array(64);
  let total = 0, changed = 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const p = (y * width + x) * 3, pa = a * stride + p, pb = b * stride + p;
    const difference = (Math.abs(data[pa]! - data[pb]!) + Math.abs(data[pa + 1]! - data[pb + 1]!) + Math.abs(data[pa + 2]! - data[pb + 2]!)) / (3 * 255);
    total += difference; if (difference > 12 / 255) changed++;
    const block = Math.min(7, Math.floor(y * 8 / height)) * 8 + Math.min(7, Math.floor(x * 8 / width));
    blocks[block]! += difference; counts[block]!++;
  }
  let local = 0;
  for (let i = 0; i < 64; i++) if (counts[i]) local = Math.max(local, blocks[i]! / counts[i]!);
  const mean = total / (width * height), changedFraction = changed / (width * height);
  return { score: Math.max(mean, local * 0.65), mean, changedFraction };
}

export interface MotionJob { kind: 'pairs' | 'evaluate'; data: SharedArrayBuffer; width: number; height: number;
  start: number; end: number; selection?: number[]; delays?: number[] }
export function calculateMotionJob(job: MotionJob) {
  const data = new Uint8Array(job.data);
  if (job.kind === 'pairs') {
    const scores = new Float32Array(job.end - job.start);
    for (let i = job.start; i < job.end; i++) scores[i - job.start] = frameDifference(data, job.width, job.height, i - 1, i).score;
    return { start: job.start, end: job.end, scores };
  }
  const selected = job.selection!, errors: number[] = [];
  let position = 0, maxError = 0, weighted = 0, duration = 0;
  for (let i = job.start; i < job.end; i++) {
    while (position + 1 < selected.length && selected[position + 1]! <= i) position++;
    const error = frameDifference(data, job.width, job.height, selected[position]!, i).score;
    errors.push(error); maxError = Math.max(maxError, error); weighted += error * job.delays![i]!; duration += job.delays![i]!;
  }
  return { start: job.start, end: job.end, maxError, meanError: duration ? weighted / duration : 0, errors };
}
