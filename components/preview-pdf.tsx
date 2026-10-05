'use client';
import { useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, LoaderCircle, ZoomIn, ZoomOut } from 'lucide-react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import styles from './preview-pdf.module.css';
import { usePreviewState } from './preview-state';
function Thumbnail({ document, page }: { document: PDFDocumentProxy; page: number }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => { let cancelled = false; let render: import('pdfjs-dist').RenderTask | undefined; const observer = new IntersectionObserver(entries => { if (!entries.some(entry => entry.isIntersecting)) return; observer.disconnect(); void document.getPage(page).then(value => { if (cancelled || !canvas.current) return; const base = value.getViewport({ scale: 1 }); const viewport = value.getViewport({ scale: 70 / base.width }); canvas.current.width = Math.ceil(viewport.width); canvas.current.height = Math.ceil(viewport.height); render = value.render({ canvas: canvas.current, viewport }); return render.promise; }).catch(() => {}); }, { rootMargin: '100px' }); observer.observe(canvas.current!); return () => { cancelled = true; observer.disconnect(); render?.cancel(); }; }, [document, page]);
  return <canvas ref={canvas} width="70" height="90" aria-label={`Thumbnail of page ${page}`} />;
}
export default function PreviewPdf({ url }: { url: string }) {
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null); const [page, setPage] = usePreviewState(url, 'pdf-page', 1); const [zoom, setZoom] = usePreviewState(url, 'pdf-zoom', 1); const [error, setError] = useState(''); const [busy, setBusy] = useState(true); const canvas = useRef<HTMLCanvasElement>(null); const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(600); const [height, setHeight] = useState(500); const [fit, setFit] = useState('width'); const layer = useRef<HTMLDivElement>(null);
  const [rotation, setRotation] = usePreviewState(url, 'pdf-rotation', 0);
  const [query, setQuery] = useState(''); const [matches, setMatches] = useState<number[]>([]); const [searching, setSearching] = useState(false); const [jump, setJump] = useState('');
  const [thumbnails, setThumbnails] = useState(false);
  useEffect(() => { if (!document || !query.trim()) { setMatches([]); return; } let cancelled = false; setSearching(true); const timer = setTimeout(async () => { const found: number[] = []; try { for (let i = 1; i <= Math.min(document.numPages, 500); i++) { if (cancelled) return; const content = await (await document.getPage(i)).getTextContent(); if (content.items.map(item => 'str' in item ? item.str : '').join(' ').toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())) found.push(i); } if (!cancelled) setMatches(found); } catch { if (!cancelled) setMatches(found); } finally { if (!cancelled) setSearching(false); } }, 300); return () => { cancelled = true; clearTimeout(timer); }; }, [document, query]);
  useEffect(() => { const observer = new ResizeObserver(entries => { setWidth(Math.max(100, entries[0].contentRect.width - 32)); setHeight(Math.max(100, entries[0].contentRect.height - 32)); }); observer.observe(box.current!); return () => observer.disconnect(); }, []);
  useEffect(() => {
    let cancelled = false; let task: import('pdfjs-dist').PDFDocumentLoadingTask | undefined;
    import('pdfjs-dist').then(pdf => {
      if (cancelled) return;
      pdf.GlobalWorkerOptions.workerSrc = '/preview-assets/pdf.worker.min.mjs';
      task = pdf.getDocument({ url, cMapUrl: '/preview-assets/cmaps/', cMapPacked: true, standardFontDataUrl: '/preview-assets/standard_fonts/', useWasm: false, disableAutoFetch: true, disableStream: true });
      task.onPassword = () => { if (!cancelled) { setError('This PDF is password protected. Download it to open locally.'); setBusy(false); } void task?.destroy(); };
      return task.promise.then(value => { if (!cancelled) { setPage(current => Math.max(1, Math.min(value.numPages, Math.floor(current)))); setZoom(current => Math.max(.5, Math.min(3, current))); setDocument(value); } });
    }).catch(() => { if (!cancelled) { setError('This PDF could not be opened. It may be damaged or unsupported.'); setBusy(false); } });
    return () => { cancelled = true; void task?.destroy(); };
  }, [url]);
  useEffect(() => {
    if (!document) return;
    let cancelled = false; let render: import('pdfjs-dist').RenderTask | undefined; let textRender: import('pdfjs-dist').TextLayer | undefined;
    setBusy(true);
    document.getPage(page).then(value => {
      if (cancelled || !canvas.current) return;
      const angle = (value.rotate + (Number.isFinite(rotation) ? Math.round(rotation / 90) * 90 : 0) + 360) % 360;
      const original = value.getViewport({ scale: 1, rotation: angle });
      const viewport = value.getViewport({ scale: Math.min(width / original.width, fit === 'page' ? height / original.height : Infinity) * zoom, rotation: angle });
      const ratio = Math.min(window.devicePixelRatio || 1, 2, Math.sqrt(16_000_000 / (viewport.width * viewport.height)));
      canvas.current.width = Math.floor(viewport.width * ratio); canvas.current.height = Math.floor(viewport.height * ratio);
      canvas.current.style.width = `${viewport.width}px`; canvas.current.style.height = `${viewport.height}px`;
      render = value.render({ canvas: canvas.current, viewport, transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : undefined });
      if (layer.current) { const container = layer.current; container.replaceChildren(); container.style.setProperty('--total-scale-factor', String(viewport.scale)); container.style.width = `${viewport.width}px`; container.style.height = `${viewport.height}px`; void import('pdfjs-dist').then(async pdf => { if (cancelled) return; const content = await value.getTextContent(); if (cancelled) return; textRender = new pdf.TextLayer({ textContentSource: content, container, viewport }); await textRender.render(); if (!cancelled) for (const span of container.querySelectorAll('span')) { span.style.backgroundColor = query.trim() && span.textContent?.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()) ? '#ffdb6b99' : ''; } }).catch(() => {}); }
      return render.promise;
    }).then(() => { if (!cancelled) setBusy(false); }).catch(error => { if (!cancelled && error?.name !== 'RenderingCancelledException') { setError('This PDF page could not be rendered.'); setBusy(false); } });
    return () => { cancelled = true; render?.cancel(); textRender?.cancel(); };
  }, [document, page, zoom, width, height, fit, rotation, query]);
  return <div className="preview-pdf-view"><div className="preview-view-tools"><button className="icon-button" aria-label="Previous PDF page" disabled={!document || page === 1} onClick={() => setPage(page - 1)}><ChevronLeft size={18} /></button><span>Page {page} of {document?.numPages || '…'}</span><button className="icon-button" aria-label="Next PDF page" disabled={!document || page >= document.numPages} onClick={() => setPage(page + 1)}><ChevronRight size={18} /></button><button className="icon-button" aria-label="Zoom out PDF" disabled={zoom <= .5} onClick={() => setZoom(Math.max(.5, zoom - .25))}><ZoomOut size={18} /></button><span>{Math.round(zoom * 100)}%</span><button className="icon-button" aria-label="Zoom in PDF" disabled={zoom >= 3} onClick={() => setZoom(Math.min(3, zoom + .25))}><ZoomIn size={18} /></button><button className="preview-tool" onClick={() => { setFit('width'); setZoom(1); }}>Fit width</button><button className="preview-tool" onClick={() => { setFit('page'); setZoom(1); }}>Fit page</button><button className="preview-tool" onClick={() => setRotation((rotation + 90) % 360)}>Rotate</button><button className="preview-tool" aria-pressed={thumbnails} onClick={() => setThumbnails(!thumbnails)}>Pages</button><form className="code-jump" onSubmit={e => { e.preventDefault(); const n = Math.floor(Number(jump)); if (document && n >= 1 && n <= document.numPages) setPage(n); }}><input aria-label="Go to PDF page" type="number" min="1" max={document?.numPages} value={jump} onChange={e => setJump(e.target.value)} placeholder="Page" /><button className="preview-tool">Go</button></form><input type="search" aria-label="Search PDF" placeholder="Find in document…" value={query} onChange={e => setQuery(e.target.value)} /></div>{query && <div className="preview-view-tools" role="status">{searching ? "Searching…" : `${matches.length} matching pages${document && document.numPages > 500 ? " in first 500 pages" : ""}`}{matches.slice(0, 100).map(n => <button className="preview-tool" key={n} onClick={() => setPage(n)}>Page {n}</button>)}</div>}{thumbnails && document && <div className="pdf-page-rail" aria-label="PDF pages">{Array.from({ length: Math.min(document.numPages, 200) }, (_, i) => <button className="preview-tool" aria-current={page === i + 1 ? "page" : undefined} key={i} onClick={() => setPage(i + 1)}><Thumbnail document={document} page={i + 1} />Page {i + 1}</button>)}</div>}<div className="preview-pdf-canvas" ref={box}>{error ? <p className="preview-message" role="alert">{error}</p> : <>{busy && <div className="preview-pdf-loading" role="status"><LoaderCircle className="spin" size={22} />Loading PDF…</div>}<div className="pdf-page-surface"><canvas ref={canvas} aria-label={`PDF page ${page}`} role="img" /><div className={'textLayer ' + styles.textLayer} ref={layer} /></div></>}</div></div>;
}
