import ts from 'typescript';
import { readFileSync, writeFileSync } from 'node:fs';
import { cpSync, mkdirSync } from 'node:fs';
const target = 'public/preview-assets';
mkdirSync(target, { recursive: true });
// The vendored UMD readers remain CommonJS when loaded by the Node extractor.
writeFileSync(`${target}/package.json`, JSON.stringify({ type: 'commonjs' }) + '\n');
cpSync('node_modules/pdfjs-dist/build/pdf.worker.min.mjs', `${target}/pdf.worker.min.mjs`);
cpSync('node_modules/pdfjs-dist/cmaps', `${target}/cmaps`, { recursive: true });
cpSync('node_modules/pdfjs-dist/standard_fonts', `${target}/standard_fonts`, { recursive: true });
cpSync('node_modules/exceljs/dist/exceljs.min.js', `${target}/exceljs.min.js`);
cpSync('node_modules/papaparse/papaparse.min.js', `${target}/papaparse.min.js`);
cpSync('node_modules/exceljs/dist/LICENSE', `${target}/EXCELJS-LICENSE.txt`);
cpSync('node_modules/pdfjs-dist/LICENSE', `${target}/PDFJS-LICENSE.txt`);
cpSync('node_modules/papaparse/LICENSE', `${target}/PAPAPARSE-LICENSE.txt`);
console.log('Local preview assets are ready.');

// Emit browser-compatible JavaScript from the checked TypeScript worker source.
const worker = ts.transpileModule(readFileSync("workers/preview-table-worker.ts", "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } });
writeFileSync("public/preview-table-worker.js", worker.outputText);
