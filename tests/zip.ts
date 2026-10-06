import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { zipArchive, zipStream } from '../lib/server/zip.ts';

test('ZIP64 exports more than 65,535 entries and opens in standard readers', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pocket-zip-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const entries = Array.from({ length: 65536 }, (_, i) => ({
    name: `Folder/${i}/`,
    size: 0,
    created_at: '2026-10-05T00:00:00Z',
  }));
  const chunks = [];
  for await (const chunk of zipArchive(entries, new AbortController().signal)) chunks.push(chunk);
  const archive = join(root, 'many.zip');
  await writeFile(archive, Buffer.concat(chunks));
  assert.equal(
    execFileSync(
      'python3',
      [
        '-c',
        'import zipfile,sys; z=zipfile.ZipFile(sys.argv[1]); assert len(z.infolist())==65536; assert all(i.is_dir() for i in z.infolist()); assert z.testzip() is None; print("ok")',
        archive,
      ],
      { encoding: 'utf8' },
    ).trim(),
    'ok',
  );
});

test(
  'cancelled ZIP downloads stop reading files and surface missing file errors',
  { timeout: 10000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'pocket-zip-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const path = join(root, 'large.bin');
    await writeFile(path, randomBytes(5 * 1024 * 1024));
    const entry = {
      name: 'large.bin',
      size: 5 * 1024 * 1024,
      path,
      created_at: new Date().toISOString(),
    };
    const reader = zipStream([entry], new AbortController().signal).getReader();
    await reader.read();
    await reader.read();
    await reader.cancel();
    assert.equal((await reader.read()).done, true);
    const missing = zipStream(
      [{ ...entry, path: join(root, 'missing') }],
      new AbortController().signal,
    ).getReader();
    await missing.read();
    await assert.rejects(missing.read(), /ENOENT/);
  },
);
