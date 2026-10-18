import { runJob } from './lab-jobs.js';
import type { AiConfig } from './ai-config.js';

const [mode, root, id, envFile] = process.argv.slice(2);
if (!mode || !root || !id || !envFile) throw new Error('Missing job arguments.');
if (process.send) {
  const config = await new Promise<AiConfig | null>((resolve, reject) => {
    process.once('disconnect', () => reject(new Error('Web server disconnected before providing job configuration.')));
    process.once('message', (message: unknown) => {
      const input = message as { type?: string; config?: AiConfig | null };
      if (input.type !== 'job-config' || input.config === undefined) reject(new Error('Missing explicit provider configuration.'));
      else resolve(input.config);
    });
  });
  await runJob(mode, root, id, envFile, config);
} else await runJob(mode, root, id, envFile);
