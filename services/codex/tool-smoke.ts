// Exercise real Codex tool exposure and dispatch with a local Responses fixture.
// No OpenAI requests, account credentials, API keys or inference usage are needed.
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { productionCodex, POCKET_DRIVE_NAMESPACE } from './protocol.ts';
import { createWorker } from './server.ts';

interface ToolSpec { type: string; name?: string; tools?: ToolSpec[] }
interface ResponseItem { type: string; tools?: ToolSpec[]; call_id?: string; output?: unknown }
interface ModelRequest { tools?: ToolSpec[]; input?: ResponseItem[]; model?: string; reasoning?: { effort?: string } }
const origin = (server: Server) => 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
const listen = (server: Server) => new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const close = (server: Server) => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); });

export async function documentToolSmoke() {
  const state = await mkdtemp(join(tmpdir(), 'pocket-codex-tools-'));
  const requests: ModelRequest[] = [];
  const callbackRequests: { auth: string | undefined; tool: string; arguments: unknown }[] = [];
  const failures: Error[] = [];
  const document = { filename: '2025-09.pdf', sections: [{ label: 'Page 1', text: 'Fixture document: September revenue is 12345.' }] };
  const provider = createServer(async (request, response) => {
    try {
      assert.equal(request.url, '/responses');
      let body = ''; for await (const chunk of request) body += chunk;
      const value = JSON.parse(body) as ModelRequest;
      requests.push(value);
      const tools = [...(value.tools || []), ...(value.input || []).flatMap(item => item.type === 'additional_tools' ? item.tools || [] : [])];
      const drive = tools.find(tool => tool.type === 'namespace' && tool.name === POCKET_DRIVE_NAMESPACE);
      assert(drive?.tools?.some(tool => tool.name === 'read_document'), 'Codex did not expose read_document as a direct Pocket Drive tool.');
      assert.equal(value.model, 'gpt-6.1-sol');
      assert.equal(value.reasoning?.effort, 'medium');
      const toolCall = requests.length % 2 === 1;
      if (!toolCall) {
        const result = value.input?.find(item => item.type === 'function_call_output' && item.call_id === 'read-pdf');
        assert(result && JSON.stringify(result.output).includes(document.sections[0].text), 'Document contents did not reach the model.');
      }
      const item = toolCall
        ? { type: 'function_call', id: 'fc_' + requests.length, call_id: 'read-pdf', namespace: POCKET_DRIVE_NAMESPACE, name: 'read_document', arguments: JSON.stringify({ file_id: 'pdf-fixture' }) }
        : { type: 'message', id: 'msg_' + requests.length, role: 'assistant', content: [{ type: 'output_text', text: 'September revenue is 12345 (2025-09.pdf, Page 1).' }] };
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      for (const event of [
        { type: 'response.created', response: { id: 'response_' + requests.length } },
        { type: 'response.output_item.added', output_index: 0, item },
        ...(!toolCall ? [{ type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: 'September revenue is 12345 (2025-09.pdf, Page 1).' }] : []),
        { type: 'response.output_item.done', output_index: 0, item },
        { type: 'response.completed', response: { id: 'response_' + requests.length, status: 'completed', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }
      ]) response.write('data: ' + JSON.stringify(event) + '\n\n');
      response.end();
    } catch (error) {
      failures.push(error instanceof Error ? error : new Error(String(error)));
      response.writeHead(500); response.end('Tool smoke check failed.');
    }
  });
  const callback = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk;
    callbackRequests.push({ auth: request.headers.authorization, ...JSON.parse(body) });
    response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(document));
  });
  await listen(provider); await listen(callback);
  const codex = productionCodex({ PATH: '/usr/bin:' + process.env.PATH, CODEX_STATE_PATH: state });
  // Avoid project discovery and external model/plugin discovery in this isolated fixture.
  codex.args.push('-c', 'project_doc_max_bytes=0', '-c', 'model_provider="fixture"',
    '-c', 'model_providers.fixture.name="Local smoke fixture"',
    '-c', `model_providers.fixture.base_url="${origin(provider)}"`,
    '-c', 'model_providers.fixture.wire_api="responses"',
    '-c', 'model_providers.fixture.requires_openai_auth=false');
  const secret = 'local-tool-smoke-secret-'.repeat(2);
  // Account gating is covered separately by worker tests; only account/read is stubbed.
  // Thread registration, model requests, tool RPCs and worker callbacks use real Codex.
  const call = codex.call.bind(codex);
  codex.call = (method, params) => method === 'account/read'
    ? Promise.resolve({ account: { type: 'chatgpt', email: 'fixture@example.com', planType: 'plus' } })
    : call(method, params);
  const worker = createWorker(codex, { secret, callback: origin(callback), statePath: state });
  try {
    await listen(worker.server);
    let threadId: string | undefined;
    for (let turn = 0; turn < 2; turn++) {
      const response = await fetch(origin(worker.server) + '/turn', {
        method: 'POST', headers: { Authorization: 'Bearer ' + secret, 'Content-Type': 'application/json' },
        body: JSON.stringify({ threadId, runId: 'run-' + turn, capability: 'fixture-run-capability', text: 'Read 2025-09.pdf', instructions: 'Read the document using Pocket Drive tools.', tools: [
          { type: 'function', name: 'read_document', description: 'Read PDF text', inputSchema: { type: 'object', properties: { file_id: { type: 'string' } }, required: ['file_id'], additionalProperties: false } }
        ] }), signal: AbortSignal.timeout(30000)
      });
      assert.equal(response.status, 200, await response.clone().text());
      const events = (await response.text()).trim().split('\n').map(line => JSON.parse(line));
      assert.equal(events.at(-1).status, 'completed');
      assert(events.some(event => event.type === 'activity' && event.tool === 'read_document'));
      assert(events.filter(event => event.type === 'delta').map(event => event.text).join('').includes('September revenue is 12345'));
      const id = events.find(event => event.type === 'thread')?.id as string;
      assert(id); if (threadId) assert.equal(id, threadId); threadId = id;
    }
    assert.deepEqual(failures, []);
    assert.equal(requests.length, 4);
    assert.equal(callbackRequests.length, 2);
    for (const request of callbackRequests) {
      assert.equal(request.auth, 'Bearer fixture-run-capability');
      assert.equal(request.tool, 'read_document');
      assert.deepEqual(request.arguments, { file_id: 'pdf-fixture' });
    }
    console.log('Real Codex direct document tools, authenticated callbacks, returned text and resumed threads passed.');
  } finally {
    const stopped = codex.child?.exitCode === null ? once(codex, 'stopped') : null;
    const forceStop = setTimeout(() => codex.child?.kill('SIGKILL'), 2000);
    await worker.close(); if (stopped) await stopped; clearTimeout(forceStop);
    await close(provider); await close(callback); await rm(state, { recursive: true, force: true });
  }
}
