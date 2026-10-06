// Tables parse outside the UI thread. Closing a preview terminates this worker.
interface SheetPreview {
  name: string;
  rows: string[][];
  truncated: boolean;
  totalRows: number;
}
interface WorkbookSheet {
  name: string;
  rowCount: number;
  columnCount: number;
  getRow(row: number): { getCell(column: number): { text: string } };
}
declare const ExcelJS: {
  Workbook: new () => {
    worksheets: WorkbookSheet[];
    xlsx: { load(bytes: ArrayBuffer, options: { ignoreNodes: string[] }): Promise<unknown> };
  };
};
declare const Papa: {
  parse(
    text: string,
    options: {
      delimiter: string;
      preview: number;
      skipEmptyLines: string;
      dynamicTyping: boolean;
    },
  ): { data: string[][]; errors: { type: string }[] };
};
interface TableRequest {
  kind: string;
  url: string;
  text: string;
  extension: string;
  truncated: boolean;
}
self.onmessage = async ({ data }: MessageEvent<TableRequest>) => {
  try {
    let sheets: SheetPreview[];
    if (data.kind === 'workbook') {
      importScripts('/preview-assets/exceljs.min.js');
      const response = await fetch(data.url, { credentials: 'same-origin' });
      if (!response.ok) {
        const body = await response.json();
        throw new Error(body.error || 'The workbook could not be loaded.');
      }
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(await response.arrayBuffer(), {
        ignoreNodes: ['drawing', 'picture', 'extLst', 'dataValidations', 'conditionalFormatting'],
      });
      let cellsUsed = 0;
      let charactersUsed = 0;
      sheets = workbook.worksheets.slice(0, 20).map((sheet) => {
        const rows: string[][] = [];
        const count = Math.min(sheet.rowCount, 1000);
        const columns = Math.min(sheet.columnCount, 50);
        for (let r = 1; r <= count; r++) {
          if (cellsUsed >= 100000 || charactersUsed >= 2000000) break;
          const row = sheet.getRow(r);
          const cells: string[] = [];
          for (let c = 1; c <= columns; c++) {
            const value = row.getCell(c).text.slice(0, 1000);
            cells.push(value);
            cellsUsed++;
            charactersUsed += value.length;
          }
          rows.push(cells);
        }
        return {
          name: sheet.name,
          rows,
          truncated: rows.length < sheet.rowCount || sheet.columnCount > 50,
          totalRows: sheet.rowCount,
        };
      });
      self.postMessage({ sheets, limitedSheets: workbook.worksheets.length > 20 });
    } else {
      importScripts('/preview-assets/papaparse.min.js');
      const parsed = Papa.parse(data.text, {
        delimiter: data.extension === 'tsv' ? '\t' : '',
        preview: 1001,
        skipEmptyLines: 'greedy',
        dynamicTyping: false,
      });
      if (parsed.errors.some((error) => error.type === 'Quotes'))
        throw new Error('This table has malformed quoted fields. Use Source to inspect it.');
      sheets = [
        {
          name: 'Table',
          rows: parsed.data
            .slice(0, 1000)
            .map((row) => row.slice(0, 50).map((value) => String(value).slice(0, 10000))),
          truncated:
            data.truncated ||
            parsed.data.length > 1000 ||
            parsed.data.some((row) => row.length > 50),
          totalRows: parsed.data.length,
        },
      ];
      self.postMessage({ sheets });
    }
  } catch (error) {
    self.postMessage({
      error: error instanceof Error ? error.message : 'This table cannot be previewed.',
    });
  }
};
