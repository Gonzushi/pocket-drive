import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { once, EventEmitter } from 'node:events';
import { Codex, productionCodex } from './protocol.mjs';
import { createWorker } from './server.mjs';
import { createServer } from 'node:http';

test('Codex subprocess preserves HTTPS trust and routing without inheriting application secrets', async t => {
  const home = await mkdtemp(tmpdir() + '/pocket-codex-network-');
  const settings = {
    CODEX_STATE_PATH: home, PATH: process.env.PATH,
    HTTPS_PROXY: 'http://proxy.example:8080', NO_PROXY: 'drive,localhost',
    https_proxy: 'http://proxy.example:8080', no_proxy: 'drive,localhost',
    CODEX_CA_CERTIFICATE: '/custom/root.pem', SSL_CERT_FILE: '/etc/ssl/certs/ca-certificates.crt', SSL_CERT_DIR: '/etc/ssl/certs',
    ASSISTANT_WORKER_SECRET: 'must-not-reach-codex', OPENAI_API_KEY: 'must-not-reach-codex',
    NODE_TLS_REJECT_UNAUTHORIZED: '0'
  };
  const production = productionCodex(settings);
  const client = new Codex(process.execPath, [fileURLToPath(new URL('./fixture.mjs', import.meta.url))], production.environment);
  t.after(async () => { const stopped = client.child && once(client, 'stopped'); client.stop(); if (stopped) await stopped; await rm(home, { recursive: true, force: true }); });
  await client.start();
  const actual = await client.call('environment');
  for (const name of ['HTTPS_PROXY', 'NO_PROXY', 'https_proxy', 'no_proxy', 'CODEX_CA_CERTIFICATE', 'SSL_CERT_FILE', 'SSL_CERT_DIR']) assert.equal(actual[name], settings[name]);
  assert.equal(actual.HOME, home); assert.equal(actual.CODEX_HOME, home + '/codex');
  for (const name of ['ASSISTANT_WORKER_SECRET', 'OPENAI_API_KEY', 'NODE_TLS_REJECT_UNAUTHORIZED']) assert.equal(actual[name], undefined);
});

test('Codex JSON-RPC transport handles concurrent calls, streaming, server tools and process failure', async t => {
  const home = await mkdtemp(tmpdir() + '/pocket-codex-');
  const client = new Codex(process.execPath, [fileURLToPath(new URL('./fixture.mjs', import.meta.url))], { PATH: process.env.PATH, HOME: home, CODEX_HOME: home + '/codex' });
  t.after(async () => { client.stop(); await rm(home, { recursive: true, force: true }); });
  await Promise.all([client.start(), client.start()]);
  assert.deepEqual(await Promise.all([client.call('echo', { a: 1 }), client.call('echo', { a: 2 })]), [{ echo: { a: 1 } }, { echo: { a: 2 } }]);
  const notification = once(client, 'notification'); const request = once(client, 'request');
  await client.call('events'); assert.equal((await notification)[0].params.delta, 'hello');
  const tool = (await request)[0]; assert.equal(tool.params.tool, 'search_files'); client.reply(tool.id, { success: true, contentItems: [{ type: 'inputText', text: '{}' }] });
  await assert.rejects(client.call('error'), /Expected fixture error/);
  const pending = client.call('never'); const stopped = once(client, 'stopped'); client.send({ method: 'break' }); await assert.rejects(pending, /Codex stopped/); await stopped;
  await client.start(); assert.deepEqual(await client.call('echo', { restored: true }), { echo: { restored: true } });
});

