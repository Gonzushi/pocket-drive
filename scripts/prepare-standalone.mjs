import { cpSync, existsSync } from 'node:fs';
cpSync('.next/static', '.next/standalone/.next/static', { recursive: true });
if (existsSync('public')) cpSync('public', '.next/standalone/public', { recursive: true });
cpSync('scripts/extract-document.mjs', '.next/standalone/scripts/extract-document.mjs');
console.log('Standalone server and browser assets are ready.');
