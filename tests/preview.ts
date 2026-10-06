import type { AddressInfo } from 'node:net';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, scryptSync } from 'node:crypto';
import { createServer } from 'node:net';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';

test('authenticated bounded previews', { timeout: 120000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pocket-preview-'));
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  const origin = `http://127.0.0.1:${port}`;
  const password = randomBytes(24).toString('hex');
  const salt = randomBytes(16).toString('hex');
  const sessionSecret = randomBytes(32).toString('hex');
  const launch = () =>
    spawn(process.execPath, ['.next/standalone/server.js'], {
      env: {
        ...process.env,
        NODE_ENV: 'production',
        HOSTNAME: '127.0.0.1',
        PORT: String(port),
        APP_ORIGIN: origin,
        STORAGE_PATH: root,
        MIN_FREE_DISK_BYTES: '0',
        ADMIN_USERNAME: 'admin',
        ADMIN_PASSWORD_HASH: `scrypt:${salt}:${scryptSync(password, salt, 64).toString('hex')}`,
        SESSION_SECRET: sessionSecret,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  let child = launch();
  let preparedDocument: any;
  let logs = '';
  child.stdout.on('data', (d) => (logs += d));
  child.stderr.on('data', (d) => (logs += d));
  t.after(async () => {
    if (child.exitCode === null) {
      const exit = new Promise<void>((resolve) => child.once('exit', resolve));
      child.kill('SIGTERM');
      await exit;
    }
    await rm(root, { recursive: true, force: true });
  });
  for (let i = 0; i < 150; i++) {
    try {
      if ((await fetch(origin + '/api/health')).ok) break;
    } catch {}
    if (child.exitCode !== null) throw new Error(logs);
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
  const login = await fetch(origin + '/api/auth/login', {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie')!.split(';')[0];
  const session = (path: any, options: RequestInit = {}) =>
    fetch(origin + path, {
      ...options,
      headers: { Cookie: cookie, Origin: origin, ...options.headers },
    });
  const upload = async (name: any, bytes: any) => {
    const form = new FormData();
    form.append('file', new Blob([bytes]), name);
    const response = await session('/api/files', { method: 'POST', body: form });
    assert.equal(response.status, 201, await response.clone().text());
    return response.json();
  };
  const createKey = async (scopes: any) =>
    (
      await (
        await session('/api/keys', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: scopes.join('-'), scopes }),
        })
      ).json()
    ).token;
  const readKey = await createKey(['read']);
  const uploadKey = await createKey(['upload']);
  const code = await upload(
    'CommonUtil.scala',
    'object Example { val x = "<script>alert(1)</script>" }\n',
  );
  await t.test('all preview routes enforce authentication and read scope', async () => {
    for (const suffix of ['', '/text', '/content', '/archive']) {
      const path = `/api/files/${code.id}/preview${suffix}`;
      assert.equal((await fetch(origin + path)).status, 401);
      assert.equal(
        (await fetch(origin + path, { headers: { Authorization: `Bearer ${uploadKey}` } })).status,
        403,
      );
    }
    assert.equal(
      (
        await fetch(origin + `/api/files/${code.id}/preview/text`, {
          headers: { Authorization: `Bearer ${readKey}` },
        })
      ).status,
      200,
    );
    assert.equal(
      (await session('/api/files/00000000-0000-4000-8000-000000000001/preview')).status,
      404,
    );
  });
  await t.test('code and active content return inert text without executing', async () => {
    const info = await (await session(`/api/files/${code.id}/preview`)).json();
    assert.equal(info.kind, 'text');
    const source = await session(`/api/files/${code.id}/preview/text`);
    assert.equal(
      (await source.json()).text,
      'object Example { val x = "<script>alert(1)</script>" }\n',
    );
    const html = await upload(
      'test.html',
      '<script>window.owned=true</script><img src=x onerror=alert(1)>',
    );
    assert.equal((await (await session(`/api/files/${html.id}/preview`)).json()).kind, 'text');
    assert.equal((await session(`/api/files/${html.id}/preview/content`)).status, 415);
    const svg = await upload('test.svg', '<svg onload="alert(1)"/>');
    assert.equal((await session(`/api/files/${svg.id}/preview/content`)).status, 415);
    const binary = await upload('binary.txt', Buffer.from([0, 255, 1]));
    assert.equal((await session(`/api/files/${binary.id}/preview/text`)).status, 415);
    const utf16 = await upload(
      'utf16.txt',
      Buffer.concat([Buffer.from([255, 254]), Buffer.from('Hello 世界', 'utf16le')]),
    );
    assert.equal(
      (await (await session(`/api/files/${utf16.id}/preview/text`)).json()).text,
      'Hello 世界',
    );
  });
  await t.test('large text is capped and truncation is explicit', async () => {
    const file = await upload('large.log', 'line\n'.repeat(150000));
    const value = await (await session(`/api/files/${file.id}/preview/text`)).json();
    assert.equal(value.truncated, true);
    assert(Buffer.byteLength(value.text) <= 512 * 1024);
    assert(value.text.endsWith('\n'));
  });
  await t.test('inline media ranges and HEAD preserve original downloads', async () => {
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jCKkAAAAASUVORK5CYII=',
      'base64',
    );
    const file = await upload('pixel.png', png);
    const response = await session(`/api/files/${file.id}/preview/content`);
    assert.equal(response.headers.get('content-type')!, 'image/png');
    assert.match(response.headers.get('content-disposition')!, /^inline/);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), png);
    const ranged = await session(`/api/files/${file.id}/preview/content`, {
      headers: { Range: 'bytes=0-7' },
    });
    assert.equal(ranged.status, 206);
    assert.deepEqual(Buffer.from(await ranged.arrayBuffer()), png.subarray(0, 8));
    const head = await session(`/api/files/${file.id}/preview/content`, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get('content-length')!, String(png.length));
    assert.equal(await head.text(), '');
    assert.equal(
      (
        await session(`/api/files/${file.id}/preview/content`, {
          headers: { Range: 'bytes=9999-' },
        })
      ).status,
      416,
    );
    const original = await session(`/api/files/${file.id}/download`);
    assert.equal(original.headers.get('content-type')!, 'application/octet-stream');
    assert.match(original.headers.get('content-disposition')!, /^attachment/);
    const fake = await upload('fake.png', '<script>alert(1)</script>');
    assert.equal((await session(`/api/files/${fake.id}/preview/content`)).status, 415);
    const wav = Buffer.alloc(48);
    wav.write('RIFF');
    wav.writeUInt32LE(40, 4);
    wav.write('WAVE', 8);
    const audio = await upload('sound.wav', wav);
    assert.equal(
      (await session(`/api/files/${audio.id}/preview/content`)).headers.get('content-type')!,
      'audio/wav',
    );
  });
  await t.test('CSV, Markdown and unknown files select the right viewer', async () => {
    for (const [name, content, kind] of [
      ['table.csv', 'name,value\n"hello, world",5\n', 'table'],
      ['note.md', '# Hello\n', 'markdown'],
      ['old.doc', 'binary', 'unsupported'],
      ['weird.bin', 'hello', 'unsupported'],
    ]) {
      const file = await upload(name, content);
      const info = await (await session(`/api/files/${file.id}/preview`)).json();
      assert.equal(info.kind, kind);
      assert.equal(info.supported, kind !== 'unsupported');
    }
  });
  await t.test('XLSX files validate before transfer and remain unchanged', async () => {
    const workbook = new ExcelJS.Workbook();
    workbook.addWorksheet('Summary').addRows([
      ['Metric', 'Value'],
      ['GMV', 1000],
    ]);
    workbook.addWorksheet('Details').addRow(['Date', 'Region']);
    const bytes = Buffer.from(await workbook.xlsx.writeBuffer());
    const file = await upload('metrics.xlsx', bytes);
    assert.equal((await (await session(`/api/files/${file.id}/preview`)).json()).kind, 'workbook');
    const response = await session(`/api/files/${file.id}/preview/content`);
    assert.equal(response.status, 200, await response.clone().text());
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
    const invalid = await upload('bad.xlsx', 'not a zip');
    assert.equal((await session(`/api/files/${invalid.id}/preview/content`)).status, 422);
    const archive = new JSZip();
    archive.file('readme.txt', 'not a workbook');
    const notWorkbook = await upload(
      'renamed.xlsx',
      await archive.generateAsync({ type: 'nodebuffer' }),
    );
    assert.equal((await session(`/api/files/${notWorkbook.id}/preview/content`)).status, 422);
  });
  await t.test(
    'archive listings are bounded, do not extract, and reject corrupt files',
    async () => {
      const archive = new JSZip();
      archive.folder('reports');
      archive.file('reports/data.txt', 'private');
      archive.file('empty.txt', '');
      const file = await upload('archive.zip', await archive.generateAsync({ type: 'nodebuffer' }));
      const response = await session(`/api/files/${file.id}/preview/archive`);
      assert.equal(response.status, 200);
      const value = await response.json();
      assert(
        value.entries.some((entry: any) => entry.name === 'reports/data.txt' && entry.size === 7),
      );
      assert(value.entries.some((entry: any) => entry.directory));
      assert.equal(value.truncated, false);
      const many = new JSZip();
      for (let i = 0; i < 1002; i++) many.file(`file-${i}.txt`, '');
      const large = await upload('many.zip', await many.generateAsync({ type: 'nodebuffer' }));
      const limited = await (await session(`/api/files/${large.id}/preview/archive`)).json();
      assert.equal(limited.entries.length, 1000);
      assert.equal(limited.truncated, true);
      assert.equal(limited.total, 1002);
      const corrupt = await upload('broken.zip', 'PK broken');
      assert.equal((await session(`/api/files/${corrupt.id}/preview/archive`)).status, 422);
    },
  );
  await t.test('workbook decompression limits stop oversized contents', async () => {
    const archive = new JSZip();
    archive.file('xl/workbook.xml', '<workbook/>');
    for (let i = 0; i < 3; i++)
      archive.file(`xl/worksheets/sheet${i}.xml`, Buffer.alloc(12 * 1024 * 1024, 65));
    const bomb = await upload(
      'large.xlsx',
      await archive.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }),
    );
    assert.equal((await session(`/api/files/${bomb.id}/preview/content`)).status, 413);
  });
  await t.test('prepared previews enforce auth, origin, and bounded conversion', async () => {
    const file = await upload('broken.docx', 'not a document');
    const endpoint = '/api/files/' + file.id + '/preview/prepare';
    for (const suffix of ['/prepare', '/prepared']) {
      assert.equal(
        (await fetch(origin + '/api/files/' + file.id + '/preview' + suffix)).status,
        401,
      );
      assert.equal(
        (
          await fetch(origin + '/api/files/' + file.id + '/preview' + suffix, {
            headers: { Authorization: 'Bearer ' + uploadKey },
          })
        ).status,
        403,
      );
    }
    assert.equal(
      (
        await session(endpoint, {
          method: 'POST',
          headers: { Origin: 'https://untrusted.example' },
        })
      ).status,
      403,
    );
    assert.equal((await (await session(endpoint)).json()).status, 'idle');
    assert.equal((await session(endpoint + '?variant=unknown', { method: 'POST' })).status, 415);
    assert.equal(
      (
        await fetch(origin + endpoint, {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + readKey },
        })
      ).status,
      202,
    );
    for (let i = 0; i < 100; i++) {
      const status = await (await session(endpoint)).json();
      if (status.status === 'failed') {
        assert.match(status.error, /damaged|protected/);
        break;
      }
      if (i === 99) assert.fail('Conversion did not fail safely');
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
    const external = new JSZip();
    external.file(
      'word/_rels/document.xml.rels',
      '<Relationships><Relationship TargetMode="External" Target="http://example.invalid/private"/></Relationships>',
    );
    const linked = await upload(
      'external.docx',
      await external.generateAsync({ type: 'nodebuffer' }),
    );
    const linkedEndpoint = '/api/files/' + linked.id + '/preview/prepare';
    await session(linkedEndpoint, { method: 'POST' });
    for (let i = 0; i < 100; i++) {
      const status = await (await session(linkedEndpoint)).json();
      if (status.status === 'failed') {
        assert.match(status.error, /external links/);
        break;
      }
      if (i === 99) assert.fail('External content not rejected');
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
  });
  await t.test(
    'video preparation puts metadata first, supports seeking, and preserves originals',
    async () => {
      const source = join(root, 'fixture.mp4');
      execFileSync('ffmpeg', [
        '-nostdin',
        '-v',
        'error',
        '-f',
        'lavfi',
        '-i',
        'testsrc2=size=1600x900:rate=12:duration=3',
        '-c:v',
        'libx264',
        '-threads',
        '2',
        '-pix_fmt',
        'yuv420p',
        source,
      ]);
      const bytes = await readFile(source);
      assert(bytes.indexOf('moov') > bytes.indexOf('mdat'));
      const file = await upload('stream.mp4', bytes);
      const before = await (await session('/api/storage')).json();
      for (const variant of ['stream', 'mobile']) {
        const endpoint = '/api/files/' + file.id + '/preview/prepare?variant=' + variant;
        assert.equal((await session(endpoint, { method: 'POST' })).status, 202);
        let ready;
        for (let i = 0; i < 600; i++) {
          const status = await (await session(endpoint)).json();
          if (status.status === 'ready') {
            ready = status;
            break;
          }
          if (status.status === 'failed') assert.fail(status.error);
          await new Promise<void>((resolve) => setTimeout(resolve, 100));
        }
        assert(ready, 'Video preparation did not finish');
        const response = await session(ready.url);
        assert.equal(response.headers.get('content-type')!, 'video/mp4');
        assert.equal(response.headers.get('cache-control')!, 'private, no-store');
        const result = Buffer.from(await response.arrayBuffer());
        assert(result.indexOf('moov') < result.indexOf('mdat'));
        const range = await session(ready.url, { headers: { Range: 'bytes=0-65535' } });
        assert.equal(range.status, 206);
        assert.equal((await range.arrayBuffer()).byteLength, Math.min(result.length, 65536));
        const suffix = await session(ready.url, { headers: { Range: 'bytes=-32' } });
        assert.deepEqual(Buffer.from(await suffix.arrayBuffer()), result.subarray(-32));
        assert.equal(
          (await session(ready.url, { method: 'HEAD' })).headers.get('content-length')!,
          String(result.length),
        );
        assert.equal(
          (await session(ready.url, { headers: { Range: 'bytes=999999999-' } })).status,
          416,
        );
        assert.equal((await session(endpoint, { method: 'POST' })).status, 200);
        if (variant === 'mobile') {
          const cached = (await readdir(join(root, 'previews'))).filter((name) =>
            name.endsWith('.mp4'),
          );
          let small = false;
          for (const name of cached) {
            const probe = JSON.parse(
              execFileSync('ffprobe', [
                '-v',
                'error',
                '-show_entries',
                'stream=width,height,codec_name',
                '-of',
                'json',
                join(root, 'previews', name),
              ]).toString(),
            );
            if (
              probe.streams.some(
                (s: any) => s.width <= 1280 && s.height <= 720 && s.codec_name === 'h264',
              )
            )
              small = true;
          }
          assert(small, '720p H.264 derivative missing');
        }
      }
      assert.deepEqual(
        Buffer.from(await (await session('/api/files/' + file.id + '/download')).arrayBuffer()),
        bytes,
      );
      assert.equal((await (await session('/api/storage')).json()).used_bytes, before.used_bytes);
      assert.equal((await session('/api/files/' + file.id, { method: 'DELETE' })).status, 200);
      assert(!(await readdir(join(root, 'previews'))).some((name) => /\.(pdf|mp4)$/.test(name)));
    },
  );
  await t.test('Office document converts to a cached PDF', async () => {
    const archive = new JSZip();
    archive.file(
      '[Content_Types].xml',
      '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    );
    archive.file(
      '_rels/.rels',
      '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    );
    archive.file(
      'word/document.xml',
      '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Pocket Drive document preview</w:t></w:r></w:p></w:body></w:document>',
    );
    const file = await upload('document.docx', await archive.generateAsync({ type: 'nodebuffer' }));
    assert.equal(
      (await (await session('/api/files/' + file.id + '/preview')).json()).kind,
      'office',
    );
    const endpoint = '/api/files/' + file.id + '/preview/prepare';
    await session(endpoint, { method: 'POST' });
    let ready;
    for (let i = 0; i < 600; i++) {
      const status = await (await session(endpoint)).json();
      if (status.status === 'ready') {
        ready = status;
        break;
      }
      if (status.status === 'failed') assert.fail(status.error);
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
    assert(ready, 'Document preparation did not finish');
    const pdf = await session(ready.url);
    assert.equal(pdf.headers.get('content-type')!, 'application/pdf');
    assert(
      Buffer.from(await pdf.arrayBuffer())
        .subarray(0, 5)
        .equals(Buffer.from('%PDF-')),
    );
    preparedDocument = { id: file.id, url: ready.url };
  });
  await t.test('cached previews survive restarts and interrupted jobs recover', async () => {
    const before = Buffer.from(await (await session(preparedDocument.url)).arrayBuffer());
    const exit = new Promise<void>((resolve) => child.once('exit', resolve));
    child.kill('SIGTERM');
    await exit;
    const { DatabaseSync } = await import('node:sqlite');
    const database = new DatabaseSync(join(root, 'metadata.sqlite'));
    const file = await database.prepare("SELECT id FROM files WHERE name='broken.docx'").get();
    assert(file);
    database
      .prepare("UPDATE preview_jobs SET status='running',expires=?,error=NULL WHERE file_id=?")
      .run(Date.now() + 999999, file.id);
    database.close();
    child = launch();
    child.stdout.on('data', (d) => (logs += d));
    child.stderr.on('data', (d) => (logs += d));
    for (let i = 0; i < 150; i++) {
      try {
        if ((await fetch(origin + '/api/health')).ok) break;
      } catch {}
      if (child.exitCode !== null) throw new Error(logs);
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
    const status = await (
      await session('/api/files/' + preparedDocument.id + '/preview/prepare')
    ).json();
    assert.equal(status.status, 'ready');
    assert.equal(status.url, preparedDocument.url);
    assert.deepEqual(
      Buffer.from(await (await session(preparedDocument.url)).arrayBuffer()),
      before,
    );
    const interrupted = await (await session('/api/files/' + file.id + '/preview/prepare')).json();
    assert.equal(interrupted.status, 'failed');
    assert.match(interrupted.error, /interrupted/);
    assert.equal(
      (await session('/api/files/' + file.id + '/preview/prepare', { method: 'POST' })).status,
      202,
    );
  });
  await t.test('previewing does not change file IDs, names, contents or quota', async () => {
    const before = await (await session('/api/storage')).json();
    const metadata = await (await session(`/api/files/${code.id}`)).json();
    await session(`/api/files/${code.id}/preview/text`);
    assert.deepEqual(await (await session(`/api/files/${code.id}`)).json(), metadata);
    assert.equal((await (await session('/api/storage')).json()).used_bytes, before.used_bytes);
    const page = await session('/files');
    assert.match(page.headers.get('content-security-policy')!, /worker-src 'self'/);
    assert.match(page.headers.get('content-security-policy')!, /media-src 'self'/);
    assert.match(page.headers.get('content-security-policy')!, /object-src 'none'/);
  });
});
