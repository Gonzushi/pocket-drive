import type { DatabaseSync as SQLiteDatabase } from 'node:sqlite';

// Node 24.13 emits this informational warning when loading the built-in module.
// Filter only that exact notice during synchronous loading. Other warnings and
// database errors keep their normal behavior; the original handler is restored.
const original = process.emitWarning;
let sqlite: typeof import('node:sqlite');
try {
  process.emitWarning = function (warning: string | Error, ...args: unknown[]) {
    const type =
      typeof args[0] === 'object' && args[0] !== null
        ? (args[0] as { type?: string }).type
        : args[0];
    if (
      type === 'ExperimentalWarning' &&
      warning === 'SQLite is an experimental feature and might change at any time'
    )
      return;
    Reflect.apply(original, process, [warning, ...args]);
  } as typeof process.emitWarning;
  // Load the native module directly so Webpack and Turbopack do not rewrite
  // a createRequire reference into an unsupported external URL.
  sqlite = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite');
} finally {
  process.emitWarning = original;
}

export const DatabaseSync = sqlite.DatabaseSync;
export type Database = SQLiteDatabase;
