'use client';
import { useEffect, useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, LoaderCircle } from 'lucide-react';
type Sheet = { name: string; rows: string[][]; truncated: boolean; totalRows: number };
export default function PreviewTable({
  kind,
  url,
  text,
  extension,
  truncated,
}: {
  kind: string;
  url: string;
  text?: string;
  extension: string;
  truncated?: boolean;
}) {
  const [sheets, setSheets] = useState<Sheet[]>([]);
  const [sheet, setSheet] = useState(0);
  const [page, setPage] = useState(0);
  const [error, setError] = useState('');
  const [limited, setLimited] = useState(false);
  const [query, setQuery] = useState('');
  const [header, setHeader] = useState(true);
  const [sort, setSort] = useState<{ column: number; order: number } | null>(null);
  const [cell, setCell] = useState<{ value: string; label: string } | null>(null);
  const [copied, setCopied] = useState('');
  const rows = useMemo(() => {
    const data = (sheets[sheet]?.rows || [])
      .map((row, index) => ({ row, index }))
      .filter(
        (item) =>
          (!header || item.index > 0) &&
          (!query ||
            item.row.some((value) =>
              value.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
            )),
      );
    if (sort) {
      const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
      data.sort((a, b) => {
        const left = a.row[sort.column] || '';
        const right = b.row[sort.column] || '';
        const numeric =
          left.trim() &&
          right.trim() &&
          Number.isFinite(Number(left)) &&
          Number.isFinite(Number(right));
        return (
          sort.order * (numeric ? Number(left) - Number(right) : collator.compare(left, right)) ||
          a.index - b.index
        );
      });
    }
    return data;
  }, [sheets, sheet, query, sort, header]);
  useEffect(() => {
    const worker = new Worker('/preview-table-worker.js');
    const timeout = setTimeout(() => {
      worker.terminate();
      setError('The table took too long to open. Download it to view locally.');
    }, 20000);
    worker.onmessage = (event) => {
      clearTimeout(timeout);
      if (event.data.error) setError(event.data.error);
      else {
        setSheets(event.data.sheets);
        setLimited(!!event.data.limitedSheets);
      }
      worker.terminate();
    };
    worker.onerror = () => {
      clearTimeout(timeout);
      setError('The table could not be opened.');
      worker.terminate();
    };
    worker.postMessage({ kind, url, text, extension, truncated });
    return () => {
      clearTimeout(timeout);
      worker.terminate();
    };
  }, [kind, url, text, extension, truncated]);
  if (error)
    return (
      <p className="preview-message" role="alert">
        {error}
      </p>
    );
  if (!sheets.length)
    return (
      <div className="preview-message" role="status">
        <LoaderCircle className="spin" size={23} />
        Opening table…
      </div>
    );
  const active = sheets[sheet];
  const visible = rows.slice(page * 100, page * 100 + 100);
  const pages = Math.max(1, Math.ceil(rows.length / 100));
  const columns = Math.max(1, ...active.rows.map((row) => row.length));
  const columnName = (index: number) => {
    let name = '';
    for (let value = index + 1; value; value = Math.floor((value - 1) / 26))
      name = String.fromCharCode(65 + ((value - 1) % 26)) + name;
    return name;
  };
  return (
    <div className="preview-table-view">
      <div className="preview-view-tools">
        <input
          type="search"
          aria-label="Search table"
          placeholder="Search preview rows…"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setPage(0);
          }}
        />
        <label className="preview-check">
          <input
            type="checkbox"
            checked={header}
            onChange={(e) => {
              setHeader(e.target.checked);
              setPage(0);
            }}
          />
          First row is header
        </label>
        <span className="small muted">{rows.length} preview rows · click a column to sort</span>
      </div>
      <div className="preview-sheet-tabs" role="tablist" aria-label="Workbook sheets">
        {sheets.map((item, index) => (
          <button
            key={index}
            role="tab"
            aria-selected={sheet === index}
            onClick={() => {
              setSheet(index);
              setPage(0);
              setSort(null);
              setCell(null);
            }}
          >
            {item.name}
          </button>
        ))}
      </div>
      {(active.truncated || limited) && (
        <p className="preview-notice">
          Limited preview: up to 1,000 rows, 50 columns, and 20 sheets. Download for the full
          workbook.
        </p>
      )}
      <div
        className="preview-table-scroll"
        tabIndex={0}
        role="region"
        aria-label={`${active.name} table`}
      >
        <table>
          <thead>
            <tr>
              <th scope="col">Row</th>
              {Array.from({ length: columns }, (_, i) => (
                <th
                  scope="col"
                  key={i}
                  aria-sort={
                    sort?.column === i ? (sort.order === 1 ? 'ascending' : 'descending') : 'none'
                  }
                >
                  <button
                    className="table-sort"
                    onClick={() => {
                      setSort(
                        sort?.column === i
                          ? sort.order === 1
                            ? { column: i, order: -1 }
                            : null
                          : { column: i, order: 1 },
                      );
                      setPage(0);
                    }}
                  >
                    {header ? active.rows[0]?.[i] || columnName(i) : columnName(i)}{' '}
                    {sort?.column === i ? (sort.order === 1 ? '↑' : '↓') : '↕'}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visible.map(({ row, index }) => (
              <tr key={index}>
                <th scope="row">{index + 1}</th>
                {Array.from({ length: columns }, (_, c) => (
                  <td key={c}>
                    <button
                      className="table-cell"
                      title={row[c] || ''}
                      aria-label={`View cell ${columnName(c)}${index + 1}`}
                      onClick={() => {
                        setCell({ value: row[c] || '', label: `${columnName(c)}${index + 1}` });
                        setCopied('');
                      }}
                    >
                      {row[c] || '\u00a0'}
                    </button>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {!rows.length && (
          <p className="preview-message">
            {query ? 'No matching preview rows.' : 'This sheet has no data rows.'}
          </p>
        )}
      </div>
      {cell && (
        <section className="preview-cell-detail" aria-label="Cell value">
          <div className="preview-view-tools">
            <strong>Cell {cell.label}</strong>
            <button
              className="preview-tool"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(cell.value);
                  setCopied('Copied');
                } catch {
                  setCopied('Select the value to copy.');
                }
              }}
            >
              Copy value
            </button>
            <span role="status">{copied}</span>
            <button className="preview-tool" onClick={() => setCell(null)}>
              Close cell
            </button>
          </div>
          <textarea readOnly aria-label={`Cell ${cell.label} value`} value={cell.value} />
        </section>
      )}
      <div className="preview-pagination">
        <span>
          {rows.length
            ? `${page * 100 + 1}–${Math.min((page + 1) * 100, rows.length)} of ${rows.length} preview rows`
            : '0 rows'}
        </span>
        <button
          className="icon-button"
          aria-label="Previous table page"
          disabled={page === 0}
          onClick={() => setPage(page - 1)}
        >
          <ChevronLeft size={18} />
        </button>
        <button
          className="icon-button"
          aria-label="Next table page"
          disabled={page + 1 >= pages}
          onClick={() => setPage(page + 1)}
        >
          <ChevronRight size={18} />
        </button>
      </div>
    </div>
  );
}
