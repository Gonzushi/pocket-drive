import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

let input = '';
for await (const part of process.stdin) {
  input += part;
  if (input.length > 1100000) throw new Error('Invalid extraction request.');
}
const { kind, file, extension, text: sourceText } = JSON.parse(input);
const sections: { label: string; text: string }[] = [];
let characters = 0;
let limited = false;
function add(label: string, text: string) {
  if (sections.length >= 256 || characters >= 1000000) {
    limited = true;
    return;
  }
  const available = 1000000 - characters;
  if (text.length > available) limited = true;
  text = text.slice(0, available);
  if (!text.trim()) return;
  sections.push({ label, text });
  characters += text.length;
}
if (kind === 'pdf') {
  const { stdout } = await promisify(execFile)(
    process.env.PDFTOTEXT_BIN || 'pdftotext',
    ['-f', '1', '-l', '100', '-layout', '-enc', 'UTF-8', file, '-'],
    { timeout: 30000, maxBuffer: 2 * 1024 * 1024 },
  );
  const pages = stdout.split('\f');
  if (!pages.at(-1)?.trim()) pages.pop();
  pages.forEach((text, index) => add('Page ' + (index + 1), text));
  limited ||= pages.length >= 100;
} else if (kind === 'workbook') {
  const require = createRequire(import.meta.url);
  const ExcelJS = require(path.join(process.cwd(), 'public/preview-assets/exceljs.min.js'));
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await readFile(file));
  limited ||= workbook.worksheets.length > 20;
  for (const sheet of workbook.worksheets.slice(0, 20)) {
    limited ||= sheet.rowCount > 1000 || sheet.columnCount > 50;
    for (let start = 1; start <= Math.min(sheet.rowCount, 1000); start += 50) {
      const rows = [];
      for (let row = start; row <= Math.min(start + 49, sheet.rowCount, 1000); row++) {
        const cells = [];
        for (let column = 1; column <= Math.min(sheet.columnCount, 50); column++) {
          const cell = sheet.getRow(row).getCell(column);
          const text = cell.text || '';
          limited ||= text.length > 1000;
          cells.push(text.slice(0, 1000));
        }
        rows.push(row + ': ' + cells.join(' | '));
      }
      add(
        'Sheet ' +
          sheet.name +
          ' / rows ' +
          start +
          '–' +
          Math.min(start + 49, sheet.rowCount, 1000),
        rows.join('\n'),
      );
    }
  }
} else if (kind === 'table') {
  const require = createRequire(import.meta.url);
  const Papa = require(path.join(process.cwd(), 'public/preview-assets/papaparse.min.js'));
  const parsed = Papa.parse(sourceText, {
    delimiter: extension === 'tsv' ? '\t' : '',
    preview: 1001,
  }) as { data: string[][]; errors: { code: string }[] };
  const rows = parsed.data;
  limited ||= rows.length > 1000 || parsed.errors.length > 0;
  if (parsed.errors.some((error) => error.code === 'MissingQuotes')) rows.pop();
  for (let start = 0; start < Math.min(rows.length, 1000); start += 50) {
    const text = rows
      .slice(start, Math.min(start + 50, 1000))
      .map((row, index) => {
        limited ||= row.length > 50;
        return (
          start +
          index +
          1 +
          ': ' +
          row
            .slice(0, 50)
            .map((cell) => {
              limited ||= cell.length > 1000;
              return cell.slice(0, 1000);
            })
            .join(' | ')
        );
      })
      .join('\n');
    add('Rows ' + (start + 1) + '–' + Math.min(start + 50, rows.length, 1000), text);
  }
} else {
  throw new Error('Unsupported document format.');
}
process.stdout.write(
  JSON.stringify({ sections, limited, empty: sections.length === 0, extension }),
);
