'use client';
import { useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight, LoaderCircle } from 'lucide-react';
type Sheet = { name: string; rows: string[][]; truncated: boolean; totalRows: number };
export default function PreviewTable({ kind, url, text, extension, truncated }: { kind: string; url: string; text?: string; extension: string; truncated?: boolean }) {
  const [sheets, setSheets] = useState<Sheet[]>([]); const [sheet, setSheet] = useState(0); const [page, setPage] = useState(0); const [error, setError] = useState(''); const [limited, setLimited] = useState(false);
  useEffect(() => {
    const worker = new Worker('/preview-table-worker.js');
    const timeout = setTimeout(() => { worker.terminate(); setError('The table took too long to open. Download it to view locally.'); }, 20000);
    worker.onmessage = event => { clearTimeout(timeout); if (event.data.error) setError(event.data.error); else { setSheets(event.data.sheets); setLimited(!!event.data.limitedSheets); } worker.terminate(); };
    worker.onerror = () => { clearTimeout(timeout); setError('The table could not be opened.'); worker.terminate(); };
    worker.postMessage({ kind, url, text, extension, truncated });
    return () => { clearTimeout(timeout); worker.terminate(); };
  }, [kind, url, text, extension, truncated]);
  if (error) return <p className="preview-message" role="alert">{error}</p>;
  if (!sheets.length) return <div className="preview-message" role="status"><LoaderCircle className="spin" size={23} />Opening table…</div>;
  const active = sheets[sheet]; const visible = active.rows.slice(page * 100, page * 100 + 100); const pages = Math.max(1, Math.ceil(active.rows.length / 100));
  const columns = Math.max(1, ...active.rows.map(row => row.length));
  const columnName = (index: number) => { let name = ''; for (let value = index + 1; value; value = Math.floor((value - 1) / 26)) name = String.fromCharCode(65 + (value - 1) % 26) + name; return name; };
  return <div className="preview-table-view">
    <div className="preview-sheet-tabs" role="tablist" aria-label="Workbook sheets">{sheets.map((item, index) => <button key={index} role="tab" aria-selected={sheet === index} onClick={() => { setSheet(index); setPage(0); }}>{item.name}</button>)}</div>
    {(active.truncated || limited) && <p className="preview-notice">Limited preview: up to 1,000 rows, 50 columns, and 20 sheets. Download for the full workbook.</p>}
    <div className="preview-table-scroll" tabIndex={0} role="region" aria-label={`${active.name} table`}><table><thead><tr><th scope="col">Row</th>{Array.from({ length: columns }, (_, i) => <th scope="col" key={i}>{columnName(i)}</th>)}</tr></thead><tbody>{visible.map((row, r) => <tr key={r}><th scope="row">{page * 100 + r + 1}</th>{Array.from({ length: columns }, (_, c) => <td key={c} title={row[c] || ''}>{row[c] || ''}</td>)}</tr>)}</tbody></table>{!active.rows.length && <p className="preview-message">This sheet is empty.</p>}</div>
    <div className="preview-pagination"><span>{active.rows.length ? `${page * 100 + 1}–${Math.min((page + 1) * 100, active.rows.length)} of ${active.rows.length} preview rows` : '0 rows'}</span><button className="icon-button" aria-label="Previous table page" disabled={page === 0} onClick={() => setPage(page - 1)}><ChevronLeft size={18} /></button><button className="icon-button" aria-label="Next table page" disabled={page + 1 >= pages} onClick={() => setPage(page + 1)}><ChevronRight size={18} /></button></div>
  </div>;
}
