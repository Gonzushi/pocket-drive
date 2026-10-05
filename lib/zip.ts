import { createReadStream } from 'node:fs';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createDeflateRaw, crc32 } from 'node:zlib';

export interface ZipEntry { name: string; size: number; path?: string; created_at: string }
const MAX32 = 0xffffffff;
function extra(size: bigint, compressed: bigint, offset?: bigint) {
  const result = Buffer.alloc(offset === undefined ? 20 : 28);
  result.writeUInt16LE(1, 0); result.writeUInt16LE(result.length - 4, 2);
  result.writeBigUInt64LE(size, 4); result.writeBigUInt64LE(compressed, 12);
  if (offset !== undefined) result.writeBigUInt64LE(offset, 20);
  return result;
}
function dosDate(value: string) {
  const date = new Date(value); const year = Math.max(1980, Math.min(2107, date.getUTCFullYear() || 1980));
  return { time: (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | (date.getUTCSeconds() >> 1), date: ((year - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate() };
}
// Deflate + ZIP64 + signed data descriptors, per PKWARE APPNOTE 6.3.10.
// ZIP64 is emitted even for small exports, so totals over 4 GB stay valid.
export async function* zipArchive(entries: ZipEntry[], signal: AbortSignal): AsyncGenerator<Buffer> {
  let offset = 0n; const central: Buffer[] = [];
  for (const entry of entries) {
    signal.throwIfAborted();
    const name = Buffer.from(entry.name); const directory = entry.name.endsWith('/');
    if (name.length > 65535) throw new Error('Archive path is too long.');
    const streamed = !!entry.path && entry.size > 0; const flags = streamed ? 0x808 : 0x800; const method = streamed ? 8 : 0;
    const stamp = dosDate(entry.created_at); const localOffset = offset;
    const localExtra = extra(0n, 0n); const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(45, 4); header.writeUInt16LE(flags, 6); header.writeUInt16LE(method, 8);
    header.writeUInt16LE(stamp.time, 10); header.writeUInt16LE(stamp.date, 12);
    header.writeUInt32LE(MAX32, 18); header.writeUInt32LE(MAX32, 22); header.writeUInt16LE(name.length, 26); header.writeUInt16LE(localExtra.length, 28);
    const local = Buffer.concat([header, name, localExtra]); offset += BigInt(local.length); yield local;
    let checksum = 0; let size = 0n; let compressedSize = 0n;
    if (streamed) {
      const source = createReadStream(entry.path!, { signal, highWaterMark: 64 * 1024 });
      const tracker = new Transform({ transform(chunk: Buffer, _encoding, done) { checksum = crc32(chunk, checksum); size += BigInt(chunk.length); done(null, chunk); } });
      const compressor = createDeflateRaw({ level: 6, chunkSize: 64 * 1024 });
      const completion = pipeline(source, tracker, compressor, { signal }).then(() => null, error => { compressor.destroy(error); return error as Error; });
      try {
        for await (const chunk of compressor) { signal.throwIfAborted(); compressedSize += BigInt(chunk.length); offset += BigInt(chunk.length); yield chunk as Buffer; }
        const error = await completion; if (error) throw error;
        if (size !== BigInt(entry.size)) throw new Error('A file changed during the folder download.');
      } finally { source.destroy(); tracker.destroy(); compressor.destroy(); await completion; }
      const descriptor = Buffer.alloc(24); descriptor.writeUInt32LE(0x08074b50, 0); descriptor.writeUInt32LE(checksum, 4);
      descriptor.writeBigUInt64LE(compressedSize, 8); descriptor.writeBigUInt64LE(size, 16); offset += 24n; yield descriptor;
    }
    const centralExtra = extra(size, compressedSize, localOffset); const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0); record.writeUInt16LE(0x032d, 4); record.writeUInt16LE(45, 6); record.writeUInt16LE(flags, 8); record.writeUInt16LE(method, 10);
    record.writeUInt16LE(stamp.time, 12); record.writeUInt16LE(stamp.date, 14); record.writeUInt32LE(checksum, 16);
    record.writeUInt32LE(MAX32, 20); record.writeUInt32LE(MAX32, 24); record.writeUInt16LE(name.length, 28); record.writeUInt16LE(centralExtra.length, 30);
    record.writeUInt32LE(directory ? 0x41ed0010 : 0x81a40000, 38); record.writeUInt32LE(MAX32, 42);
    central.push(Buffer.concat([record, name, centralExtra]));
  }
  const centralOffset = offset;
  for (const record of central) { signal.throwIfAborted(); offset += BigInt(record.length); yield record; }
  const end64Offset = offset; const end64 = Buffer.alloc(56);
  end64.writeUInt32LE(0x06064b50, 0); end64.writeBigUInt64LE(44n, 4); end64.writeUInt16LE(0x032d, 12); end64.writeUInt16LE(45, 14);
  end64.writeBigUInt64LE(BigInt(entries.length), 24); end64.writeBigUInt64LE(BigInt(entries.length), 32);
  end64.writeBigUInt64LE(offset - centralOffset, 40); end64.writeBigUInt64LE(centralOffset, 48); yield end64;
  const locator = Buffer.alloc(20); locator.writeUInt32LE(0x07064b50, 0); locator.writeBigUInt64LE(end64Offset, 8); locator.writeUInt32LE(1, 16); yield locator;
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(0xffff, 8); end.writeUInt16LE(0xffff, 10); end.writeUInt32LE(MAX32, 12); end.writeUInt32LE(MAX32, 16); yield end;
}

export function zipStream(entries: ZipEntry[], requestSignal: AbortSignal) {
  const cancellation = new AbortController(); const signal = AbortSignal.any([requestSignal, cancellation.signal]);
  const iterator = zipArchive(entries, signal); let cancelled = false;
  return new ReadableStream<Uint8Array>({
    async pull(controller) { try { const next = await iterator.next(); if (cancelled) return; if (next.done) controller.close(); else controller.enqueue(next.value); } catch (error) { if (!cancelled) controller.error(error); } },
    async cancel() { cancelled = true; cancellation.abort(); await iterator.return(undefined); }
  }, { highWaterMark: 0 });
}
