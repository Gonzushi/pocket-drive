import { createHash, createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { cookies } from 'next/headers';
import { config } from './config';
import { db, transaction } from './db';
import { HttpError } from './http';

export const COOKIE = 'pocket_session';
export const hashToken = (token: string) =>
  createHmac('sha256', config().secret).update(token).digest('hex');
const credential = () =>
  createHash('sha256')
    .update(config().username + config().passwordHash)
    .digest('hex');
export function sessionValid(token?: string) {
  if (!token || token.length > 100) return false;
  return !!db()
    .prepare('SELECT 1 FROM sessions WHERE hash = ? AND expires > ? AND credential = ?')
    .get(hashToken(token), Date.now(), credential());
}
export async function signedIn() {
  return sessionValid((await cookies()).get(COOKIE)?.value);
}
export function checkOrigin(req: Request) {
  if (req.headers.get('origin') !== config().origin)
    throw new HttpError(403, 'Request origin is not allowed. Check APP_ORIGIN.');
}
export type Scope = 'read' | 'upload' | 'delete';
export function authorize(req: Request, scope: Scope = 'read', sessionOnly = false) {
  const bearer = req.headers.get('authorization');
  if (bearer) {
    if (sessionOnly) throw new HttpError(403, 'Manage API keys from the signed-in website.');
    if (!/^Bearer pd_[a-f0-9]{64}$/.test(bearer)) throw new HttpError(401, 'Invalid API key.');
    const key = db()
      .prepare('SELECT id, scopes FROM api_keys WHERE hash = ?')
      .get(hashToken(bearer.slice(7))) as { id: string; scopes: string } | undefined;
    if (!key) throw new HttpError(401, 'Invalid or revoked API key.');
    if (!(JSON.parse(key.scopes) as string[]).includes(scope))
      throw new HttpError(403, `This API key needs ${scope} permission.`);
    db()
      .prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?')
      .run(new Date().toISOString(), key.id);
    return;
  }
  const token = req.headers
    .get('cookie')
    ?.split(';')
    .map((v) => v.trim())
    .find((v) => v.startsWith(`${COOKIE}=`))
    ?.slice(COOKIE.length + 1);
  if (!sessionValid(token)) throw new HttpError(401, 'Please sign in to continue.');
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) checkOrigin(req);
}
export async function login(username: unknown, password: unknown) {
  if (typeof username !== 'string' || typeof password !== 'string' || password.length > 1024)
    throw new HttpError(400, 'Enter your username and password.');
  transaction(() => {
    db()
      .prepare('DELETE FROM login_attempts WHERE at < ?')
      .run(Date.now() - 15 * 60_000);
    const attempts = db().prepare('SELECT COUNT(*) AS n FROM login_attempts').get() as {
      n: number;
    };
    if (attempts.n >= 10)
      throw new HttpError(429, 'Too many sign-in attempts. Try again in 15 minutes.');
    db().prepare('INSERT INTO login_attempts(at) VALUES (?)').run(Date.now());
  });
  const cfg = config();
  const [, salt, digest] = cfg.passwordHash.split(':');
  const derived = (await promisify(scrypt)(password, salt, 64)) as Buffer;
  if (!timingSafeEqual(derived, Buffer.from(digest, 'hex')) || username !== cfg.username)
    throw new HttpError(401, 'Username or password is incorrect.');
  const token = randomBytes(32).toString('hex');
  transaction(() => {
    db()
      .prepare('DELETE FROM sessions WHERE expires <= ? OR credential != ?')
      .run(Date.now(), credential());
    db().prepare('DELETE FROM login_attempts').run();
    db()
      .prepare('INSERT INTO sessions(hash, expires, credential) VALUES (?, ?, ?)')
      .run(hashToken(token), Date.now() + 7 * 86400_000, credential());
  });
  return token;
}
export function sessionCookie(token: string, clear = false) {
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${clear ? 0 : 7 * 86400}${config().origin.startsWith('https:') ? '; Secure' : ''}`;
}
