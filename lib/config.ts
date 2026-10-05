import path from 'node:path';
export function config() {
  const origin = process.env.APP_ORIGIN || 'http://localhost:3000';
  const parsed = new URL(origin);
  if (!['https:', 'http:'].includes(parsed.protocol) || parsed.origin !== origin) throw new Error('APP_ORIGIN must be an origin without a trailing slash.');
  if (process.env.NODE_ENV === 'production' && parsed.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(parsed.hostname)) throw new Error('Use HTTPS for APP_ORIGIN.');
  const secret = process.env.SESSION_SECRET || '';
  const passwordHash = process.env.ADMIN_PASSWORD_HASH || '';
  if (secret.length < 32 || !/^scrypt:[a-f0-9]{32}:[a-f0-9]{128}$/.test(passwordHash)) throw new Error('Run npm run setup and configure authentication.');
  const number = (name: string, fallback: number, allowZero = false) => {
    const value = Number(process.env[name] ?? fallback);
    if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) throw new Error(`Invalid ${name}.`);
    return value;
  };
  return {
    origin, secret, passwordHash, username: process.env.ADMIN_USERNAME || 'admin',
    storagePath: path.resolve(process.env.STORAGE_PATH || './storage'),
    quota: number('STORAGE_QUOTA_BYTES', 20_000_000_000),
    reserve: number('MIN_FREE_DISK_BYTES', 5_000_000_000, true),
    maxFile: number('MAX_FILE_BYTES', 1_000_000_000)
  };
}
