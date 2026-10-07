import { db } from './db';
import type { ApiKey } from '../shared/types';

// Call only after session authentication. Never return hashes or full tokens.
export function listApiKeys(): ApiKey[] {
  return db()
    .prepare(
      'SELECT id, name, scopes, created_at, last_used_at FROM api_keys ORDER BY created_at DESC',
    )
    .all()
    .map((key) => ({ ...key, scopes: JSON.parse(String(key.scopes)) })) as unknown as ApiKey[];
}
