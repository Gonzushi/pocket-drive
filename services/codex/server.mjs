import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { productionCodex } from './protocol.mjs';
import { fileURLToPath } from 'node:url';

export function createWorker(codex, { secret, callback, statePath = '/state' }) {
if (secret.length < 32) throw new Error('ASSISTANT_WORKER_SECRET must contain at least 32 characters.');
callback = new URL(callback);
if (!['http:', 'https:'].includes(callback.protocol) || callback.username || callback.password) throw new Error('Invalid POCKET_DRIVE_URL.');
let active = null; let login = null;
function equal(a, b) { const x = Buffer.from(a); const y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); }
function json(response, status, value) { response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(value)); }
function emit(value) { if (active && !active.response.destroyed) active.response.write(JSON.stringify(value) + '\n'); }
function finish(status, error) {
  if (!active) return;
  const current = active; emit({ type: 'completed', status, error }); clearTimeout(current.timer); active = null; current.response.end();
}
async function cancel() {
  if (!active) return;
  if (active.turnId) await codex.call('turn/interrupt', { threadId: active.threadId, turnId: active.turnId }).catch(() => {});
  finish('interrupted', 'Reply stopped.');
}
codex.on('stopped', () => finish('failed', 'Codex restarted. Send a new message to continue.'));
codex.on('notification', ({ method, params }) => {
  if (method === 'account/login/completed') login = null;
  if (!active || params?.threadId !== active.threadId) return;
  if (active.turnId && (params.turnId || params.turn?.id) && (params.turnId || params.turn?.id) !== active.turnId) return;
  if (method === 'turn/started') active.turnId = params.turn?.id;
  if (method === 'item/agentMessage/delta') emit({ type: 'delta', text: params.delta });
  if (method === 'turn/completed') finish(params.turn?.status || 'failed', params.turn?.error?.message?.slice(0, 500));
});
codex.on('request', async request => {
  const current = active;
  if (request.method !== 'item/tool/call' || !current || request.params?.threadId !== current.threadId) {
    // Fail closed for native shell, file writes, permissions, or interactive questions.
    codex.send({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Only Pocket Drive tools are permitted.' } });
    return;
  }
  let success = false; let result;
  try {
    if (++current.calls > 40) throw new Error('The reply reached its document-tool limit.');
    const tool = request.params.tool;
    if (!current.tools.some(entry => entry.name === tool)) throw new Error('This tool is not available.');
    emit({ type: 'activity', tool });
    const response = await fetch(new URL('/api/assistant/tools', callback), { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + current.capability }, body: JSON.stringify({ tool, arguments: request.params.arguments }), signal: AbortSignal.timeout(90000) });
    result = await response.json(); success = response.ok;
    if (active !== current) throw new Error('Reply stopped.');
  } catch (error) { result = { error: error.message }; }
  try { codex.reply(request.id, { contentItems: [{ type: 'inputText', text: JSON.stringify(result) }], success }); } catch {}
});
async function read(request) {
  let size = 0; const chunks = [];
  for await (const chunk of request) { size += chunk.length; if (size > 128 * 1024) throw new Error('Request is too large.'); chunks.push(chunk); }
  const result = JSON.parse(Buffer.concat(chunks).toString());
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('Invalid request.'); return result;
}
const server = http.createServer(async (request, response) => {
  if (!equal(request.headers.authorization || '', 'Bearer ' + secret)) { json(response, 401, { error: 'Unauthorized.' }); return; }
  try {
    await codex.start();
    if (request.url === '/status' && request.method === 'GET') {
      const result = await codex.call('account/read', { refreshToken: false });
      const account = result.account;
      json(response, 200, { connected: account?.type === 'chatgpt', account: account?.type === 'chatgpt' ? { email: account.email, plan: account.planType } : null, model: 'gpt-6.1-sol', effort: 'medium', busy: Boolean(active), login }); return;
    }
    if (request.url === '/login' && request.method === 'POST') {
      if (active) { json(response, 409, { error: 'Stop the reply before signing in.' }); return; }
      if (!login) {
        const result = await codex.call('account/login/start', { type: 'chatgptDeviceCode' });
        const url = new URL(result.verificationUrl);
        if (url.protocol !== 'https:' || url.hostname !== 'auth.openai.com') throw new Error('Unexpected sign-in address.');
        login = { verificationUrl: url.href, userCode: result.userCode };
        setTimeout(() => { login = null; }, 15 * 60000).unref();
      }
      json(response, 200, login); return;
    }
    if (request.url === '/logout' && request.method === 'POST') { await cancel(); await codex.call('account/logout'); login = null; json(response, 200, { success: true }); return; }
    if (request.url === '/cancel' && request.method === 'POST') { const data = await read(request); if (active?.runId === data.runId) await cancel(); json(response, 200, { success: true }); return; }
    if (request.url === '/turn' && request.method === 'POST') {
      if (active) { json(response, 409, { error: 'Codex is already replying.' }); return; }
      const data = await read(request);
      const account = (await codex.call('account/read', { refreshToken: false })).account;
      if (account?.type !== 'chatgpt') { json(response, 409, { error: 'Connect your personal Codex account first.' }); return; }
      if (active) { json(response, 409, { error: 'Codex is already replying.' }); return; }
      if (typeof data.text !== 'string' || data.text.length > 12000 || !Array.isArray(data.tools) || typeof data.capability !== 'string' || typeof data.runId !== 'string') { json(response, 400, { error: 'Invalid turn request.' }); return; }
      const settings = { model: 'gpt-6.1-sol', sandbox: 'read-only', approvalPolicy: 'never', cwd: statePath + '/workspace', developerInstructions: data.instructions };
      active = { response, runId: data.runId, capability: data.capability, tools: data.tools, calls: 0, threadId: null, turnId: null, timer: setTimeout(() => { void cancel(); }, 8 * 60000) };
      try {
        const result = await codex.call(data.threadId ? 'thread/resume' : 'thread/start', data.threadId ? { ...settings, threadId: data.threadId, excludeTurns: true, dynamicTools: data.tools } : { ...settings, dynamicTools: data.tools });
        active.threadId = result.thread.id;
        response.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store' }); emit({ type: 'thread', id: active.threadId });
        response.once('close', () => { if (active?.response === response) void cancel(); });
        const turn = await codex.call('turn/start', { threadId: active.threadId, model: 'gpt-6.1-sol', effort: 'medium', input: [{ type: 'text', text: data.text, text_elements: [] }] });
        if (active?.response === response) active.turnId = turn.turn.id;
      } catch (error) { if (!response.headersSent) { clearTimeout(active?.timer); active = null; throw error; } finish('failed', error.message); }
      return;
    }
    json(response, 404, { error: 'Endpoint not found.' });
  } catch (error) { if (!response.headersSent) json(response, 502, { error: String(error.message).slice(0, 500) }); else response.end(); }
});
server.requestTimeout = 600000;
return { server, async close() { await cancel(); codex.stop(); await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }); } };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const worker = createWorker(productionCodex(), { secret: process.env.ASSISTANT_WORKER_SECRET || '', callback: process.env.POCKET_DRIVE_URL || 'http://drive:3000', statePath: process.env.CODEX_STATE_PATH || '/state' });
  worker.server.listen(Number(process.env.PORT || 4400), '0.0.0.0');
  process.on('SIGTERM', async () => { await worker.close(); });
}
