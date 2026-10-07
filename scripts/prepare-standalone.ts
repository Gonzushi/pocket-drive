import { cpSync, existsSync } from 'node:fs';
cpSync('.next/static', '.next/standalone/.next/static', { recursive: true });
if (existsSync('public')) cpSync('public', '.next/standalone/public', { recursive: true });
cpSync('scripts/extract-document.ts', '.next/standalone/scripts/extract-document.ts');
cpSync('scripts/upload', '.next/standalone/scripts/upload', { recursive: true });
console.log('Standalone server and browser assets are ready.');
