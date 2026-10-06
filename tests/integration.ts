import type { AddressInfo } from 'node:net';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, readdir, readFile, writeFile, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes, randomUUID, scryptSync } from 'node:crypto';
import { createServer } from 'node:net';
import { request as httpRequest } from 'node:http';
import { DatabaseSync } from 'node:sqlite';

test('production storage API', { timeout: 120000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'pocket-drive-test-'));
  const password = randomBytes(20).toString('hex'); const salt = randomBytes(16).toString('hex');
  const probe = createServer(); await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = (probe.address() as AddressInfo).port; await new Promise<void>(resolve => probe.close(() => resolve()));
  const origin = `http://localhost:${port}`;
  const address = `http://127.0.0.1:${port}`;
  let processHandle; let output = '';
  const env = { ...process.env, NODE_ENV: 'production', APP_ORIGIN: origin, ADMIN_USERNAME: 'admin', ADMIN_PASSWORD_HASH: `scrypt:${salt}:${scryptSync(password, salt, 64).toString('hex')}`, SESSION_SECRET: randomBytes(32).toString('hex'), STORAGE_PATH: root, STORAGE_QUOTA_BYTES: '16384', MIN_FREE_DISK_BYTES: '0', MAX_FILE_BYTES: '4096', NEXT_TELEMETRY_DISABLED: '1' };
  async function start(overrides = {}) {
    processHandle = spawn(process.execPath, ['.next/standalone/server.js'], { env: { ...env, PORT: String(port), HOSTNAME: '127.0.0.1', ...overrides }, stdio: ['ignore', 'pipe', 'pipe'] });
    processHandle.stdout.on('data', chunk => { output += chunk; }); processHandle.stderr.on('data', chunk => { output += chunk; });
    for (let tries = 0; tries < 150; tries++) {
      try { const result = await fetch(address + '/api/health', { signal: AbortSignal.timeout(1000) }); if (result.ok) return; output += await result.text(); } catch {}
      if (processHandle.exitCode !== null) throw new Error(output);
      await new Promise<void>(resolve => setTimeout(resolve, 100));
    }
    throw new Error('Test server did not start: ' + output);
  }
  async function stop() {
    if (!processHandle || processHandle.exitCode !== null) return;
    const done = new Promise<void>(resolve => processHandle.once('exit', resolve)); processHandle.kill('SIGTERM'); await done;
  }
  t.after(async () => { await stop(); await rm(root, { recursive: true, force: true }); });
  const legacyId = '00000000-0000-4000-8000-000000000003';
  const legacy = new DatabaseSync(join(root, 'metadata.sqlite'));
  legacy.exec('CREATE TABLE files(id TEXT PRIMARY KEY, name TEXT NOT NULL, size INTEGER NOT NULL, mime_type TEXT NOT NULL, kind TEXT NOT NULL, checksum TEXT NOT NULL, created_at TEXT NOT NULL, deleting INTEGER NOT NULL DEFAULT 0)');
  legacy.prepare('INSERT INTO files VALUES (?, ?, 6, ?, ?, ?, ?, 0)').run(legacyId, 'legacy.txt', 'text/plain', 'document', createHash('sha256').update('legacy').digest('hex'), new Date().toISOString());
  legacy.close(); await mkdir(join(root, 'files')); await writeFile(join(root, 'files', legacyId), 'legacy');
  await start();
  let cookie; let token; let keyId;
  const send = (path, options: RequestInit = {}) => fetch(address + path, { signal: AbortSignal.timeout(10000), ...options });
  const session = (path, options: RequestInit = {}) => send(path, { ...options, headers: { Cookie: cookie, Origin: origin, ...options.headers } });
  const key = (path, options: RequestInit = {}) => send(path, { ...options, headers: { Authorization: `Bearer ${token}`, ...options.headers } });
  const multipart = (bytes, name = 'report.pdf', field = 'file') => { const data = new FormData(); data.append(field, new Blob([bytes]), name); return data; };
  const json = (value?: unknown) => ({ 'Content-Type': 'application/json' });
  await t.test('private routes and login / CSRF', async () => {
    assert.equal((await send('/api/files')).status, 401);
    assert.equal((await send('/files', { redirect: 'manual' })).status, 307);
    assert.equal((await send('/api/auth/login', { method: 'POST', headers: { ...json(), Origin: 'https://evil.example' }, body: JSON.stringify({ username: 'admin', password }) })).status, 403);
    assert.equal((await send('/api/auth/login', { method: 'POST', headers: { ...json(), Origin: origin }, body: JSON.stringify({ username: 'admin', password: 'wrong' }) })).status, 401);
    const result = await send('/api/auth/login', { method: 'POST', headers: { ...json(), Origin: origin }, body: JSON.stringify({ username: 'admin', password }) });
    assert.equal(result.status, 200); cookie = result.headers.get('set-cookie').split(';')[0];
    assert.match(result.headers.get('set-cookie'), /HttpOnly/); assert.match(result.headers.get('set-cookie'), /SameSite=Strict/);
    assert.equal((await send('/api/keys', { method: 'POST', headers: { ...json(), Cookie: cookie, Origin: 'https://evil.example' }, body: JSON.stringify({ name: 'bad' }) })).status, 403);
  });
  await t.test('scoped keys are hashed and managed only by sessions', async () => {
    const result = await session('/api/keys', { method: 'POST', headers: json(), body: JSON.stringify({ name: 'Test script', scopes: ['read', 'upload'] }) });
    assert.equal(result.status, 201); const created = await result.json(); token = created.token; keyId = created.id;
    assert.match(token, /^pd_[a-f0-9]{64}$/);
    const listed = await (await session('/api/keys')).json(); assert.equal(listed.keys[0].token, undefined); assert.equal(listed.keys[0].hash, undefined);
    assert.equal((await key('/api/keys')).status, 403);
    const database = new DatabaseSync(join(root, 'metadata.sqlite')); const saved = database.prepare('SELECT hash FROM api_keys').get(); assert.notEqual(saved.hash, token); database.close();
  });
  await t.test('existing v1 drives upgrade without losing their files', async () => {
    const listed = await (await key('/api/files?folder_id=root')).json(); assert.equal(listed.files[0].id, legacyId); assert.equal(listed.files[0].folder_id, null);
    assert.equal(await (await key(`/api/files/${legacyId}/download`)).text(), 'legacy');
    assert.equal((await session(`/api/files/${legacyId}`, { method: 'DELETE' })).status, 200);
  });
  let file;
  const content = Buffer.from('Private report contents\n');
  await t.test('streaming upload, metadata, checksum, filtering, private download and ranges', async () => {
    const result = await key('/api/files', { method: 'POST', body: multipart(content, 'report ü.pdf') });
    assert.equal(result.status, 201, JSON.stringify(await result.clone().json())); file = await result.json();
    assert.equal(file.name, 'report ü.pdf'); assert.equal(file.size, content.length); assert.equal(file.checksum, createHash('sha256').update(content).digest('hex'));
    assert.deepEqual(await readFile(join(root, 'files', file.id)), content);
    assert.equal((await (await key('/api/files?type=document&q=report')).json()).total, 1);
    assert.equal((await (await key('/api/files?q=%25')).json()).total, 0);
    assert.equal((await send(`/api/files/${file.id}/download`)).status, 401);
    const downloaded = await key(`/api/files/${file.id}/download`); assert.equal(downloaded.status, 200); assert.equal(downloaded.headers.get('content-type'), 'application/octet-stream'); assert.match(downloaded.headers.get('content-disposition'), /attachment/); assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), content);
    const ranged = await key(`/api/files/${file.id}/download`, { headers: { Range: 'bytes=0-6' } }); assert.equal(ranged.status, 206); assert.equal(await ranged.text(), 'Private');
    assert.equal((await key(`/api/files/${file.id}/download`, { headers: { Range: 'bytes=9999-' } })).status, 416);
    assert.equal((await key(`/api/files/${file.id}/download`, { method: 'HEAD' })).headers.get('content-length'), String(content.length));
    const usage = await (await key('/api/storage')).json(); assert.equal(usage.used_bytes, content.length); assert.equal(usage.reserved_bytes, 0);
  });
  await t.test('bad uploads, path filenames, binary files and zero-length files', async () => {
    assert.equal((await key('/api/files', { method: 'POST', body: multipart(Buffer.alloc(4097)) })).status, 413);
    assert.equal((await key('/api/files', { method: 'POST', body: multipart('bad', 'bad.txt', 'wrong') })).status, 400);
    const two = multipart('one'); two.append('file', new Blob(['two']), 'two.txt'); assert.equal((await key('/api/files', { method: 'POST', body: two })).status, 400);
    const malformed = await key('/api/files', { method: 'POST', headers: { 'Content-Type': 'multipart/form-data; boundary=abc' }, body: '--abc\r\nContent-Disposition: form-data; name="file"; filename="bad.txt"\r\n\r\nbad' }); assert.equal(malformed.status, 400);
    const empty = await key('/api/files', { method: 'POST', body: multipart('', 'empty.txt') }); assert.equal(empty.status, 201); const emptyFile = await empty.json(); assert.equal(await (await key(`/api/files/${emptyFile.id}/download`)).text(), '');
    const binary = await key('/api/files', { method: 'POST', body: multipart(Buffer.from([0, 255, 3]), '../../unsafe.bin') }); assert.equal(binary.status, 201); const safe = await binary.json(); assert.equal(safe.name, 'unsafe.bin');
    assert.equal((await key(`/api/files/${file.id}`, { method: 'DELETE' })).status, 403);
    for (const id of [emptyFile.id, safe.id]) assert.equal((await session(`/api/files/${id}`, { method: 'DELETE' })).status, 200);
    assert.equal((await readdir(join(root, 'tmp'))).length, 0);
    assert.equal((await (await key('/api/storage')).json()).reserved_bytes, 0);
  });
  await t.test('persistence across a restart and revocation', async () => {
    await stop(); await start();
    assert.deepEqual(Buffer.from(await (await key(`/api/files/${file.id}/download`)).arrayBuffer()), content);
    assert.equal((await session('/api/keys')).status, 200);
    assert.equal((await session(`/api/keys/${keyId}`, { method: 'DELETE' })).status, 200);
    assert.equal((await key('/api/files')).status, 401);
    const created = await (await session('/api/keys', { method: 'POST', headers: json(), body: JSON.stringify({ name: 'Quota tester', scopes: ['read', 'upload', 'delete'] }) })).json(); token = created.token;
  });
  await t.test('concurrent uploads respect the shared quota', async () => {
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => key('/api/files', { method: 'POST', body: multipart(Buffer.alloc(4096, i), `batch-${i}.bin`) })));
    assert(results.some(r => r.status === 201)); assert(results.some(r => r.status === 507));
    for (const result of results) assert([201, 507].includes(result.status), JSON.stringify(await result.clone().json()));
    const usage = await (await key('/api/storage')).json(); assert(usage.used_bytes <= 16384); assert.equal(usage.reserved_bytes, 0);
    const listed = await (await key('/api/files')).json(); for (const item of listed.files) assert.equal((await key(`/api/files/${item.id}`, { method: 'DELETE' })).status, 200);
    assert.equal((await (await key('/api/storage')).json()).used_bytes, 0);
  });
  let project; let nestedFile;
  await t.test('folder creation, hierarchy, uploads, and breadcrumb navigation', async () => {
    const result = await key('/api/folders', { method: 'POST', headers: json(), body: JSON.stringify({ name: 'Projects' }) });
    assert.equal(result.status, 201); project = await result.json();
    assert.equal((await key('/api/folders', { method: 'POST', headers: json(), body: JSON.stringify({ name: 'projects' }) })).status, 409);
    assert.equal((await key('/api/folders', { method: 'POST', headers: json(), body: JSON.stringify({ name: '../bad' }) })).status, 400);
    const uploaded = await key(`/api/files?folder_id=${project.id}&relative_path=${encodeURIComponent('Planning/Week 1/report.pdf')}`, { method: 'POST', body: multipart('folder report', 'report.pdf') });
    assert.equal(uploaded.status, 201, JSON.stringify(await uploaded.clone().json())); nestedFile = await uploaded.json();
    const rootList = await (await key('/api/files?folder_id=root')).json(); assert.equal(rootList.total, 0); assert.equal(rootList.folders[0].name, 'Projects');
    const nested = await (await key(`/api/files?folder_id=${nestedFile.folder_id}`)).json();
    assert.equal(nested.total, 1); assert.deepEqual(nested.breadcrumbs.map(f => f.name), ['Projects', 'Planning', 'Week 1']);
    assert.equal(await (await key(`/api/files/${nestedFile.id}/download`)).text(), 'folder report');
    const again = await key(`/api/files?folder_id=${project.id}&relative_path=${encodeURIComponent('Planning/Week 1/notes.txt')}`, { method: 'POST', body: multipart('notes', 'notes.txt') }); assert.equal(again.status, 201); assert.equal((await again.json()).folder_id, nestedFile.folder_id);
    const details = await (await key(`/api/folders/${project.id}`)).json(); assert.equal(details.folder_count, 2); assert.equal(details.file_count, 2); assert.equal(details.size, 18);
  });
  await t.test('folder paths are validated and folder permissions are enforced', async () => {
    for (const relative of ['../report.pdf', '/report.pdf', 'a//report.pdf', 'a\\report.pdf']) assert.equal((await key(`/api/files?relative_path=${encodeURIComponent(relative)}`, { method: 'POST', body: multipart('invalid') })).status, 400);
    assert.equal((await key(`/api/files?relative_path=${encodeURIComponent('Mismatch/different.pdf')}`, { method: 'POST', body: multipart('invalid') })).status, 400);
    assert.equal((await key('/api/files?folder_id=not-an-id')).status, 400);
    const read = await (await session('/api/keys', { method: 'POST', headers: json(), body: JSON.stringify({ name: 'read folders', scopes: ['read'] }) })).json();
    assert.equal((await send('/api/folders', { method: 'POST', headers: { ...json(), Authorization: `Bearer ${read.token}` }, body: JSON.stringify({ name: 'nope' }) })).status, 403);
    assert.equal((await send(`/api/folders/${project.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${read.token}` } })).status, 403);
    assert.equal((await (await key('/api/storage')).json()).reserved_bytes, 0);
  });
  await t.test('folders persist and recursive deletion releases quota without deleting other files', async () => {
    await stop(); await start();
    const persisted = await (await key(`/api/files?folder_id=${nestedFile.folder_id}`)).json(); assert.equal(persisted.total, 2);
    const outside = await (await key('/api/files', { method: 'POST', body: multipart('keep', 'keep.txt') })).json();
    assert.equal((await key(`/api/folders/${project.id}`, { method: 'DELETE' })).status, 200);
    assert.equal((await key(`/api/files/${nestedFile.id}/download`)).status, 404);
    assert.equal((await key(`/api/folders/${project.id}`)).status, 404);
    assert.equal((await (await key('/api/storage')).json()).used_bytes, 4);
    assert.equal(await (await key(`/api/files/${outside.id}/download`)).text(), 'keep');
    await key(`/api/files/${outside.id}`, { method: 'DELETE' });
    assert.equal((await key(`/api/files?folder_id=${project.id}`, { method: 'POST', body: multipart('bad') })).status, 404);
  });
  const requestJSON = (path, method, data) => key(path, { method, headers: json(), body: JSON.stringify(data) });
  const newFolder = async (name, parent_id = 'root') => { const result = await requestJSON('/api/folders', 'POST', { name, parent_id }); assert.equal(result.status, 201, JSON.stringify(await result.clone().json())); return result.json(); };
  const newFile = async (name, folder = 'root') => { const result = await key(`/api/files?folder_id=${folder}`, { method: 'POST', body: multipart('move contents', name) }); assert.equal(result.status, 201); return result.json(); };
  const ref = (item, type = 'file') => ({ id: item.id, type });
  let source; let destination; let sub; let movedFile; let otherFile;
  await t.test('folder tree, renaming and metadata-only batch moves preserve content and links', async () => {
    source = await newFolder('Source'); destination = await newFolder('Destination'); sub = await newFolder('Sub', source.id);
    movedFile = await newFile('before.txt', source.id); otherFile = await newFile('other.txt', source.id);
    const nestedMoveFile = await newFile('nested.txt', sub.id);
    const usage = await (await key('/api/storage')).json();
    assert.equal((await requestJSON(`/api/files/${movedFile.id}`, 'PATCH', { name: 'after.csv' })).status, 200);
    assert.equal((await requestJSON(`/api/folders/${sub.id}`, 'PATCH', { name: 'Renamed sub' })).status, 200);
    const move = await requestJSON('/api/items/move', 'POST', { items: [ref(movedFile), ref(sub, 'folder')], destination_id: destination.id });
    assert.equal(move.status, 200); assert.equal((await move.json()).moved, 2);
    const metadata = await (await key(`/api/files/${movedFile.id}`)).json(); assert.equal(metadata.folder_id, destination.id); assert.equal(metadata.name, 'after.csv'); assert.equal(metadata.kind, 'document'); assert.equal(metadata.checksum, movedFile.checksum);
    assert.equal(await (await key(`/api/files/${movedFile.id}/download`)).text(), 'move contents'); assert.equal(await readFile(join(root, 'files', movedFile.id), 'utf8'), 'move contents');
    const tree = await (await key('/api/folders/tree')).json(); assert.equal(tree.folders.find(folder => folder.id === sub.id).parent_id, destination.id);
    const nestedMoveListing = await (await key(`/api/files?folder_id=${sub.id}`)).json(); assert.deepEqual(nestedMoveListing.breadcrumbs.map(folder => folder.name), ['Destination','Renamed sub']); assert.equal(nestedMoveListing.files[0].id,nestedMoveFile.id); assert.equal(await (await key(`/api/files/${nestedMoveFile.id}/download`)).text(),'move contents');
    const after = await (await key('/api/storage')).json(); assert.equal(after.used_bytes, usage.used_bytes); assert.equal(after.file_count, usage.file_count);
    await stop(); await start(); assert.equal((await (await key(`/api/files/${movedFile.id}`)).json()).folder_id, destination.id);
  });
  await t.test('moves and renames reject conflicts, invalid paths, cycles and stale selections atomically', async () => {
    const clash = await newFile('other.txt', destination.id);
    const free = await newFile('free.txt', source.id);
    assert.equal((await requestJSON('/api/items/move', 'POST', { items: [ref(free), ref(otherFile)], destination_id: destination.id })).status, 409);
    assert.equal((await (await key(`/api/files/${free.id}`)).json()).folder_id, source.id);
    assert.equal((await requestJSON(`/api/files/${movedFile.id}`, 'PATCH', { name: 'other.txt' })).status, 409);
    for (const name of ['../bad', 'a\\b', '.', '']) assert.equal((await requestJSON(`/api/files/${movedFile.id}`, 'PATCH', { name })).status, 400);
    assert.equal((await requestJSON('/api/items/move', 'POST', { items: [ref(destination, 'folder')], destination_id: sub.id })).status, 400);
    assert.equal((await requestJSON('/api/items/move', 'POST', { items: [ref(destination, 'folder')], destination_id: destination.id })).status, 400);
    assert.equal((await requestJSON('/api/items/move', 'POST', { items: [ref(destination, 'folder'), ref(movedFile)], destination_id: source.id })).status, 400);
    const missing = {id:'00000000-0000-4000-8000-000000000099',type:'file'};
    assert.equal((await requestJSON('/api/items/move', 'POST', { items: [ref(free), missing], destination_id: destination.id })).status, 404);
    assert.equal((await requestJSON('/api/items/move', 'POST', { items: [ref(free), ref(free)], destination_id: destination.id })).status, 400);
    assert.equal((await requestJSON('/api/items/move', 'POST', { items: [ref(free)] })).status, 400);
    assert.equal((await requestJSON('/api/items/delete', 'POST', { items: [ref(free), missing] })).status, 404);
    assert.equal((await key(`/api/files/${free.id}/download`)).status, 200);
    assert.equal((await requestJSON(`/api/folders/${source.id}`, 'PATCH', { name: 'dEsTiNaTiOn' })).status, 409);
    const folderClash = await newFolder('Renamed sub', source.id);
    assert.equal((await requestJSON('/api/items/move', 'POST', { items: [ref(sub, 'folder')], destination_id: source.id })).status, 409);
    assert.equal((await requestJSON(`/api/folders/${folderClash.id}`, 'PATCH', { name: 'sOuRcE' })).status, 200);
    await key(`/api/files/${clash.id}`, {method:'DELETE'});
  });
  await t.test('folder moves enforce depth limits and renames and moves require write permission', async () => {
    let last = await newFolder('Deep'); const deep = last;
    for (let level = 2; level <= 32; level++) last = await newFolder(`Level ${level}`, last.id);
    assert.equal((await requestJSON('/api/items/move', 'POST', { items: [ref(sub, 'folder')], destination_id: last.id })).status, 400);
    const readKey = await (await session('/api/keys', {method:'POST',headers:json(),body:JSON.stringify({name:'Read-only moves',scopes:['read']})})).json();
    const denied = (path, method, data) => send(path,{method,headers:{...json(),Authorization:`Bearer ${readKey.token}`},body:JSON.stringify(data)});
    assert.equal((await denied('/api/items/move','POST',{items:[ref(movedFile)],destination_id:'root'})).status,403);
    assert.equal((await denied(`/api/files/${movedFile.id}`,'PATCH',{name:'no.txt'})).status,403);
    assert.equal((await denied(`/api/folders/${source.id}`,'PATCH',{name:'no'})).status,403);
    assert.equal((await denied('/api/items/delete','POST',{items:[ref(movedFile)]})).status,403);
    assert.equal((await send('/api/items/move',{method:'POST',headers:{...json(),Cookie:cookie,Origin:'https://evil.example'},body:JSON.stringify({items:[ref(movedFile)],destination_id:'root'})})).status,403);
    assert.equal((await requestJSON('/api/items/move','POST',{items:[ref(movedFile)],destination_id:'root'})).status,200);
    assert.equal((await (await key(`/api/files/${movedFile.id}`)).json()).folder_id,null);
    assert.equal((await key(`/api/folders/${deep.id}`,{method:'DELETE'})).status,200);
  });
  await t.test('bulk deletion removes nested contents and the SQLite notice is absent from app logs', async () => {
    assert.equal((await requestJSON('/api/items/delete','POST',{items:[ref(source,'folder'),ref(destination,'folder'),ref(movedFile)]})).status,200);
    assert.equal((await key(`/api/files/${movedFile.id}/download`)).status,404);
    assert.equal((await (await key('/api/storage')).json()).used_bytes,0);
    assert.equal((await (await key('/api/folders/tree')).json()).folders.length,0);
    assert(!output.includes('SQLite is an experimental feature'), output);
  });
  await t.test('private folder ZIP exports preserve nested, empty, Unicode and repeated files', async () => {
    const folder = await newFolder('Export résumé');
    const nested = await newFolder('Nested', folder.id); await newFolder('Empty', nested.id);
    const binary = Buffer.from([0, 255, 1, 2, 10, 13]);
    for (const [name, bytes, parent] of [['résumé.txt', 'hello', folder.id], ['same.txt', 'first', nested.id], ['same.txt', 'second', nested.id], ['zero.bin', '', nested.id], ['binary.bin', binary, nested.id]]) {
      assert.equal((await key(`/api/files?folder_id=${parent}`, { method: 'POST', body: multipart(bytes, name) })).status, 201);
    }
    const outside = await newFile('outside.txt');
    const usage = (await (await key('/api/storage')).json()).used_bytes;
    const url = `/api/folders/${folder.id}/download`;
    assert.equal((await send(url)).status, 401);
    const uploadOnly = await (await session('/api/keys', { method: 'POST', headers: json(), body: JSON.stringify({name:'ZIP denied',scopes:['upload']}) })).json();
    assert.equal((await send(url, {headers:{Authorization:`Bearer ${uploadOnly.token}`}})).status, 403);
    const readOnly = await (await session('/api/keys', { method: 'POST', headers: json(), body: JSON.stringify({name:'ZIP reader',scopes:['read']}) })).json();
    const head = await send(url, {method:'HEAD',headers:{Authorization:`Bearer ${readOnly.token}`}});
    assert.equal(head.status, 200); assert.equal(head.headers.get('content-type'), 'application/zip'); assert.equal((await head.arrayBuffer()).byteLength, 0);
    const result = await send(url, {headers:{Authorization:`Bearer ${readOnly.token}`}});
    assert.equal(result.status, 200); assert.match(result.headers.get('content-disposition'), /filename\*=UTF-8''Export%20r%C3%A9sum%C3%A9.zip/);
    assert.equal(result.headers.get('cache-control'), 'private, no-store');
    const archive = join(root, 'verify.zip'); await writeFile(archive, Buffer.from(await result.arrayBuffer()));
    const contents = JSON.parse(execFileSync('python3', ['-c', 'import zipfile,json,sys; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; print(json.dumps({i.filename:list(z.read(i)) for i in z.infolist()}))', archive], {encoding:'utf8'}));
    assert.deepEqual(Object.keys(contents).sort(), ['Export résumé/','Export résumé/Nested/','Export résumé/Nested/Empty/','Export résumé/Nested/binary.bin','Export résumé/Nested/same (2).txt','Export résumé/Nested/same.txt','Export résumé/Nested/zero.bin','Export résumé/résumé.txt'].sort());
    assert.deepEqual(contents['Export résumé/Nested/binary.bin'], [...binary]);
    assert.deepEqual(contents['Export résumé/Nested/zero.bin'], []);
    assert.equal(Buffer.from(contents['Export résumé/résumé.txt']).toString(), 'hello');
    assert.deepEqual(['Export résumé/Nested/same.txt','Export résumé/Nested/same (2).txt'].map(name => Buffer.from(contents[name]).toString()).sort(), ['first','second']);
    assert.equal((await (await key('/api/storage')).json()).used_bytes, usage);
    await rm(archive); assert.equal((await readdir(join(root,'tmp'))).length,0);
    assert.equal((await requestJSON(`/api/folders/${folder.id}`,'PATCH',{name:'Renamed export'})).status,200);
    const renamed = await session(url); assert.equal(renamed.status,200); assert.match(renamed.headers.get('content-disposition'),/Renamed%20export.zip/); await renamed.arrayBuffer();
    const missing = (await (await key(`/api/files?folder_id=${nested.id}`)).json()).files.find(file => file.name === 'binary.bin');
    const original = await readFile(join(root,'files',missing.id)); await rm(join(root,'files',missing.id));
    assert.equal((await key(url)).status,409); await writeFile(join(root,'files',missing.id),original);
    assert.equal((await key(`/api/folders/${folder.id}`,{method:'DELETE'})).status,200); assert.equal((await key(url)).status,404);
    await key(`/api/files/${outside.id}`,{method:'DELETE'});
    assert.equal((await (await key('/api/storage')).json()).used_bytes,0);
  });
  await t.test('selected ZIP downloads combine files and folders, deduplicate descendants and enforce read permissions', async () => {
    const left = await newFolder('Left'); const right = await newFolder('Right');
    const first = await newFolder('Shared',left.id); const second = await newFolder('Shared',right.id);
    const nested = await newFolder('Nested',first.id); await newFolder('Empty',nested.id);
    const inside = await newFile('inside.txt',nested.id); await newFile('other.txt',second.id);
    const duplicate1 = await newFile('same.txt'); const duplicate2 = await newFile('same.txt');
    const unselected = await newFile('not-selected.txt');
    const usage=(await (await key('/api/storage')).json()).used_bytes;
    const items=[ref(first,'folder'),ref(second,'folder'),ref(nested,'folder'),ref(inside),ref(duplicate1),ref(duplicate2)];
    const url='/api/items/download?'+new URLSearchParams({items:items.map(item=>item.type+':'+item.id).join(',')});
    assert.equal((await send(url)).status,401);
    const uploadOnly=await (await session('/api/keys',{method:'POST',headers:json(),body:JSON.stringify({name:'Selection denied',scopes:['upload']})})).json();
    const readOnly=await (await session('/api/keys',{method:'POST',headers:json(),body:JSON.stringify({name:'Selection reader',scopes:['read']})})).json();
    assert.equal((await send(url,{headers:{Authorization:`Bearer ${uploadOnly.token}`}})).status,403);
    assert.equal((await send('/api/items/download',{method:'POST',headers:{...json(),Authorization:`Bearer ${uploadOnly.token}`},body:JSON.stringify({items})})).status,403);
    const head=await key(url,{method:'HEAD'}); assert.equal(head.status,200); assert.equal((await head.arrayBuffer()).byteLength,0);
    const inspect=async response=>{
      assert.equal(response.status,200); assert.equal(response.headers.get('content-type'),'application/zip'); assert.match(response.headers.get('content-disposition'),/pocket-drive-selection.zip/);
      const archive=join(root,'selection.zip'); await writeFile(archive,Buffer.from(await response.arrayBuffer()));
      const contents=JSON.parse(execFileSync('python3',['-c','import zipfile,json,sys; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; print(json.dumps({i.filename:z.read(i).decode() for i in z.infolist()}))',archive],{encoding:'utf8'})); await rm(archive); return contents;
    };
    const contents=await inspect(await send(url,{headers:{Authorization:`Bearer ${readOnly.token}`}}));
    assert.deepEqual(Object.keys(contents).sort(),['Shared/','Shared/Nested/','Shared/Nested/Empty/','Shared/Nested/inside.txt','Shared (2)/','Shared (2)/other.txt','same.txt','same (2).txt'].sort());
    assert.equal(contents['Shared/Nested/inside.txt'],'move contents');
    assert.deepEqual(await inspect(await send('/api/items/download',{method:'POST',headers:{...json(),Authorization:`Bearer ${readOnly.token}`},body:JSON.stringify({items})})),contents);
    const filesOnly=await inspect(await requestJSON('/api/items/download','POST',{items:[ref(duplicate1),ref(duplicate2)]})); assert.deepEqual(Object.keys(filesOnly).sort(),['same (2).txt','same.txt']);
    assert.equal((await key('/api/items/download')).status,400);
    assert.equal((await key('/api/items/download?items=file:not-valid')).status,400);
    assert.equal((await key('/api/items/download?items='+encodeURIComponent('file:'+duplicate1.id+':extra'))).status,400);
    assert.equal((await requestJSON('/api/items/download','POST',{items:[ref(duplicate1),ref(duplicate1)]})).status,400);
    assert.equal((await requestJSON('/api/items/download','POST',{items:Array(101).fill(ref(duplicate1))})).status,400);
    assert.equal((await requestJSON('/api/items/download','POST',{items:[]})).status,400);
    assert.equal((await requestJSON('/api/items/download','POST',{items:[ref(duplicate1),{type:'file',id:'00000000-0000-4000-8000-000000000099'}]})).status,404);
    assert.equal((await send('/api/items/download',{method:'POST',headers:{...json(),Cookie:cookie,Origin:'https://evil.example'},body:JSON.stringify({items})})).status,403);
    assert.equal((await (await key('/api/storage')).json()).used_bytes,usage);
    await requestJSON('/api/items/delete','POST',{items:[ref(left,'folder'),ref(right,'folder'),ref(duplicate1),ref(duplicate2),ref(unselected)]});
    assert.equal((await (await key('/api/storage')).json()).used_bytes,0);
  });
  await t.test('resumable chunks survive restarts and lost acknowledgements without duplicates', async () => {
    const id = randomUUID(); const bytes = Buffer.from('recoverable file bytes');
    const create = (value = {}) => session('/api/uploads',{method:'POST',headers:json(),body:JSON.stringify({id,name:'resume.txt',size:bytes.length,relative_path:'Recovery/Nested/resume.txt',...value})});
    const chunk = (offset,data) => session(`/api/uploads/${id}`,{method:'PATCH',headers:{'Content-Type':'application/octet-stream','Upload-Offset':String(offset)},body:data});
    assert.equal((await create()).status,201); assert.equal((await create()).status,201);
    assert.equal((await create({name:'other.txt'})).status,400);
    assert.equal((await create({size:bytes.length+1})).status,409);
    assert.equal((await send('/api/uploads',{method:'POST',headers:{...json(),Cookie:cookie,Origin:'https://evil.example'},body:JSON.stringify({id:randomUUID(),name:'x',size:1})})).status,403);
    assert.equal((await (await session('/api/storage')).json()).reserved_bytes,bytes.length);
    assert.equal((await session(`/api/uploads/${id}/complete`,{method:'POST'})).status,409);
    assert.equal((await chunk(0,bytes.subarray(0,8))).status,200);
    assert.equal((await chunk(0,bytes.subarray(0,8))).status,409);
    assert.equal((await (await session(`/api/uploads/${id}`)).json()).offset,8);
    // Simulate an interrupted write beyond the durable offset. Recovery truncates it.
    await stop(); await writeFile(join(root,'tmp',id),Buffer.concat([bytes.subarray(0,8),Buffer.from('unconfirmed')])); await start();
    assert.equal((await (await session(`/api/uploads/${id}`)).json()).offset,8);
    assert.equal((await chunk(8,Buffer.alloc(bytes.length))).status,413);
    assert.equal((await readFile(join(root,'tmp',id))).length,8);
    const response = await chunk(8,bytes.subarray(8)); assert.equal(response.status,200); assert.equal((await response.json()).offset,bytes.length);
    assert.equal((await session(`/api/uploads/${id}/complete`,{method:'POST'})).status,200);
    assert.equal((await session(`/api/uploads/${id}/complete`,{method:'POST'})).status,200);
    assert.equal((await (await session(`/api/uploads/${id}`)).json()).status,'complete');
    assert.deepEqual(Buffer.from(await (await session(`/api/files/${id}/download`)).arrayBuffer()),bytes);
    const file = await (await session(`/api/files/${id}`)).json(); assert.equal(file.checksum,createHash('sha256').update(bytes).digest('hex'));
    assert.equal((await (await session('/api/storage')).json()).reserved_bytes,0);
    const folders = (await (await session('/api/folders')).json()).folders; const recovery = folders.find(folder => folder.name === 'Recovery');
    await session(`/api/folders/${recovery.id}`,{method:'DELETE'});
  });
  await t.test('resumable cancellation, leases, permission checks and finalization crash recovery', async () => {
    const make = async (name,size) => { const id=randomUUID(); const response=await session('/api/uploads',{method:'POST',headers:json(),body:JSON.stringify({id,name,size})}); assert.equal(response.status,201); return id; };
    const id=await make('cancel.bin',50);
    const readKey=await (await session('/api/keys',{method:'POST',headers:json(),body:JSON.stringify({name:'Resume read only',scopes:['read']})})).json();
    assert.equal((await send(`/api/uploads/${id}`,{headers:{Authorization:`Bearer ${readKey.token}`}})).status,403);
    const uploadKey=await (await session('/api/keys',{method:'POST',headers:json(),body:JSON.stringify({name:'Resume upload',scopes:['upload']})})).json();
    assert.equal((await send(`/api/uploads/${id}`,{headers:{Authorization:`Bearer ${uploadKey.token}`}})).status,200);
    // Interrupt an actual in-flight body. Unconfirmed bytes must be discarded.
    const partial=httpRequest(address+`/api/uploads/${id}`,{method:'PATCH',headers:{Cookie:cookie,Origin:origin,'Content-Type':'application/octet-stream','Upload-Offset':'0','Content-Length':'50'}});
    partial.on('error',()=>{}); partial.write('unconfirmed');
    try {
      let busy=false;
      for(let i=0;i<40;i++){busy=(await (await session(`/api/uploads/${id}`)).json()).busy;if(busy)break;await new Promise<void>(resolve =>setTimeout(resolve,25));}
      assert(busy);
      assert.equal((await session(`/api/uploads/${id}`,{method:'PATCH',headers:{'Content-Type':'application/octet-stream','Upload-Offset':'0'},body:'competing'})).status,409);
    } finally { partial.destroy(); }
    let resumed;
    for(let i=0;i<40;i++){resumed=await (await session(`/api/uploads/${id}`)).json();if(!resumed.busy)break;await new Promise<void>(resolve =>setTimeout(resolve,25));}
    assert.equal(resumed.busy,false);assert.equal(resumed.offset,0);assert.equal((await readFile(join(root,'tmp',id))).length,0);
    const database=new DatabaseSync(join(root,'metadata.sqlite'));
    database.prepare('UPDATE uploads SET lease_token=?,lease_until=? WHERE id=?').run(randomUUID(),Date.now()+60000,id);
    assert.equal((await session(`/api/uploads/${id}`,{method:'PATCH',headers:{'Content-Type':'application/octet-stream','Upload-Offset':'0'},body:'partial'})).status,409);
    assert.equal((await session(`/api/uploads/${id}`,{method:'DELETE'})).status,409);
    database.prepare('UPDATE uploads SET lease_until=0 WHERE id=?').run(id);
    assert.equal((await session(`/api/uploads/${id}`,{method:'PATCH',headers:{'Content-Type':'application/octet-stream','Upload-Offset':'0'},body:'partial'})).status,200);
    assert.equal((await session(`/api/uploads/${id}`,{method:'DELETE'})).status,200);
    assert.equal((await session(`/api/uploads/${id}`)).status,404);
    assert.equal((await session('/api/uploads',{method:'POST',headers:json(),body:JSON.stringify({id,name:'cancel.bin',size:50})})).status,410);
    const late=randomUUID();assert.equal((await session(`/api/uploads/${late}`,{method:'DELETE'})).status,404);
    assert.equal((await session('/api/uploads',{method:'POST',headers:json(),body:JSON.stringify({id:late,name:'late.bin',size:10})})).status,410);
    assert.equal((await (await session('/api/storage')).json()).reserved_bytes,0);
    assert(!((await readdir(join(root,'tmp'))).includes(id)));
    const empty=await make('zero.bin',0); database.prepare("UPDATE uploads SET status='finalizing' WHERE id=?").run(empty);
    assert.equal((await session(`/api/uploads/${empty}/complete`,{method:'POST'})).status,200);
    const moved=await make('renamed.bin',3);
    assert.equal((await session(`/api/uploads/${moved}`,{method:'PATCH',headers:{'Content-Type':'application/octet-stream','Upload-Offset':'0'},body:'abc'})).status,200);
    database.prepare("UPDATE uploads SET status='finalizing' WHERE id=?").run(moved);
    await rename(join(root,'tmp',moved),join(root,'files',moved));
    assert.equal((await session(`/api/uploads/${moved}/complete`,{method:'POST'})).status,200);
    assert.equal((await session(`/api/uploads/${moved}`,{method:'DELETE'})).status,200);
    assert.equal((await session(`/api/files/${moved}`)).status,200);
    // Completed files can still recover a lost acknowledgement after session expiry.
    database.prepare('DELETE FROM uploads WHERE id=?').run(moved);
    assert.equal((await (await session(`/api/uploads/${moved}`)).json()).status,'complete');
    for(const file of [empty,moved]) await session(`/api/files/${file}`,{method:'DELETE'});
    const expired=await make('expired.bin',4); database.prepare('UPDATE reservations SET expires=0 WHERE id=?').run(expired); database.prepare('UPDATE uploads SET expires=0 WHERE id=?').run(expired); database.close();
    await writeFile(join(root,'tmp',expired),'part'); await session('/api/storage');
    assert.equal((await session(`/api/uploads/${expired}`)).status,404); assert(!((await readdir(join(root,'tmp'))).includes(expired)));
  });
  await t.test('crash recovery removes expired partials and interrupted deletions', async () => {
    await stop();
    const database = new DatabaseSync(join(root, 'metadata.sqlite'));
    const orphan = '00000000-0000-4000-8000-000000000001'; const pendingDelete = '00000000-0000-4000-8000-000000000002';
    database.prepare('INSERT INTO reservations(id, bytes, expires) VALUES (?, 100, 0)').run(orphan);
    database.prepare('INSERT INTO files(id, name, size, mime_type, kind, checksum, created_at, deleting) VALUES (?, ?, 3, ?, ?, ?, ?, 1)').run(pendingDelete, 'delete.bin', 'application/octet-stream', 'other', 'checksum', new Date().toISOString()); database.close();
    await writeFile(join(root, 'tmp', orphan), 'part'); await writeFile(join(root, 'files', orphan), 'orphan'); await writeFile(join(root, 'files', pendingDelete), 'del');
    await start(); const usage = await (await key('/api/storage')).json(); assert.equal(usage.used_bytes, 0); assert.equal(usage.reserved_bytes, 0);
    assert.deepEqual(await readdir(join(root, 'tmp')), []); assert.deepEqual(await readdir(join(root, 'files')), []);
  });
  await t.test('server disk reserve blocks uploads', async () => {
    await stop(); await start({ MIN_FREE_DISK_BYTES: String(Number.MAX_SAFE_INTEGER) });
    assert.equal((await key('/api/files', { method: 'POST', body: multipart('test') })).status, 507);
    assert.equal((await (await key('/api/storage')).json()).available_bytes, 0);
    await stop(); await start();
  });
  await t.test('logout revokes the session and login throttling is enforced', async () => {
    assert.equal((await session('/api/auth/logout', { method: 'POST' })).status, 200);
    assert.equal((await session('/api/files')).status, 401);
    let response;
    for (let i = 0; i < 11; i++) response = await send('/api/auth/login', { method: 'POST', headers: { ...json(), Origin: origin }, body: JSON.stringify({ username: 'admin', password: 'wrong' }) });
    assert.equal(response.status, 429);
  });
});
