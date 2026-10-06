import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { deduplicatePreloads } from './node-options.ts';

const require = createRequire(import.meta.url);
const normalized = deduplicatePreloads(process.env.NODE_OPTIONS);
const env = { ...process.env };
if (normalized.removed) {
  env.NODE_OPTIONS = normalized.options;
  console.log(
    'Removed duplicate Node preload entries for this launch. All unique hooks remain enabled.',
  );
}
const child = spawn(
  process.execPath,
  [require.resolve('next/dist/bin/next'), 'dev', ...process.argv.slice(2)],
  {
    env,
    stdio: 'inherit',
  },
);
child.on('error', (error) => {
  console.error('Could not start Pocket Drive:', error.message);
  process.exitCode = 1;
});
child.on('exit', (code, signal) => {
  process.exitCode = code ?? (signal === 'SIGINT' ? 130 : 1);
});
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (child.exitCode === null && child.signalCode === null) child.kill(signal);
  });
}
