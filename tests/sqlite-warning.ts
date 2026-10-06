import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('SQLite loads and works without hiding unrelated warnings', () => {
  const result = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import { DatabaseSync } from './lib/server/sqlite.ts';
    const database = new DatabaseSync(':memory:');
    database.exec('CREATE TABLE sample(value TEXT)');
    database.prepare('INSERT INTO sample VALUES (?)').run('ok');
    console.log(database.prepare('SELECT value FROM sample').get().value);
    database.close();
    process.emitWarning('Unrelated warning is still visible', 'ExperimentalWarning');
  `,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /ok/);
  assert.doesNotMatch(result.stderr, /SQLite is an experimental feature/);
  assert.match(result.stderr, /Unrelated warning is still visible/);
});
