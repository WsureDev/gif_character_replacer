import { parentPort, workerData } from 'node:worker_threads';
import { calculateMotionJob, type MotionJob } from './motion-metrics.js';

parentPort!.postMessage(calculateMotionJob(workerData as MotionJob));
