import fs from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { inspectGif } from './gif.js';
import { extract, pack, split, assemble, roundtrip, batch } from './pipeline.js';
import { DEFAULT_LAYOUT } from './types.js';
import { verifyFfmpeg } from './verify-ffmpeg.js';
import { writeJson } from './manifests.js';
import { checkAi, readAiConfig } from './ai-config.js';
import { prepareAiPlan } from './ai-plan.js';
import { runImageEdit } from './ai-run.js';
import { recoverImageEdit } from './ai-recover.js';
import { buildAiReport } from './ai-report.js';
import { prepareAdaptivePlans } from './adaptive-layout.js';
import { assembleAiBatches } from './ai-assemble.js';

const help = `GIF character replacer

npm run cli -- inspect   --input source.gif
npm run cli -- extract   --input source.gif --out /tmp/task/frames
npm run cli -- pack      --input /tmp/task/frames/animation.json --out /tmp/task/sheets
npm run cli -- split     --input /tmp/task/sheets/sheets.json --out /tmp/task/restored
npm run cli -- assemble  --input /tmp/task/restored/animation.json --out /tmp/task/result.gif
npm run cli -- roundtrip --input source.gif --out /tmp/task/run
npm run cli -- batch     --input-dir ./materials/gifs --out /tmp/task/batch
npm run cli -- verify    --input source.gif --against result.gif --out /tmp/task/independent-check.json
npm run cli -- ai-check  --env .env
npm run cli -- ai-plan   --input frames/animation.json --reference character.png --frames 25 --columns 5 --size 1280x1280 --gutter 8 --margin 12 --subject "the central character" --out /tmp/task/plan
npm run cli -- ai-edit   --input /tmp/task/plan/plan.json --out /tmp/task/edit --env .env
npm run cli -- ai-recover --input /tmp/task/plan/plan.json --against /tmp/task/edit/edited-sheet.png --out /tmp/task/recovered
npm run cli -- ai-report --input-dir /tmp/task/experiments --out /tmp/task/experiments/report
npm run cli -- ai-auto-plan --input frames/animation.json --reference character.png --output-min 1024x1024 --output-max 1536x1536 --min-scale 1 --out /tmp/task/batches
npm run cli -- ai-assemble --input /tmp/task/bundle.json --out /tmp/task/final

Layout: --columns 3 --batch-size 9 --gutter 16 --margin 16
Offline pack/split retain native frame size; AI plans calculate scaled cells separately.
Output paths must be new. assemble/roundtrip/batch accept --allow-quantization.
split accepts --edited-dir DIR with the same sheet filenames; it checks size and
opaque-frame alpha, but does not certify edited layout/character quality.
Only ai-check and ai-edit read .env. ai-edit sends ONE billable edit request with retries disabled.
ai-plan is offline; omit --size to choose a geometry heuristic (not a quality guarantee).
ai-assemble is offline; complete batches retain source order, delays and loop, with palette quantization.
`;

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    input: { type: 'string' }, out: { type: 'string' }, 'input-dir': { type: 'string' },
    'edited-dir': { type: 'string' }, columns: { type: 'string' }, 'batch-size': { type: 'string' },
    gutter: { type: 'string' }, margin: { type: 'string' }, 'allow-quantization': { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
    against: { type: 'string' },
    env: { type: 'string' }, reference: { type: 'string', multiple: true },
    frames: { type: 'string' }, start: { type: 'string' }, size: { type: 'string' },
    subject: { type: 'string' }, 'character-notes': { type: 'string' },
    'extra-prompt': { type: 'string' }, 'prompt-version': { type: 'string' },
    'output-min': { type: 'string' }, 'output-max': { type: 'string' }, 'min-scale': { type: 'string' }, 'max-frames': { type: 'string' },
  } });
  if (values.help || positionals.length === 0) { console.log(help); return; }
  if (positionals.length !== 1) throw new Error('Provide exactly one command.');
  const required = (key: 'input' | 'out' | 'input-dir') => {
    const value = values[key];
    if (!value) throw new Error(`Missing --${key}`);
    return value;
  };
  const options = {
    columns: Number(values.columns ?? DEFAULT_LAYOUT.columns), batchSize: Number(values['batch-size'] ?? DEFAULT_LAYOUT.batchSize),
    gutter: Number(values.gutter ?? DEFAULT_LAYOUT.gutter), margin: Number(values.margin ?? DEFAULT_LAYOUT.margin),
  };
  let result: unknown;
  switch (positionals[0]) {
    case 'ai-assemble': result = await assembleAiBatches(required('input'), required('out')); break;
    case 'ai-auto-plan': {
      const dimensions = (value: string) => {
        if (!/^\d+x\d+$/.test(value)) throw new Error('Output range bounds must be WIDTHxHEIGHT.');
        return value.split('x').map(Number) as [number, number];
      };
      const [minWidth, minHeight] = dimensions(values['output-min'] ?? '1024x1024');
      const [maxWidth, maxHeight] = dimensions(values['output-max'] ?? '1536x1536');
      result = await prepareAdaptivePlans({ input: required('input'), reference: values.reference ?? [], out: required('out'),
        output: { minWidth, minHeight, maxWidth, maxHeight }, minScale: Number(values['min-scale'] ?? 1),
        gutter: Number(values.gutter ?? 8), margin: Number(values.margin ?? 12),
        maxFramesPerSheet: values['max-frames'] === undefined ? undefined : Number(values['max-frames']),
        subject: values.subject ?? 'the main character', characterNotes: values['character-notes'] ?? 'Match the reference character, preserving the source action and background.',
        extraPrompt: values['extra-prompt'] });
      break;
    }
    case 'ai-report': result = await buildAiReport(required('input-dir'), required('out')); break;
    case 'ai-recover': {
      if (!values.against) throw new Error('Missing --against edited sheet PNG');
      result = await recoverImageEdit(required('input'), values.against, required('out'));
      break;
    }
    case 'ai-check': result = await checkAi(await readAiConfig(values.env)); break;
    case 'ai-plan':
      if (values.frames === undefined) throw new Error('ai-plan requires --frames for a fixed experiment; use ai-auto-plan for automatic capacity.');
      result = await prepareAiPlan({
      input: required('input'), out: required('out'), reference: values.reference ?? [],
      frameCount: Number(values.frames), startFrame: Number(values.start ?? 0), size: values.size,
      columns: values.columns === undefined ? undefined : Number(values.columns),
      gutter: values.gutter === undefined ? undefined : Number(values.gutter),
      margin: values.margin === undefined ? undefined : Number(values.margin),
      subject: values.subject ?? 'the main character', characterNotes: values['character-notes'] ?? 'Match the provided character reference exactly.',
      extraPrompt: values['extra-prompt'], promptVersion: values['prompt-version'],
    }); break;
    case 'ai-edit': {
      const edited = await runImageEdit(required('input'), required('out'), await readAiConfig(values.env));
      result = edited;
      if (!edited.validation.passed) process.exitCode = 2;
      break;
    }
    case 'inspect': result = inspectGif(await fs.readFile(required('input'))); break;
    case 'extract': result = await extract(required('input'), required('out')); break;
    case 'pack': result = await pack(required('input'), required('out'), options); break;
    case 'split': result = await split(required('input'), required('out'), values['edited-dir']); break;
    case 'assemble': result = await assemble(required('input'), required('out'), values['allow-quantization']); break;
    case 'roundtrip': result = await roundtrip(required('input'), required('out'), options, values['allow-quantization']); break;
    case 'verify': {
      if (!values.against) throw new Error('Missing --against');
      const report = await verifyFfmpeg(required('input'), values.against);
      await writeJson(required('out'), report);
      if (!report.matched) process.exitCode = 1;
      result = report;
      break;
    }
    case 'batch': {
      const report = await batch(required('input-dir'), required('out'), options, values['allow-quantization']);
      result = { cases: report.results.length, failed: report.results.filter(r => r.status === 'failed').length, report: `${required('out')}/batch-report.json` };
      if (report.results.some(r => r.status === 'failed')) process.exitCode = 1;
      break;
    }
    default: throw new Error(`Unknown command: ${positionals[0]}`);
  }
  console.log(JSON.stringify(result, null, 2));
}

main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
