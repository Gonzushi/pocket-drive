import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, scryptSync } from 'node:crypto';
import { createServer } from 'node:net';
import ExcelJS from 'exceljs';
import { fakeWorker } from './assistant-worker.mjs';

function smallPDF() {
  const stream = 'BT /F1 12 Tf 72 720 Td (The orchard guide has budget 4200.) Tj ET';
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>', '<< /Length ' + stream.length + ' >>\nstream\n' + stream + '\nendstream', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  let pdf = '%PDF-1.4\n'; const offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(pdf)); pdf += (index + 1) + ' 0 obj\n' + object + '\nendobj\n'; });
  const start = Buffer.byteLength(pdf); pdf += 'xref\n0 6\n0000000000 65535 f \n' + offsets.slice(1).map(offset => String(offset).padStart(10, '0') + ' 00000 n \n').join('') + 'trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n' + start + '\n%%EOF\n';
  return Buffer.from(pdf);
}

test('personal assistant integration', { timeout: 120000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'pocket-assistant-'));
  const probe = createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve)); const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const origin = 'http://127.0.0.1:' + port; const secret = randomBytes(32).toString('hex'); const password = randomBytes(24).toString('hex'); const salt = randomBytes(16).toString('hex');
  const fixture = await fakeWorker(origin, secret); let child; let logs = '';
  const environment = { ...process.env, NODE_ENV: 'production', HOSTNAME: '127.0.0.1', PORT: String(port), APP_ORIGIN: origin, STORAGE_PATH: root, MIN_FREE_DISK_BYTES: '0', ADMIN_USERNAME: 'admin', ADMIN_PASSWORD_HASH: 'scrypt:' + salt + ':' + scryptSync(password, salt, 64).toString('hex'), SESSION_SECRET: randomBytes(32).toString('hex'), ASSISTANT_WORKER_URL: fixture.url, ASSISTANT_WORKER_SECRET: secret };
  async function start() {
    child = spawn(process.execPath, ['.next/standalone/server.js'], { env: environment, stdio: ['ignore', 'pipe', 'pipe'] }); child.stdout.on('data', data => logs += data); child.stderr.on('data', data => logs += data);
    for (let i = 0; i < 150; i++) { try { if ((await fetch(origin + '/api/health')).ok) return; } catch {} if (child.exitCode !== null) throw new Error(logs); await new Promise(resolve => setTimeout(resolve, 100)); } throw new Error(logs);
  }
  async function stop() { if (child?.exitCode === null) { const done = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGTERM'); await done; } }
  t.after(async () => { await stop(); await fixture.close(); await rm(root, { recursive: true, force: true }); }); await start();
  const login = await fetch(origin + '/api/auth/login', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password }) }); assert.equal(login.status, 200); const cookie = login.headers.get('set-cookie').split(';')[0];
  const request = (path, options = {}) => fetch(origin + '/api/assistant/' + path, { ...options, headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json', ...options.headers } });
  const post = (path, data = {}) => request(path, { method: 'POST', body: JSON.stringify(data) });
  async function upload(name, bytes) { const form = new FormData(); form.append('file', new Blob([bytes]), name); const response = await fetch(origin + '/api/files', { method: 'POST', headers: { Origin: origin, Cookie: cookie }, body: form }); assert.equal(response.status, 201, await response.clone().text()); return response.json(); }
  const file = await upload('project.txt', 'The orchard project has a launch date.\nBudget: 4200.');
  const workbook = new ExcelJS.Workbook(); workbook.addWorksheet('Expenses').addRows([['Name', 'Cost'], ['Orchard', 4200]]); await upload('budget.xlsx', await workbook.xlsx.writeBuffer());
  await upload('guide.pdf', smallPDF()); await upload('unknown.bin', Buffer.from([0, 255, 0, 1]));
  await upload('records.csv', 'Name,Notes,Cost\nOrchard,"A quoted\nmultiline note",4200\n');
  const chat = await (await post('chats')).json();
  async function send(text, organize = false) {
    const response = await post('chats/' + chat.id + '/messages', { text, organize }); assert.equal(response.status, 202, await response.clone().text()); const { run } = await response.json();
    for (let i = 0; i < 150; i++) { const value = await (await request('chats/' + chat.id)).json(); const current = value.runs.find(entry => entry.id === run.id); if (current.status !== 'running') { assert.equal(current.status, 'completed', JSON.stringify(value)); return value; } await new Promise(resolve => setTimeout(resolve, 100)); }
    throw new Error('Reply timed out: ' + logs);
  }
  await t.test('requires website authentication, origin and per-run capabilities', async () => {
    assert.equal((await fetch(origin + '/api/assistant/status')).status, 401);
    assert.equal((await request('chats', { method: 'POST', headers: { Origin: 'https://evil.example' } })).status, 403);
    assert.equal((await post('tools', { tool: 'search_files', arguments: { query: '' } })).status, 401);
    const keyResponse = await fetch(origin + '/api/keys', { method: 'POST', headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'reader', scopes: ['read'] }) }); const key = await keyResponse.json();
    assert.equal((await request('status', { headers: { Authorization: 'Bearer ' + key.token } })).status, 403);
  });
  await t.test('streams and persists a sourced document answer without browser connection', async () => {
    const snapshot = await send('Read project.txt'); assert.match(snapshot.messages.at(-1).text, /orchard/);
    const source = snapshot.events.find(entry => entry.kind === 'tool' && entry.data.sources?.some(source => source.id === file.id)); assert(source); assert.equal(source.data.sources[0].location, 'My files');
    assert.match(fixture.results.find(result => result.tool === 'read_document').value.sections[0].text, /Budget: 4200/);
    const old = fixture.requests.find(request => request.runId); const denied = await post('tools', { tool: 'search_files', arguments: { query: '' } }); assert.equal(denied.status, 401);
    const expired = await request('tools', { method: 'POST', headers: { Authorization: 'Bearer ' + old.capability }, body: JSON.stringify({ tool: 'search_files', arguments: { query: '' } }) }); assert.equal(expired.status, 403);
  });
  await t.test('indexes content and resumes the same Codex thread', async () => { await send('content search orchard'); assert.equal(fixture.requests.filter(request => request.runId).at(-1).threadId, 'fixture-thread-001'); assert(fixture.results.filter(result => result.tool === 'search_files').at(-1).value.content_matches.some(match => match.file.id === file.id)); });
  await t.test('extracts real XLSX sheet names, rows and values in a bounded subprocess', async () => { await send('Read spreadsheet budget.xlsx'); const document = fixture.results.filter(result => result.tool === 'read_document').at(-1).value; assert.match(document.sections[0].label, /Sheet Expenses/); assert.match(document.sections[0].text, /4200/); });
  await t.test('extracts PDF text with exact page citations and reports unsupported files honestly', async () => { await send('Read pdf guide.pdf'); let document = fixture.results.filter(result => result.tool === 'read_document').at(-1).value; assert.equal(document.sections[0].label, 'Page 1'); assert.match(document.sections[0].text, /budget 4200/); await send('Read unsupported file'); document = fixture.results.filter(result => result.tool === 'read_document').at(-1).value; assert.equal(document.empty, true); assert.match(document.error, /not available yet/); });
  await t.test('CSV citations count quoted multiline records as one row', async () => { await send('Read csv records.csv'); const document = fixture.results.filter(result => result.tool === 'read_document').at(-1).value; assert.match(document.sections[0].text, /2: Orchard \| A quoted\nmultiline note \| 4200/); });
  await t.test('organization is disabled by default and enabled per message', async () => { await send('rename without permission'); assert.equal(fixture.results.at(-1).status, 403); await send('create my folder', true); assert.equal(fixture.results.at(-1).status, 200); assert.equal(fixture.results.at(-1).value.name, 'Assistant folder'); });
  await t.test('rejects malformed turns and unsafe queries without losing documents', async () => { assert.equal((await post('chats/' + chat.id + '/messages', { text: '', organize: true })).status, 400); assert.equal((await post('chats/' + chat.id + '/messages', { text: 'Hello', organize: 'yes' })).status, 400); assert.equal((await request('chats/bad')).status, 404); await send('content search orchard'); });
  await t.test('cancel revokes document access immediately and permits a subsequent turn', async () => { const response = await post('chats/' + chat.id + '/messages', { text: 'wait forever' }); assert.equal(response.status, 202); const { run } = await response.json(); assert.equal((await post('chats/' + chat.id + '/messages', { text: 'concurrent reply' })).status, 409); assert.equal((await post('runs/' + run.id + '/cancel')).status, 200); const value = await (await request('chats/' + chat.id)).json(); assert.equal(value.runs.find(entry => entry.id === run.id).status, 'interrupted'); await send('Read project.txt'); });
  await t.test('the drive enforces tool-call limits and escapes full-text search syntax', async () => {
    const response = await post('chats/' + chat.id + '/messages', { text: 'wait forever' }); const { run } = await response.json();
    for (let i = 0; i < 50 && !fixture.requests.some(entry => entry.runId === run.id); i++) await new Promise(resolve => setTimeout(resolve, 20));
    const cap = fixture.requests.find(entry => entry.runId === run.id).capability;
    const tool = data => request('tools', { method: 'POST', headers: { Authorization: 'Bearer ' + cap }, body: JSON.stringify(data) });
    for (let i = 0; i < 40; i++) assert.equal((await tool({ tool: 'search_files', arguments: { query: i === 0 ? '" OR * NEAR( DROP TABLE files' : 'orchard' } })).status, 200);
    assert.equal((await tool({ tool: 'read_document', arguments: { file_id: file.id } })).status, 429);
    await post('runs/' + run.id + '/cancel'); assert.equal((await tool({ tool: 'search_files', arguments: { query: 'orchard' } })).status, 403);
  });
  await t.test('older conversations paginate without losing source cards', async () => {
    for (let i = 0; i < 14; i++) await send('Read project.txt, history ' + i);
    const latest = await (await request('chats/' + chat.id)).json(); assert.equal(latest.messages.length, 50); assert.equal(latest.hasOlder, true);
    const older = await (await request('chats/' + chat.id + '?before=' + latest.before)).json(); assert(older.messages.length > 0); assert(older.events.some(entry => entry.data.sources?.some(source => source.id === file.id)));
    assert(!older.messages.some(message => latest.messages.some(current => current.id === message.id)));
    assert.equal((await request('chats/' + chat.id + '?before=-1')).status, 400);
  });
  await t.test('source cards reflect a file’s current location after organization', async () => {
    const folders = await (await fetch(origin + '/api/folders', { headers: { Cookie: cookie } })).json(); const destination = folders.folders.find(folder => folder.name === 'Assistant folder');
    const response = await fetch(origin + '/api/items/move', { method: 'POST', headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ items: [{ type: 'file', id: file.id }], destination_id: destination.id }) }); assert.equal(response.status, 200);
    const value = await (await request('chats/' + chat.id)).json(); const source = value.events.flatMap(event => event.data.sources || []).find(source => source.id === file.id); assert.equal(source.location, 'My files / Assistant folder'); assert.equal(source.folder_url, '/files?folder=' + destination.id);
  });
  await t.test('versions tools per conversation and refreshes stale threads', async () => {
    await stop();
    const sqlite = process.getBuiltinModule('node:sqlite'); const database = new sqlite.DatabaseSync(join(root, 'metadata.sqlite'));
    database.prepare("UPDATE assistant_chats SET toolset_version='1' WHERE id=?").run(chat.id); database.close();
    await start();
    const before = fixture.requests.length; await send('Read project.txt after tool refresh');
    const turn = fixture.requests.slice(before).find(entry => entry.runId); assert(turn); assert.equal(turn.threadId, null);
    assert.match(turn.text, /Previous Pocket Drive conversation context/); assert.match(turn.text, /Read project.txt after tool refresh/);
    const refreshed = await (await request('chats/' + chat.id)).json(); assert.equal(refreshed.chat.toolset_version, '2');
  });
  await t.test('retries a missing-tool reply once on a fresh Codex thread', async () => {
    const before = fixture.requests.length; const value = await send('simulate missing tool');
    const turns = fixture.requests.slice(before).filter(entry => entry.runId);
    assert.equal(turns.length, 2); assert(turns[0].threadId); assert.equal(turns[1].threadId, null);
    assert.match(value.messages.at(-1).text, /orchard/);
  });
  await t.test('conversation, thread ID, index and login session survive a server restart', async () => { await stop(); await start(); const value = await (await request('chats/' + chat.id)).json(); assert.equal(value.chat.thread_id, 'fixture-thread-001'); assert(value.messages.length > 10); assert((await (await request('status')).json()).index.indexed >= 2); await send('Read project.txt'); });
  await t.test('restart marks unfinished replies interrupted', async () => { await post('chats/' + chat.id + '/messages', { text: 'wait forever' }); await stop(); await start(); const value = await (await request('chats/' + chat.id)).json(); assert.equal(value.runs[0].status, 'interrupted'); });
  await t.test('deletes a saved conversation and its history', async () => {
    const response = await request('chats/' + chat.id, { method: 'DELETE' }); assert.equal(response.status, 200, await response.clone().text()); assert.deepEqual(await response.json(), { success: true });
    assert.equal((await request('chats/' + chat.id)).status, 404);
    const list = await (await request('chats')).json(); assert(!list.chats.some(entry => entry.id === chat.id));
  });
});
