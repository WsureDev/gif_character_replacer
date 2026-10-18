import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import fs from 'node:fs/promises';
import { sha256 } from './pixels.js';

const run = promisify(execFile);

async function frameHashes(file: string) {
  const { stdout } = await run('ffmpeg', ['-v', 'error', '-i', path.resolve(file), '-map', '0:v:0', '-an',
    '-fps_mode', 'passthrough', '-pix_fmt', 'rgba', '-f', 'framemd5', '-'], { maxBuffer: 16 * 1024 * 1024 });
  const lines = stdout.trim().split('\n');
  const frames = lines.filter(line => !line.startsWith('#')).map(line => line.split(',').map(s => s.trim()));
  if (!frames.length || frames.some(f => f.length !== 6)) throw new Error('Unexpected FFmpeg framemd5 output.');
  return { timebase: lines.find(line => line.startsWith('#tb 0:')), frames };
}

/** Independent decoder check; FFmpeg may clamp short GIF delays, so raw timing is checked separately. */
export async function verifyFfmpeg(input: string, against: string) {
  const [a, b] = await Promise.all([frameHashes(input), frameHashes(against)]);
  const mismatches = a.frames.flatMap((frame, i) => JSON.stringify(frame) === JSON.stringify(b.frames[i]) ? [] : [i]);
  return {
    decoder: 'ffmpeg', inputSha256: sha256(await fs.readFile(input)), outputSha256: sha256(await fs.readFile(against)),
    inputFrames: a.frames.length, outputFrames: b.frames.length, timebase: a.timebase,
    matched: a.timebase === b.timebase && a.frames.length === b.frames.length && mismatches.length === 0,
    mismatchedFrameIndexes: mismatches,
    scope: 'RGBA frame hashes and decoded timestamps/durations; raw GIF delay and loop metadata checked by the main pipeline',
  };
}
