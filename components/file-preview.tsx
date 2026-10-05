'use client';
import { useEffect, useId, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { ArrowDownToLine, ChevronLeft, ChevronRight, FileText, FolderClosed, LoaderCircle, RefreshCw, X, Info, Maximize } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import Link from 'next/link';
import PreviewMedia, { usePrepared } from './preview-media';
import ImagePreview from './preview-image';
import { formatBytes, formatDate } from '@/lib/client';
import type { FileItem } from '@/lib/types';
import type { PreviewKind } from '@/lib/preview-kind';
const PreviewCode = dynamic(() => import('./preview-code'), { ssr: false, loading: () => <Loading /> });
const PreviewPdf = dynamic(() => import('./preview-pdf'), { ssr: false, loading: () => <Loading /> });
const PreviewTable = dynamic(() => import('./preview-table'), { ssr: false, loading: () => <Loading /> });
type Info = { kind: PreviewKind; extension: string; supported: boolean; reason: string | null };
type Text = { text: string; truncated: boolean; encoding: string };
type Archive = { entries: { name: string; size: number; directory: boolean; encrypted: boolean }[]; total: number; truncated: boolean };
function Loading() { return <div className="preview-message" role="status"><LoaderCircle className="spin" size={25} />Loading preview…</div>; }
async function readJson<T>(url: string, signal: AbortSignal): Promise<T> { const response = await fetch(url, { signal, credentials: 'same-origin' }); const data = await response.json(); if (!response.ok) throw new Error(data.error || 'The preview could not be loaded.'); return data; }
function FileDetails({ file }: { file: FileItem }) { return <dl className="preview-details"><div><dt>File type</dt><dd>{file.name.includes('.') ? file.name.split('.').pop()?.toUpperCase() : 'File'}</dd></div><div><dt>Size</dt><dd>{formatBytes(file.size)}</dd></div><div><dt>Uploaded</dt><dd>{formatDate(file.created_at)}</dd></div></dl>; }
function OfficePreview({ id }: { id: string }) { const prepared = usePrepared(id, 'document'); return prepared.status === 'ready' && prepared.url ? <PreviewPdf url={prepared.url} /> : <div className="preview-message" role={prepared.status === 'failed' ? 'alert' : 'status'}>{prepared.status === 'failed' ? <><FileText size={32} />{prepared.error}</> : <><LoaderCircle size={25} className="spin" />Preparing document preview…</>}</div>; }
function PreviewBody({ file }: { file: FileItem }) {
  const url = `/api/files/${file.id}/preview`; const [info, setInfo] = useState<Info | null>(null); const [text, setText] = useState<Text | null>(null); const [archive, setArchive] = useState<Archive | null>(null); const [error, setError] = useState(''); const [retry, setRetry] = useState(0); const [source, setSource] = useState(false); const [search, setSearch] = useState(''); const [page, setPage] = useState(0);
  useEffect(() => {
    const controller = new AbortController(); setError(''); setInfo(null); setText(null); setArchive(null);
    (async () => {
      const value = await readJson<Info>(url, controller.signal);
      if (value.supported && ['text', 'markdown', 'table'].includes(value.kind)) setText(await readJson<Text>(`${url}/text`, controller.signal));
      if (value.supported && value.kind === 'archive') setArchive(await readJson<Archive>(`${url}/archive`, controller.signal));
      if (!controller.signal.aborted) setInfo(value);
    })().catch(error => { if (!controller.signal.aborted) setError(error.message); });
    return () => controller.abort();
  }, [url, retry]);
  if (error) return <div className="preview-fallback"><FileText size={40} /><h3>Preview couldn’t load</h3><p role="alert">{error}</p><button className="button secondary" onClick={() => setRetry(retry + 1)}><RefreshCw size={16} />Retry preview</button><FileDetails file={file} /></div>;
  if (!info) return <Loading />;
  if (!info.supported) return <div className="preview-fallback"><FileText size={44} /><h3>No preview available</h3><p>{info.reason} Download the original file to open it.</p><FileDetails file={file} /><a className="button primary" href={`/api/files/${file.id}/download`}><ArrowDownToLine size={16} />Download file</a></div>;
  if (info.kind === 'image') return <ImagePreview url={`${url}/content`} name={file.name} />;
  if (info.kind === 'pdf') return <PreviewPdf url={`${url}/content`} />;
  if (info.kind === 'office') return <OfficePreview id={file.id} />;
  if (['audio', 'video'].includes(info.kind)) return <PreviewMedia id={file.id} name={file.name} video={info.kind === 'video'} />;
  if (info.kind === 'workbook') return <PreviewTable kind="workbook" url={`${url}/content`} extension={info.extension} />;
  if (info.kind === 'archive' && archive) {
    const entries = archive.entries.filter(entry => entry.name.toLowerCase().includes(search.toLowerCase())); const pages = Math.max(1, Math.ceil(entries.length / 100));
    return <div className="preview-archive"><div className="preview-view-tools"><span>{archive.total} archive entries</span><input type="search" aria-label="Search archive contents" placeholder="Search contents…" value={search} onChange={event => { setSearch(event.target.value); setPage(0); }} /></div>{archive.truncated && <p className="preview-notice">Showing the first 1,000 entries. Download to see the full archive.</p>}<div className="preview-table-scroll" tabIndex={0} role="region" aria-label="ZIP contents"><table><thead><tr><th scope="col">Name</th><th scope="col">Size</th></tr></thead><tbody>{entries.slice(page * 100, page * 100 + 100).map((entry, index) => <tr key={index}><td><span className="preview-archive-name">{entry.directory ? <FolderClosed size={16} /> : <FileText size={16} />}{entry.name}{entry.encrypted && <span className="muted"> · Encrypted</span>}</span></td><td>{entry.directory ? '—' : formatBytes(entry.size)}</td></tr>)}</tbody></table>{!entries.length && <p className="preview-message">{search ? 'No matching entries.' : 'This archive is empty.'}</p>}</div><div className="preview-pagination"><span>Page {page + 1} of {pages}</span><button className="icon-button" aria-label="Previous archive page" disabled={!page} onClick={() => setPage(page - 1)}><ChevronLeft size={18} /></button><button className="icon-button" aria-label="Next archive page" disabled={page + 1 >= pages} onClick={() => setPage(page + 1)}><ChevronRight size={18} /></button></div></div>;
  }
  if (text) return <div className="preview-text-view">{['markdown', 'table'].includes(info.kind) && <div className="preview-view-tools"><button className={`preview-mode${!source ? ' selected' : ''}`} onClick={() => setSource(false)}>{info.kind === 'markdown' ? 'Formatted' : 'Table'}</button><button className={`preview-mode${source ? ' selected' : ''}`} onClick={() => setSource(true)}>Source</button></div>}{text.truncated && <p className="preview-notice">Showing up to 512 KB. Download to see the full file.</p>}{info.kind === 'markdown' && !source ? <article className="preview-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={{ img: ({ alt }) => <span className="muted">[Image: {alt || 'external image'}]</span>, a: ({ children, href }) => <a href={href} target="_blank" rel="noopener noreferrer">{children}</a> }}>{text.text}</ReactMarkdown></article> : info.kind === 'table' && !source ? <PreviewTable kind="table" url={url} text={text.text} extension={info.extension} truncated={text.truncated} /> : <PreviewCode text={text.text} extension={info.extension} id={file.id} encoding={text.encoding} />}</div>;
  return <Loading />;
}
export default function FilePreview({ files: initialFiles, initialId, listing, total: initialTotal, onClose }: { files: FileItem[]; initialId: string; listing: string; total: number; onClose: () => void }) {
  const [files, setFiles] = useState(initialFiles); const [total, setTotal] = useState(initialTotal);
  const [index, setIndex] = useState(Math.max(0, initialFiles.findIndex(file => file.id === initialId))); const ref = useRef<HTMLDialogElement>(null); const title = useId(); const file = files[index];
  const [details, setDetails] = useState(false); const [expanded, setExpanded] = useState(false); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const paging = useRef<AbortController | null>(null); const offset = useRef(initialFiles.length);
  useEffect(() => { const dialog = ref.current!; const trigger = window.document.activeElement as HTMLElement | null; const overflow = window.document.body.style.overflow; const scroll = { top: window.scrollY, left: window.scrollX }; dialog.showModal(); window.document.body.style.overflow = 'hidden'; return () => { paging.current?.abort(); window.document.body.style.overflow = overflow; dialog.close(); trigger?.focus({ preventScroll: true }); window.scrollTo({ ...scroll, behavior: 'instant' }); }; }, []);
  async function nextFile() {
    if (index + 1 < files.length) { setIndex(index + 1); return; }
    if (paging.current || offset.current >= total) return;
    const controller = new AbortController(); paging.current = controller; setBusy(true); setError('');
    try {
      let fresh: FileItem[] = [];
      do {
        const response = await readJson<{ files: FileItem[]; total: number }>(`/api/files?${listing}&offset=${offset.current}`, controller.signal);
        offset.current += response.files.length; setTotal(response.total);
        fresh = response.files.filter(item => !files.some(loaded => loaded.id === item.id));
        if (!response.files.length) break;
        if (fresh.length) { setFiles(previous => [...previous, ...fresh]); setIndex(index + 1); break; }
      } while (offset.current < total && !controller.signal.aborted);
    } catch (error) { if (!controller.signal.aborted) setError((error as Error).message); }
    finally { if (!controller.signal.aborted) { paging.current = null; setBusy(false); } }
  }
  useEffect(() => {
    const key = (event: KeyboardEvent) => { const target = event.target as HTMLElement; if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || ['INPUT', 'TEXTAREA', 'SELECT', 'AUDIO', 'VIDEO'].includes(target?.tagName) || target?.closest('[role="region"], .cm-editor, .preview-view-tools')) return;
      if (event.key === 'ArrowLeft') { event.preventDefault(); setIndex(current => Math.max(0, current - 1)); }
      if (event.key === 'ArrowRight') { event.preventDefault(); void nextFile(); }
    }; const dialog = ref.current!; dialog.addEventListener('keydown', key); return () => dialog.removeEventListener('keydown', key);
  });
  return <dialog className={`preview-dialog${expanded ? ' expanded' : ''}`} ref={ref} aria-labelledby={title} onCancel={event => { event.preventDefault(); onClose(); }} onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="preview-shell"><header className="preview-header"><div className="preview-title"><FileText size={21} /><div><h2 id={title} title={file.name}>{file.name}</h2><span>{formatBytes(file.size)} · {index + 1} of {total} files</span></div></div><div className="preview-header-actions"><Link className="icon-button" href={'/assistant?file=' + file.id} aria-label="Ask assistant about this file" onClick={onClose}><FileText size={18} /></Link><button className="icon-button" aria-label="File details" aria-pressed={details} onClick={() => setDetails(!details)}><Info size={18} /></button><button className="icon-button" aria-label={expanded ? 'Restore preview size' : 'Expand preview'} aria-pressed={expanded} onClick={() => setExpanded(!expanded)}><Maximize size={18} /></button><a className="button secondary" href={`/api/files/${file.id}/download`}><ArrowDownToLine size={17} /><span>Download</span></a><button className="icon-button" aria-label="Close preview" onClick={onClose} autoFocus><X size={22} /></button></div></header>
    <div className="preview-navigation"><button className="button secondary" aria-label="Previous file" disabled={index === 0 || busy} onClick={() => setIndex(index - 1)}><ChevronLeft size={18} />Previous</button><span className="small muted" role="status">{error || (busy ? 'Loading next files…' : 'Files in this view')}</span><button className="button secondary" aria-label="Next file" disabled={busy || index + 1 >= files.length && offset.current >= total} onClick={() => void nextFile()}>Next<ChevronRight size={18} /></button></div>
    <div className="preview-workspace"><div className="preview-body"><PreviewBody key={file.id} file={file} /></div>{details && <aside className="preview-info" aria-label="File details"><h3>File details</h3><p className="preview-full-name">{file.name}</p><FileDetails file={file} />{file.location && <p>Location: {file.location}</p>}<p className="small muted">SHA-256</p><code className="preview-checksum">{file.checksum}</code></aside>}</div></div>
  </dialog>;
}
