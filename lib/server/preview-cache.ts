import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, rename, rm, stat, writeFile, copyFile, utimes } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { config } from './config';
import { db, fileById, type StoredFile } from './db';
import { diskFree, diskReserved, download, filePath } from './storage';
import { HttpError, json } from './http';
import { previewType } from '../shared/preview-kind';

export type Derivative = 'document' | 'stream' | 'mobile';
const MAX_OUTPUT = 128 * 1024 * 1024;
const OFFICE_LIMIT = 20 * 1024 * 1024;
const CACHE_LIMIT = 512 * 1024 * 1024;
const LEASE_MS = 240_000;
let initialized = false;
let active = false;
const queue: { file: StoredFile; variant: Derivative; key: string }[] = [];
const cacheRoot = () => path.join(config().storagePath, 'previews');
function initialize() {
  if (initialized) return;
  db()
    .exec(`CREATE TABLE IF NOT EXISTS preview_jobs (key TEXT PRIMARY KEY, file_id TEXT NOT NULL, variant TEXT NOT NULL, status TEXT NOT NULL, expires INTEGER NOT NULL, error TEXT);
    CREATE INDEX IF NOT EXISTS preview_job_file ON preview_jobs(file_id);`);
  // The drive runs one instance. A new process cannot resume its old children.
  db()
    .prepare(
      "UPDATE preview_jobs SET status='failed',expires=0,error='Preparation was interrupted. Open the preview again to retry.' WHERE status='running'",
    )
    .run();
  initialized = true;
}
function cacheKey(file: StoredFile, variant: Derivative) {
  return createHash('sha256')
    .update(`v1:${file.id}:${file.checksum}:${previewType(file.name).extension}:${variant}`)
    .digest('hex');
}
function derivativePath(key: string, variant: Derivative) {
  return path.join(cacheRoot(), key + (variant === 'document' ? '.pdf' : '.mp4'));
}
function validate(file: StoredFile, variant: string): asserts variant is Derivative {
  const kind = previewType(file.name).kind;
  if (variant === 'document' && kind === 'office') {
    if (file.size > OFFICE_LIMIT)
      throw new HttpError(413, 'Document previews support files up to 20 MB.');
    return;
  }
  if (['stream', 'mobile'].includes(variant) && kind === 'video') return;
  throw new HttpError(415, 'This preview conversion is not supported.');
}
function run(binary: string, args: string[], cwd: string, timeout = 150_000): Promise<string> {
  return new Promise((resolve, reject) => {
    // Children get a job-local profile and no application credentials. Bound
    // threads, elapsed time, address space, CPU time and output-file size.
    const child = spawn(
      '/usr/bin/prlimit',
      ['--as=2147483648', '--cpu=160', `--fsize=${MAX_OUTPUT}`, '--', binary, ...args],
      {
        cwd,
        detached: true,
        env: {
          NODE_ENV: 'production',
          PATH: process.env.PATH || '/usr/bin:/bin',
          HOME: cwd,
          TMPDIR: cwd,
          LANG: 'C.UTF-8',
          OMP_NUM_THREADS: '2',
          OPENBLAS_NUM_THREADS: '1',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let output = '';
    const collect = (data: Buffer) => {
      if (output.length < 16384) output += data.toString().slice(0, 16384 - output.length);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    const stop = () => {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
      } catch {}
    };
    const timer = setTimeout(() => {
      stop();
      reject(new Error('Preview preparation timed out. Download the original or retry later.'));
    }, timeout);
    child.once('error', () => {
      clearTimeout(timer);
      reject(new Error('Preview tools are unavailable. Deploy the updated Docker image.'));
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(output);
      else
        reject(
          new Error(
            'This file could not be converted. It may be protected, damaged, or exceed the preview limits.',
          ),
        );
    });
  });
}
async function validateOffice(file: StoredFile) {
  const yauzl = await import('yauzl');
  return new Promise<void>((resolve, reject) => {
    yauzl.open(
      filePath(file.id, file.blob_id ?? null),
      { lazyEntries: true, validateEntrySizes: true },
      (error, zip) => {
        if (error || !zip) {
          reject(new Error('This document is damaged or password protected.'));
          return;
        }
        let total = 0;
        let entries = 0;
        let finished = false;
        const finish = (error?: Error) => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          zip.close();
          if (error) reject(error);
          else resolve();
        };
        const timer = setTimeout(() => finish(new Error('Document validation timed out.')), 10000);
        zip.on('error', () => finish(new Error('This document archive is invalid.')));
        zip.on('end', () => finish());
        zip.on('entry', (entry) => {
          total += entry.uncompressedSize;
          entries++;
          if (
            entries > 2000 ||
            total > 64 * 1024 * 1024 ||
            entry.uncompressedSize > 16 * 1024 * 1024 ||
            entry.generalPurposeBitFlag & 1 ||
            /vbaProject|(^|\/)Scripts\/|(^|\/)Basic\//i.test(entry.fileName)
          ) {
            finish(
              new Error(
                'Encrypted, macro-enabled, or overly complex documents cannot be previewed.',
              ),
            );
            return;
          }
          if (!/\.(xml|rels)$/i.test(entry.fileName)) {
            zip.readEntry();
            return;
          }
          zip.openReadStream(entry, (error, stream) => {
            if (error || !stream) {
              finish(new Error('The document could not be checked.'));
              return;
            }
            const chunks: Buffer[] = [];
            let bytes = 0;
            stream.on('data', (chunk) => {
              bytes += chunk.length;
              if (bytes > 16 * 1024 * 1024) {
                stream.destroy();
                finish(new Error('Document XML exceeds the preview limit.'));
              } else chunks.push(chunk);
            });
            stream.on('error', () => finish(new Error('The document is damaged.')));
            stream.on('end', () => {
              if (finished) return;
              const bytes = Buffer.concat(chunks);
              if (bytes.includes(0)) {
                finish(new Error('Document XML must use a compatible text encoding.'));
                return;
              }
              const xml = bytes
                .toString('utf8')
                .replace(/&#(?:x([a-f0-9]+)|([0-9]+));/gi, (_, hex: string, decimal: string) => {
                  const point = parseInt(hex || decimal, hex ? 16 : 10);
                  return point >= 0 && point <= 0x10ffff ? String.fromCodePoint(point) : '\ufffd';
                });
              // Never follow external images, templates, linked files or entities.
              if (
                /<!DOCTYPE|<!ENTITY|TargetMode\s*=\s*["']External|(?:xlink:href|(?:^|\s)(?:href|src|Target))\s*=\s*["'](?:[a-z]+:|\/\/|\/|\.\.)|macroEnabled|office:script/i.test(
                  xml,
                )
              ) {
                finish(
                  new Error(
                    'This document contains external links or active content. Download it to view safely.',
                  ),
                );
                return;
              }
              zip.readEntry();
            });
            const closeStream = () => stream.destroy();
            zip.once('close', closeStream);
            stream.once('close', () => zip.removeListener('close', closeStream));
          });
        });
        zip.readEntry();
      },
    );
  });
}
async function convert(file: StoredFile, variant: Derivative, key: string) {
  const root = cacheRoot();
  await mkdir(root, { recursive: true, mode: 0o700 });
  const work = path.join(root, 'work-' + randomUUID());
  await mkdir(work, { mode: 0o700 });
  try {
    if ((await diskFree()) - config().reserve - diskReserved() < MAX_OUTPUT * 2 + file.size)
      throw new Error('There is not enough free disk space to prepare a preview.');
    const output = path.join(work, variant === 'document' ? 'source.pdf' : 'result.mp4');
    if (variant === 'document') {
      await validateOffice(file);
      const extension = previewType(file.name).extension;
      await copyFile(
        filePath(file.id, file.blob_id ?? null),
        path.join(work, `source.${extension}`),
      );
      const profile = path.join(work, 'profile');
      await mkdir(path.join(profile, 'user'), { recursive: true });
      await writeFile(
        path.join(profile, 'user', 'registrymodifications.xcu'),
        `<?xml version="1.0"?><oor:items xmlns:oor="http://openoffice.org/2001/registry"><item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop></item><item oor:path="/org.openoffice.Office.Java/VirtualMachine"><prop oor:name="Enable" oor:op="fuse"><value>false</value></prop></item></oor:items>`,
      );
      await run(
        process.env.LIBREOFFICE_BIN || 'libreoffice',
        [
          `-env:UserInstallation=${pathToFileURL(profile).href}`,
          '--headless',
          '--nologo',
          '--nodefault',
          '--norestore',
          '--convert-to',
          'pdf',
          '--outdir',
          work,
          path.join(work, `source.${extension}`),
        ],
        work,
        60000,
      );
      const handle = await import('node:fs/promises').then((fs) => fs.open(output, 'r'));
      try {
        const signature = Buffer.alloc(5);
        await handle.read(signature, 0, 5, 0);
        if (signature.toString() !== '%PDF-')
          throw new Error('Document conversion did not produce a valid preview.');
      } finally {
        await handle.close();
      }
    } else {
      const probe = JSON.parse(
        await run(
          process.env.FFPROBE_BIN || 'ffprobe',
          [
            '-v',
            'error',
            '-protocol_whitelist',
            'file',
            '-show_entries',
            'format=duration:stream=codec_type,codec_name',
            '-of',
            'json',
            filePath(file.id, file.blob_id ?? null),
          ],
          work,
          10000,
        ),
      );
      if (!probe.streams?.some((s: { codec_type: string }) => s.codec_type === 'video'))
        throw new Error('This file has no video stream.');
      const video = probe.streams.find((s: { codec_type: string }) => s.codec_type === 'video');
      const audio = probe.streams.find((s: { codec_type: string }) => s.codec_type === 'audio');
      const copy =
        variant === 'stream' &&
        video.codec_name === 'h264' &&
        (!audio || ['aac', 'mp3'].includes(audio.codec_name));
      const args = [
        '-nostdin',
        '-v',
        'error',
        '-threads',
        '2',
        '-filter_threads',
        '1',
        '-protocol_whitelist',
        'file',
        '-i',
        filePath(file.id, file.blob_id ?? null),
        '-map',
        '0:v:0',
        '-map',
        '0:a:0?',
        '-map_metadata',
        '-1',
        '-sn',
        '-dn',
      ];
      if (copy) args.push('-c', 'copy');
      else
        args.push(
          '-vf',
          "scale=w='min(1280,iw)':h='min(720,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2",
          '-c:v',
          'libx264',
          '-threads',
          '2',
          '-preset',
          'veryfast',
          '-crf',
          '25',
          '-maxrate',
          '2200k',
          '-bufsize',
          '4400k',
          '-pix_fmt',
          'yuv420p',
          '-c:a',
          'aac',
          '-b:a',
          '128k',
        );
      args.push('-movflags', '+faststart', '-y', output);
      await run(process.env.FFMPEG_BIN || 'ffmpeg', args, work);
      const result = JSON.parse(
        await run(
          process.env.FFPROBE_BIN || 'ffprobe',
          ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', output],
          work,
          10000,
        ),
      );
      if (
        !Number.isFinite(Number(result.format.duration)) ||
        Math.abs(Number(result.format.duration) - Number(probe.format.duration)) > 2
      )
        throw new Error('The video exceeds conversion limits. Use original quality.');
    }
    const size = (await stat(output)).size;
    if (!size || size > MAX_OUTPUT)
      throw new Error('The prepared preview exceeds the cache limit.');
    const current = fileById(file.id);
    if (!current || cacheKey(current, variant) !== key)
      throw new Error('The original file changed or was deleted.');
    await rename(output, derivativePath(key, variant));
    if (!fileById(file.id) || !db().prepare('SELECT key FROM preview_jobs WHERE key=?').get(key)) {
      await rm(derivativePath(key, variant), { force: true });
      throw new Error('The original file was deleted.');
    }
    db()
      .prepare("UPDATE preview_jobs SET status='ready',expires=?,error=NULL WHERE key=?")
      .run(Date.now() + 7 * 86400000, key);
    await trimPreviewCache().catch(() => {
      console.warn('Preview cache cleanup will be retried after the next preparation.');
    });
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
async function drain() {
  if (active) return;
  active = true;
  try {
    while (queue.length) {
      const job = queue.shift()!;
      try {
        await convert(job.file, job.variant, job.key);
      } catch (error) {
        db()
          .prepare("UPDATE preview_jobs SET status='failed',expires=?,error=? WHERE key=?")
          .run(Date.now() + 60000, (error as Error).message, job.key);
      }
    }
  } finally {
    active = false;
  }
}
export async function preparedStatus(file: StoredFile, variant: string, start = false) {
  validate(file, variant);
  initialize();
  const key = cacheKey(file, variant);
  let job = db().prepare('SELECT status,expires,error FROM preview_jobs WHERE key=?').get(key) as
    { status: string; expires: number; error: string | null } | undefined;
  if (job?.status === 'ready') {
    try {
      await stat(derivativePath(key, variant));
    } catch {
      db().prepare('DELETE FROM preview_jobs WHERE key=?').run(key);
      job = undefined;
    }
  }
  if (job?.status === 'running' && job.expires < Date.now()) {
    db().prepare('DELETE FROM preview_jobs WHERE key=?').run(key);
    job = undefined;
  }
  if (start && (!job || (job.status === 'failed' && job.expires < Date.now()))) {
    if (
      queue.length >= 8 ||
      (
        db()
          .prepare("SELECT COUNT(*) AS n FROM preview_jobs WHERE status='running' AND expires>? ")
          .get(Date.now()) as { n: number }
      ).n >= 8
    )
      throw new HttpError(429, 'The preview queue is busy. Try again shortly.');
    const claimed = db()
      .prepare(
        "INSERT INTO preview_jobs(key,file_id,variant,status,expires) VALUES(?,?,?,'running',?) ON CONFLICT(key) DO UPDATE SET status='running',expires=excluded.expires,error=NULL WHERE preview_jobs.expires<? AND preview_jobs.status!='ready'",
      )
      .run(key, file.id, variant, Date.now() + LEASE_MS * 9, Date.now());
    if (claimed.changes) {
      queue.push({ file, variant, key });
      void drain();
    }
    job = db()
      .prepare('SELECT status,expires,error FROM preview_jobs WHERE key=?')
      .get(key) as typeof job;
  }
  return {
    status: job?.status || 'idle',
    error: job?.error || null,
    url:
      job?.status === 'ready' ? `/api/files/${file.id}/preview/prepared?variant=${variant}` : null,
  };
}
export async function preparedContent(req: Request, file: StoredFile) {
  const variant = new URL(req.url).searchParams.get('variant') || 'document';
  validate(file, variant);
  const status = await preparedStatus(file, variant);
  if (status.status !== 'ready') return json(status, 202);
  const key = cacheKey(file, variant);
  const target = derivativePath(key, variant);
  const size = (await stat(target)).size;
  void utimes(target, new Date(), new Date()).catch(() => {});
  return download(
    req,
    { ...file, size },
    {
      mime: variant === 'document' ? 'application/pdf' : 'video/mp4',
      inline: true,
      path: target,
      etag: key,
    },
  );
}
export async function removePrepared(id: string) {
  initialize();
  const jobs = db().prepare('SELECT key,variant FROM preview_jobs WHERE file_id=?').all(id) as {
    key: string;
    variant: Derivative;
  }[];
  for (const job of jobs) await rm(derivativePath(job.key, job.variant), { force: true });
  db().prepare('DELETE FROM preview_jobs WHERE file_id=?').run(id);
}
export async function preparedDocumentPath(file: StoredFile) {
  const status = await preparedStatus(file, 'document');
  if (status.status !== 'ready') throw new HttpError(409, 'Document preview is not ready.');
  return derivativePath(cacheKey(file, 'document'), 'document');
}
async function trimPreviewCache() {
  const entries = await readdir(cacheRoot(), { withFileTypes: true });
  const files = await Promise.all(
    entries
      .filter((e) => e.isFile() && /^[a-f0-9]{64}\.(pdf|mp4)$/.test(e.name))
      .map(async (e) => ({ name: e.name, ...(await stat(path.join(cacheRoot(), e.name))) })),
  );
  let bytes = files.reduce((n, f) => n + f.size, 0);
  for (const file of files.sort((a, b) => a.mtimeMs - b.mtimeMs)) {
    if (bytes <= CACHE_LIMIT && Date.now() - file.mtimeMs < 7 * 86400000) break;
    await rm(path.join(cacheRoot(), file.name), { force: true });
    db().prepare('DELETE FROM preview_jobs WHERE key=?').run(file.name.split('.')[0]);
    bytes -= file.size;
  }
  for (const entry of entries.filter((e) => e.isDirectory() && /^work-[a-f0-9-]+$/.test(e.name))) {
    const target = path.join(cacheRoot(), entry.name);
    if (Date.now() - (await stat(target)).mtimeMs > LEASE_MS * 10)
      await rm(target, { recursive: true, force: true });
  }
}
