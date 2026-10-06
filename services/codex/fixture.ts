import { createInterface } from 'node:readline';
createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line); if (!message.method) return;
  if (message.method === 'never') return;
  if (message.method === 'break') { process.exit(1); return; }
  if (message.method === 'environment') { process.stdout.write(JSON.stringify({ id: message.id, result: process.env }) + '\n'); return; }
  if (message.method === 'error') { process.stdout.write(JSON.stringify({ id: message.id, error: { code: -1, message: 'Expected fixture error' } }) + '\n'); return; }
  if (message.id !== undefined) process.stdout.write(JSON.stringify({ id: message.id, result: message.method === 'initialize' ? { userAgent: 'fixture' } : { echo: message.params } }) + '\n');
  if (message.method === 'events') {
    process.stdout.write(JSON.stringify({ method: 'item/agentMessage/delta', params: { threadId: 'test', delta: 'hello' } }) + '\n');
    process.stdout.write(JSON.stringify({ id: 'tool-1', method: 'item/tool/call', params: { threadId: 'test', tool: 'search_files', arguments: { query: 'invoice' } } }) + '\n');
  }
});
