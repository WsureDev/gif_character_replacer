import { analyzeAsset } from './motion-analysis.js';
import sharp from 'sharp';

sharp.concurrency(2);
if (!process.argv[2]) throw new Error('Missing asset directory.');
await analyzeAsset(process.argv[2]);
