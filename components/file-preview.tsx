'use client';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { ArrowDownToLine, ChevronLeft, ChevronRight, FileText, FolderClosed, LoaderCircle, RefreshCw, X, ZoomIn, ZoomOut } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import hljs from 'highlight.js/lib/core';
import sql from 'highlight.js/lib/languages/sql';
import scala from 'highlight.js/lib/languages/scala';
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import python from 'highlight.js/lib/languages/python';
import json from 'highlight.js/lib/languages/json';
import xml from 'highlight.js/lib/languages/xml';
import css from 'highlight.js/lib/languages/css';
import bash from 'highlight.js/lib/languages/bash';
import yaml from 'highlight.js/lib/languages/yaml';
import java from 'highlight.js/lib/languages/java';
import 'highlight.js/styles/github.css';
import { formatBytes, formatDate } from '@/lib/client';
import type { FileItem } from '@/lib/types';
import type { PreviewKind } from '@/lib/preview-kind';
for (const [name, language] of Object.entries({ sql, scala, javascript, typescript, python, json, xml, css, bash, yaml, java })) hljs.registerLanguage(name, language);
const PreviewPdf = dynamic(() => import('./preview-pdf'), { ssr: false, loading: () => <Loading /> });
const PreviewTable = dynamic(() => import('./preview-table'), { ssr: false, loading: () => <Loading /> });
type Info = { kind: PreviewKind; extension: string; supported: boolean; reason: string | null };
type Text = { text: string; truncated: boolean; encoding: string };
type Archive = { entries: { name: string; size: number; directory: boolean; encrypted: boolean }[]; total: number; truncated: boolean };
function Loading() { return <div className="preview-message" role="status"><LoaderCircle className="spin" size={25} />Loading preview…</div>; }
async function readJson<T>(url: string, signal: AbortSignal): Promise<T> { const response = await fetch(url, { signal, credentials: 'same-origin' }); const data = await response.json(); if (!response.ok) throw new Error(data.error || 'The preview could not be loaded.'); return data; }
function FileDetails({ file }: { file: FileItem }) { return <dl className="preview-details"><div><dt>File type</dt><dd>{file.name.includes('.') ? file.name.split('.').pop()?.toUpperCase() : 'File'}</dd></div><div><dt>Size</dt><dd>{formatBytes(file.size)}</dd></div><div><dt>Uploaded</dt><dd>{formatDate(file.created_at)}</dd></div></dl>; }
function ImagePreview({ url, name }: { url: string; name: string }) {
  const [zoom, setZoom] = useState(1); const [busy, setBusy] = useState(true); const [error, setError] = useState(false);
  const box = useRef<HTMLDivElement>(null); const [bounds, setBounds] = useState({ width: 800, height: 500 }); const [natural, setNatural] = useState({ width: 0, height: 0 });
  useEffect(() => { const observer = new ResizeObserver(entries => setBounds({ width: entries[0].contentRect.width, height: entries[0].contentRect.height })); observer.observe(box.current!); return () => observer.disconnect(); }, []);
  const fit = natural.width ? Math.max(.01, Math.min((bounds.width - 32) / natural.width, (bounds.height - 32) / natural.height, 1)) : 1;
  return <div className="preview-image-view"><div className="preview-view-tools"><button className="icon-button" aria-label="Zoom out image" disabled={zoom <= .5} onClick={() => setZoom(Math.max(.5, zoom - .25))}><ZoomOut size={18} /></button><span>{Math.round(zoom * 100)}%</span><button className="icon-button" aria-label="Zoom in image" disabled={zoom >= 3} onClick={() => setZoom(Math.min(3, zoom + .25))}><ZoomIn size={18} /></button><button className="text-button" onClick={() => setZoom(1)}>Fit to screen</button></div><div className="preview-image-canvas" ref={box}>{busy && <Loading />}{error ? <p className="preview-message" role="alert">This image could not be opened. It may be damaged or unsupported by your browser.</p> : <div className="preview-image-stage"><img src={url} alt={name} style={{ width: natural.width ? natural.width * fit * zoom : 'auto', height: natural.height ? natural.height * fit * zoom : 'auto', visibility: busy ? 'hidden' : 'visible' }} onLoad={event => { setNatural({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight }); setBusy(false); }} onError={() => { setBusy(false); setError(true); }} /></div>}</div></div>;
}
function CodePreview({ text, extension }: { text: string; extension: string }) {
  const language = ({ sql: 'sql', scala: 'scala', js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript', ts: 'typescript', tsx: 'typescript', py: 'python', json: 'json', jsonl: 'json', html: 'xml', htm: 'xml', xml: 'xml', svg: 'xml', css: 'css', sh: 'bash', bash: 'bash', zsh: 'bash', yml: 'yaml', yaml: 'yaml', java: 'java' } as Record<string, string>)[extension];
  const lines = text.split('\n'); const shown = lines.slice(0, 2000); const color = language && text.length < 100000 && shown.every(line => line.length < 2000);
  const highlighted = useMemo(() => color ? shown.map(line => hljs.highlight(line, { language, ignoreIllegals: true }).value) : null, [text, language, color]);
  return <>{lines.length > 2000 && <p className="preview-notice">Showing the first 2,000 lines. Download for the full file.</p>}<div className="preview-code" tabIndex={0} role="region" aria-label="File source">{shown.map((line, index) => <div className="preview-code-line" key={index}><span className="preview-line-number" aria-hidden="true">{index + 1}</span>{highlighted ? <code className="hljs" dangerouslySetInnerHTML={{ __html: highlighted[index] || ' ' }} /> : <code>{line || ' '}</code>}</div>)}</div></>;
}
function PreviewBody({ file }: { file: FileItem }) {
  const url = `/api/files/${file.id}/preview`; const [info, setInfo] = useState<Info | null>(null); const [text, setText] = useState<Text | null>(null); const [archive, setArchive] = useState<Archive | null>(null); const [error, setError] = useState(''); const [retry, setRetry] = useState(0); const [source, setSource] = useState(false); const [search, setSearch] = useState(''); const [page, setPage] = useState(0); const [mediaError, setMediaError] = useState(false);
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
  if (['audio', 'video'].includes(info.kind)) return <div className="preview-media">{mediaError ? <p role="alert">This browser cannot play the file’s format or codec. Download it to play locally.</p> : info.kind === 'video' ? <video controls preload="metadata" src={`${url}/content`} onError={() => setMediaError(true)} aria-label={`Play ${file.name}`} /> : <><FileText size={48} /><h3>{file.name}</h3><audio controls preload="metadata" src={`${url}/content`} onError={() => setMediaError(true)} aria-label={`Play ${file.name}`} /></>}<FileDetails file={file} /></div>;
  if (info.kind === 'workbook') return <PreviewTable kind="workbook" url={`${url}/content`} extension={info.extension} />;
  if (info.kind === 'archive' && archive) {
    const entries = archive.entries.filter(entry => entry.name.toLowerCase().includes(search.toLowerCase())); const pages = Math.max(1, Math.ceil(entries.length / 100));
    return <div className="preview-archive"><div className="preview-view-tools"><span>{archive.total} archive entries</span><input type="search" aria-label="Search archive contents" placeholder="Search contents…" value={search} onChange={event => { setSearch(event.target.value); setPage(0); }} /></div>{archive.truncated && <p className="preview-notice">Showing the first 1,000 entries. Download to see the full archive.</p>}<div className="preview-table-scroll" tabIndex={0} role="region" aria-label="ZIP contents"><table><thead><tr><th scope="col">Name</th><th scope="col">Size</th></tr></thead><tbody>{entries.slice(page * 100, page * 100 + 100).map((entry, index) => <tr key={index}><td><span className="preview-archive-name">{entry.directory ? <FolderClosed size={16} /> : <FileText size={16} />}{entry.name}{entry.encrypted && <span className="muted"> · Encrypted</span>}</span></td><td>{entry.directory ? '—' : formatBytes(entry.size)}</td></tr>)}</tbody></table>{!entries.length && <p className="preview-message">{search ? 'No matching entries.' : 'This archive is empty.'}</p>}</div><div className="preview-pagination"><span>Page {page + 1} of {pages}</span><button className="icon-button" aria-label="Previous archive page" disabled={!page} onClick={() => setPage(page - 1)}><ChevronLeft size={18} /></button><button className="icon-button" aria-label="Next archive page" disabled={page + 1 >= pages} onClick={() => setPage(page + 1)}><ChevronRight size={18} /></button></div></div>;
  }
  if (text) return <div className="preview-text-view">{['markdown', 'table'].includes(info.kind) && <div className="preview-view-tools"><button className={`preview-mode${!source ? ' selected' : ''}`} onClick={() => setSource(false)}>{info.kind === 'markdown' ? 'Formatted' : 'Table'}</button><button className={`preview-mode${source ? ' selected' : ''}`} onClick={() => setSource(true)}>Source</button></div>}{text.truncated && <p className="preview-notice">Showing up to 512 KB. Download to see the full file.</p>}{info.kind === 'markdown' && !source ? <article className="preview-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={{ img: ({ alt }) => <span className="muted">[Image: {alt || 'external image'}]</span>, a: ({ children, href }) => <a href={href} target="_blank" rel="noopener noreferrer">{children}</a> }}>{text.text}</ReactMarkdown></article> : info.kind === 'table' && !source ? <PreviewTable kind="table" url={url} text={text.text} extension={info.extension} truncated={text.truncated} /> : <CodePreview text={text.text} extension={info.extension} />}</div>;
  return <Loading />;
}
export default function FilePreview({ files, initialId, onClose }: { files: FileItem[]; initialId: string; onClose: () => void }) {
  const [index, setIndex] = useState(Math.max(0, files.findIndex(file => file.id === initialId))); const ref = useRef<HTMLDialogElement>(null); const title = useId(); const file = files[index];
  useEffect(() => { const dialog = ref.current!; const overflow = document.body.style.overflow; const scroll = { top: window.scrollY, left: window.scrollX }; dialog.showModal(); document.body.style.overflow = 'hidden'; return () => { document.body.style.overflow = overflow; dialog.close(); window.scrollTo({ ...scroll, behavior: 'instant' }); }; }, []);
  useEffect(() => { const key = (event: KeyboardEvent) => { if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || ['INPUT', 'TEXTAREA', 'SELECT', 'AUDIO', 'VIDEO'].includes((event.target as HTMLElement)?.tagName) || (event.target as HTMLElement)?.closest('[role="region"]')) return; if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); setIndex(current => Math.max(0, Math.min(files.length - 1, current + (event.key === 'ArrowRight' ? 1 : -1)))); } }; const dialog = ref.current!; dialog.addEventListener('keydown', key); return () => dialog.removeEventListener('keydown', key); }, [files.length]);
  return <dialog className="preview-dialog" ref={ref} aria-labelledby={title} onCancel={event => { event.preventDefault(); onClose(); }} onClick={event => { if (event.target === event.currentTarget) onClose(); }}><div className="preview-shell"><header className="preview-header"><div className="preview-title"><FileText size={21} /><div><h2 id={title} title={file.name}>{file.name}</h2><span>{formatBytes(file.size)} · {index + 1} of {files.length} loaded files</span></div></div><div className="preview-header-actions"><a className="button secondary" href={`/api/files/${file.id}/download`}><ArrowDownToLine size={17} /><span>Download</span></a><button className="icon-button" aria-label="Close preview" onClick={onClose} autoFocus><X size={22} /></button></div></header><div className="preview-navigation"><button className="button secondary" aria-label="Previous file" disabled={index === 0} onClick={() => setIndex(index - 1)}><ChevronLeft size={18} />Previous</button><span className="small muted">Files in this view</span><button className="button secondary" aria-label="Next file" disabled={index + 1 >= files.length} onClick={() => setIndex(index + 1)}>Next<ChevronRight size={18} /></button></div><div className="preview-body"><PreviewBody key={file.id} file={file} /></div></div></dialog>;
}
