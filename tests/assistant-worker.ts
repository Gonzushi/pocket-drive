import type { AddressInfo } from 'node:net';
import { createServer } from 'node:http';

// Deterministic transport fixture. It never impersonates a real model in production.
export async function fakeWorker(origin: any, secret: any) {
  const requests: any[] = [];
  const results: any[] = [];
  let connected = true;
  let active: any;
  const server = createServer(async (request, response) => {
    if (request.headers.authorization !== 'Bearer ' + secret) {
      response.writeHead(401);
      response.end('{}');
      return;
    }
    if (request.url === '/status') {
      response.setHeader('Content-Type', 'application/json');
      response.end(
        JSON.stringify({
          connected,
          model: 'gpt-6.1-sol',
          effort: 'medium',
          account: connected ? { email: 'test@example.com', plan: 'plus' } : null,
        }),
      );
      return;
    }
    if (request.url === '/login') {
      connected = true;
      response.end(
        JSON.stringify({
          verificationUrl: 'https://auth.openai.com/codex/device',
          userCode: 'TEST-CODE',
        }),
      );
      return;
    }
    if (request.url === '/logout') {
      connected = false;
      response.end('{"success":true}');
      return;
    }
    let input = '';
    for await (const part of request) input += part;
    const data = JSON.parse(input);
    requests.push(data);
    if (request.url === '/cancel') {
      active?.end(JSON.stringify({ type: 'completed', status: 'interrupted' }) + '\n');
      active = null;
      response.end('{"success":true}');
      return;
    }
    if (request.url !== '/turn') {
      response.writeHead(404);
      response.end('{}');
      return;
    }
    response.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
    active = response;
    response.write(
      JSON.stringify({ type: 'thread', id: data.threadId || 'fixture-thread-001' }) + '\n',
    );
    async function tool(name: any, args: any) {
      response.write(JSON.stringify({ type: 'activity', tool: name }) + '\n');
      const reply = await fetch(origin + '/api/assistant/tools', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + data.capability, 'Content-Type': 'application/json' },
        body: JSON.stringify({ tool: name, arguments: args }),
      });
      const value = await reply.json();
      results.push({ tool: name, status: reply.status, value });
      return value;
    }
    try {
      if (data.text.includes('wait forever')) return;
      if (data.text.includes('simulate missing tool') && data.threadId) {
        response.end(
          JSON.stringify({
            type: 'delta',
            text: 'The document-reading tool is currently unavailable.',
          }) +
            '\n' +
            JSON.stringify({ type: 'completed', status: 'completed' }) +
            '\n',
        );
        return;
      }
      if (data.text.includes('rename without permission'))
        await tool('create_folder', { name: 'Forbidden' });
      else if (data.text.includes('create my folder'))
        await tool('create_folder', { name: 'Assistant folder' });
      else {
        const match = await tool('search_files', {
          query: data.text.includes('content search')
            ? 'orchard'
            : data.text.includes('spreadsheet')
              ? 'budget.xlsx'
              : data.text.includes('csv')
                ? 'records.csv'
                : data.text.includes('pdf')
                  ? 'guide.pdf'
                  : data.text.includes('unsupported')
                    ? 'unknown.bin'
                    : 'project.txt',
        });
        const id = match.files?.[0]?.id || match.content_matches?.[0]?.file?.id;
        if (id) await tool('read_document', { file_id: id });
      }
      response.write(
        JSON.stringify({ type: 'delta', text: 'The project document says **orchard**. ' }) + '\n',
      );
      await new Promise<void>((resolve) => setTimeout(resolve, 250));
      if (response.destroyed) return;
      response.end(
        JSON.stringify({ type: 'delta', text: 'Source: project.txt, Lines 1–2.' }) +
          '\n' +
          JSON.stringify({ type: 'completed', status: 'completed' }) +
          '\n',
      );
    } catch (error) {
      if (!response.destroyed)
        response.end(
          JSON.stringify({
            type: 'completed',
            status: 'failed',
            error: error instanceof Error ? error.message : String(error),
          }) + '\n',
        );
    } finally {
      if (active === response) active = null;
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    server,
    requests,
    results,
    url: 'http://127.0.0.1:' + (server.address() as AddressInfo).port,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
