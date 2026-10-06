// Uses the installed Codex executable, with temporary state and no account login.
// Run during the image build to catch startup errors before deployment.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { productionCodex } from './protocol.ts';
import { createWorker } from './server.ts';
import type { AddressInfo } from 'node:net';
import { documentToolSmoke } from './tool-smoke.ts';

const state = await mkdtemp(join(tmpdir(), 'pocket-codex-smoke-'));
const codex = productionCodex({ PATH: process.env.PATH, CODEX_STATE_PATH: state });
const secret = 'temporary-build-smoke-secret-'.repeat(2);
const worker = createWorker(codex, { secret, callback: 'http://127.0.0.1:3000', statePath: state });
try {
  worker.server.listen(0, '127.0.0.1');
  await once(worker.server, 'listening');
  const address = worker.server.address() as AddressInfo;
  const response = await fetch(`http://127.0.0.1:${address.port}/status`, {
    headers: { Authorization: 'Bearer ' + secret },
    signal: AbortSignal.timeout(55000),
  });
  if (!response.ok)
    throw new Error('Worker startup smoke check failed: ' + (await response.text()));
  const status = (await response.json()) as { connected: boolean; model: string; effort: string };
  if (status.connected !== false || status.model !== 'gpt-6.1-sol' || status.effort !== 'medium')
    throw new Error('Unexpected initial worker status.');
  console.log('Codex worker startup and authenticated status endpoint passed.');
} finally {
  const stopped = codex.child?.exitCode === null ? once(codex, 'stopped') : null;
  await worker.close();
  if (stopped) await stopped;
  await rm(state, { recursive: true, force: true });
}

await documentToolSmoke();
