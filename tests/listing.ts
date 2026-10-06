import type { AddressInfo } from 'node:net';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, scryptSync } from 'node:crypto';
import { createServer } from 'node:net';

test('scoped search and server-side sorting', { timeout: 120000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'pocket-listing-'));
  const probe = createServer(); await new Promise<void>(r => probe.listen(0, '127.0.0.1', r)); const port = (probe.address() as AddressInfo).port; await new Promise<void>(r => probe.close(() => r()));
  const origin = `http://127.0.0.1:${port}`; const password = randomBytes(24).toString('hex'); const salt = randomBytes(16).toString('hex');
  const child = spawn(process.execPath, ['.next/standalone/server.js'], { env: { ...process.env, NODE_ENV: 'production', HOSTNAME: '127.0.0.1', PORT: String(port), APP_ORIGIN: origin, STORAGE_PATH: root, MIN_FREE_DISK_BYTES: '0', ADMIN_USERNAME: 'admin', ADMIN_PASSWORD_HASH: `scrypt:${salt}:${scryptSync(password, salt, 64).toString('hex')}`, SESSION_SECRET: randomBytes(32).toString('hex') }, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = ''; child.stdout.on('data', d => logs += d); child.stderr.on('data', d => logs += d);
  t.after(async () => { if (child.exitCode === null) { const done = new Promise<void>(r => child.once('exit', r)); child.kill('SIGTERM'); await done; } await rm(root, { recursive: true, force: true }); });
  for (let i = 0; i < 150; i++) { try { if ((await fetch(origin + '/api/health')).ok) break; } catch {} if (child.exitCode !== null) throw new Error(logs); await new Promise<void>(r => setTimeout(r, 100)); }
  const login = await fetch(origin + '/api/auth/login', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password }) }); assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const session = (path, options: RequestInit = {}) => fetch(origin + path, { ...options, headers: { Cookie: cookie, Origin: origin, ...options.headers } });
  const post = async (path, body) => { const r = await session(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); assert.equal(r.status, 201, await r.clone().text()); return r.json(); };
  const folder = async (name, parent_id = 'root') => post('/api/folders', { name, parent_id });
  const upload = async (name, size, folder_id = 'root') => { const form = new FormData(); form.append('file', new Blob([Buffer.alloc(size, 65)]), name); const r = await session(`/api/files?folder_id=${folder_id}`, { method: 'POST', body: form }); assert.equal(r.status, 201, await r.clone().text()); return r.json(); };
  const list = async params => { const r = await session('/api/files?' + new URLSearchParams(params)); assert.equal(r.status, 200, await r.clone().text()); return r.json(); };
  const a = await folder('Alpha'); const z = await folder('Zulu'); const nested = await folder('Nested', a.id); const leaf = await folder('Deep', nested.id);
  for (let i = 54; i >= 0; i--) await upload(`report-${String(i).padStart(2, '0')}.txt`, i + 1);
  await upload('report-inside.csv', 60, a.id); await upload('report-nested.txt', 61, nested.id); await upload('report-deep.pdf', 62, leaf.id); await upload('report-other.zip', 63, z.id);
  await t.test('sorts complete results before pagination with stable tie breaks', async () => {
    const first = await list({ folder_id: 'root', sort: 'name', order: 'asc' }); const second = await list({ folder_id: 'root', sort: 'name', order: 'asc', offset: '50' });
    assert.equal(first.total, 55); assert.equal(first.files.length, 50); assert.equal(second.files.length, 5); assert.equal(first.files[0].name, 'report-00.txt'); assert.equal(second.files[4].name, 'report-54.txt');
    assert.equal(new Set([...first.files, ...second.files].map(f => f.id)).size, 55); assert.deepEqual(first.folders.map(f => f.name), ['Alpha', 'Zulu']);
    assert.equal((await list({ folder_id: 'root', sort: 'name', order: 'desc' })).files[0].name, 'report-54.txt');
    for (const order of ['asc', 'desc']) { const result = await list({ folder_id: 'root', sort: 'size', order }); assert.equal(result.files[0].size, order === 'asc' ? 1 : 55); }
    for (const order of ['asc', 'desc']) { const result = await list({ scope: 'drive', sort: 'date', order }); const dates = result.files.map(f => f.created_at); assert.deepEqual(dates, [...dates].sort((a, b) => order === 'asc' ? a.localeCompare(b) : b.localeCompare(a))); }
    assert.equal((await list({ scope: 'drive', sort: 'type', order: 'asc' })).files[0].name, 'report-inside.csv');
    assert.equal((await list({ scope: 'drive', sort: 'type', order: 'desc' })).files[0].name, 'report-other.zip');
  });
  await t.test('folder, recursive and drive searches isolate the correct locations', async () => {
    assert.equal((await list({ folder_id: a.id, q: 'report' })).total, 1);
    const recursive = await list({ folder_id: a.id, recursive: '1', q: 'report' }); assert.equal(recursive.total, 3); assert(!recursive.files.some(f => f.folder_id === z.id));
    assert.equal((await list({ folder_id: 'root', recursive: '1', q: 'report' })).total, 59);
    assert.equal((await list({ folder_id: a.id, scope: 'drive', q: 'REPORT' })).total, 59);
    assert.equal((await list({ q: 'report' })).total, 59); // Legacy API clients still get a drive-wide file listing.
    assert.deepEqual((await list({ folder_id: a.id, recursive: '1' })).folders.map(f => f.name).sort(), ['Deep', 'Nested']);
    assert.equal((await list({ folder_id: a.id, recursive: '1', type: 'document' })).folders.length, 0);
    const global = await list({ scope: 'drive', q: 'deep' }); assert.equal(global.files[0].location, 'My files / Alpha / Nested / Deep'); assert.equal(global.folders[0].location, 'My files / Alpha / Nested');
  });
  await t.test('paths reflect renaming and moves without changing file identity', async () => {
    const original = (await list({ scope: 'drive', q: 'report-deep' })).files[0];
    assert.equal((await session(`/api/folders/${a.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Renamed' }) })).status, 200);
    assert.equal((await list({ scope: 'drive', q: 'report-deep' })).files[0].location, 'My files / Renamed / Nested / Deep');
    const r = await session('/api/items/move', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items: [{ type: 'folder', id: nested.id }], destination_id: z.id }) }); assert.equal(r.status, 200, await r.clone().text());
    const moved = (await list({ scope: 'drive', q: 'report-deep' })).files[0]; assert.equal(moved.id, original.id); assert.equal(moved.location, 'My files / Zulu / Nested / Deep');
  });
  await t.test('literal wildcards, malicious queries and invalid options are safe', async () => {
    await upload('literal%_file.txt', 4); assert.equal((await list({ scope: 'drive', q: '%_' })).total, 1); assert.equal((await list({ scope: 'drive', q: "' OR 1=1 --" })).total, 0);
    for (const params of [{ sort: 'name;DROP TABLE files' }, { order: 'bad' }, { scope: 'bad' }, { recursive: 'true' }, { offset: '-1' }, { type: 'bad' }, { folder_id: 'bad' }]) assert.equal((await session('/api/files?' + new URLSearchParams(params))).status, 400);
    assert.equal((await session('/api/files?folder_id=00000000-0000-4000-8000-000000000001')).status, 404);
  });
  await t.test('search requires read permission', async () => {
    assert.equal((await fetch(origin + '/api/files?scope=drive')).status, 401);
    const key = await post('/api/keys', { name: 'upload only', scopes: ['upload'] });
    assert.equal((await fetch(origin + '/api/files?scope=drive', { headers: { Authorization: `Bearer ${key.token}` } })).status, 403);
    const reader = await post('/api/keys', { name: 'read only', scopes: ['read'] });
    assert.equal((await fetch(origin + '/api/files?scope=drive', { headers: { Authorization: `Bearer ${reader.token}` } })).status, 200);
  });
});