test('private worker enforces personal auth, exact model, bounded tools and native approval denial', async t => {
  const calls = []; const replies = []; const denied = []; let account = null; let threadCount = 0; let toolResult;
  class Fixture extends EventEmitter {
    async start() {}
    stop() {}
    send(message) { denied.push(message); }
    reply(id, value) { replies.push({ id, value }); toolResult?.(); }
    async call(method, params) {
      calls.push({ method, params });
      if (method === 'account/read') return { account };
      if (method === 'account/login/start') return { verificationUrl: 'https://auth.openai.com/codex/device', userCode: 'CODE-TEST', loginId: 'private-login-id' };
      if (method === 'account/logout') { account = null; return {}; }
      if (method === 'thread/start' || method === 'thread/resume') return { thread: { id: 'thread-' + ++threadCount } };
      if (method === 'turn/start') {
        setTimeout(async () => {
          const threadId = params.threadId;
          this.emit('notification', { method: 'turn/started', params: { threadId, turn: { id: 'turn-1' } } });
          this.emit('request', { id: 'shell-1', method: 'item/commandExecution/requestApproval', params: { threadId } });
          await new Promise(resolve => { toolResult = resolve; this.emit('request', { id: 'tool-1', method: 'item/tool/call', params: { threadId, tool: 'search_files', arguments: { query: 'project' } } }); });
          this.emit('notification', { method: 'item/agentMessage/delta', params: { threadId, turnId: 'turn-1', delta: 'A sourced answer.' } });
          this.emit('notification', { method: 'turn/completed', params: { threadId, turn: { id: 'turn-1', status: 'completed' } } });
        }, 10);
        return { turn: { id: 'turn-1' } };
      }
      return {};
    }
  }
  const toolRequests = [];
  const callback = createServer(async (request, response) => { let body = ''; for await (const part of request) body += part; toolRequests.push({ auth: request.headers.authorization, body: JSON.parse(body) }); response.setHeader('Content-Type', 'application/json'); response.end('{"files":[]}'); });
  await new Promise(resolve => callback.listen(0, '127.0.0.1', resolve));
  const client = new Fixture(); const secret = 'test-secret-'.repeat(5);
  const worker = createWorker(client, { secret, callback: 'http://127.0.0.1:' + callback.address().port });
  await new Promise(resolve => worker.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await worker.close(); await new Promise(resolve => { callback.closeAllConnections(); callback.close(resolve); }); });
  const origin = 'http://127.0.0.1:' + worker.server.address().port;
  const request = (url, data) => fetch(origin + url, { method: data ? 'POST' : 'GET', headers: { Authorization: 'Bearer ' + secret, 'Content-Type': 'application/json' }, body: data ? JSON.stringify(data) : undefined });
  assert.equal((await fetch(origin + '/status')).status, 401);
  assert.equal((await (await request('/status')).json()).connected, false);
  const turn = { runId: 'run-1', capability: 'signed-run-capability', text: 'Summarize my files', instructions: 'Use documents only.', tools: [{ type: 'function', name: 'search_files', description: 'Search', inputSchema: { type: 'object' } }] };
  assert.equal((await request('/turn', turn)).status, 409);
  account = { type: 'apiKey' }; assert.equal((await request('/turn', turn)).status, 409);
  const login = await (await request('/login', {})).json(); assert.equal(login.userCode, 'CODE-TEST'); assert.equal(login.loginId, undefined);
  account = { type: 'chatgpt', email: 'test@example.com', planType: 'plus', accessToken: 'NEVER-EXPOSE' };
  const status = await (await request('/status')).json(); assert.equal(status.connected, true); assert.equal(status.account.accessToken, undefined);
  const response = await request('/turn', turn); assert.equal(response.status, 200); const events = (await response.text()).trim().split('\n').map(JSON.parse);
  assert.equal(events.at(-1).status, 'completed'); assert.equal(events.find(event => event.type === 'delta').text, 'A sourced answer.');
  const start = calls.find(call => call.method === 'thread/start').params; assert.equal(start.model, 'gpt-6.1-sol'); assert.equal(start.sandbox, 'read-only'); assert.equal(start.approvalPolicy, 'never'); assert.deepEqual(start.dynamicTools, turn.tools);
  const inference = calls.find(call => call.method === 'turn/start').params; assert.equal(inference.model, 'gpt-6.1-sol'); assert.equal(inference.effort, 'medium');
  assert.equal(toolRequests[0].auth, 'Bearer signed-run-capability'); assert.equal(replies[0].value.success, true); assert.equal(replies[0].value.contentItems[0].type, 'inputText'); assert.equal(denied[0].error.code, -32601);
  const resumed = await request('/turn', { ...turn, runId: 'run-2', threadId: 'thread-1', text: 'Count my videos' });
  assert.equal(resumed.status, 200); await resumed.text();
  const resume = calls.find(call => call.method === 'thread/resume').params;
  assert.equal(resume.threadId, 'thread-1'); assert.deepEqual(resume.dynamicTools, turn.tools);
});
