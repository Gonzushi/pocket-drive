'use client';
import { useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, LoaderCircle, ZoomIn, ZoomOut } from 'lucide-react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
export default function PreviewPdf({ url }: { url: string }) {
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null); const [page, setPage] = useState(1); const [zoom, setZoom] = useState(1); const [error, setError] = useState(''); const [busy, setBusy] = useState(true); const canvas = useRef<HTMLCanvasElement>(null); const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(600);
  useEffect(() => { const observer = new ResizeObserver(entries => setWidth(Math.max(200, entries[0].contentRect.width - 32))); observer.observe(box.current!); return () => observer.disconnect(); }, []);
  useEffect(() => {
    let cancelled = false; let task: import('pdfjs-dist').PDFDocumentLoadingTask | undefined;
    import('pdfjs-dist').then(pdf => {
      if (cancelled) return;
      pdf.GlobalWorkerOptions.workerSrc = '/preview-assets/pdf.worker.min.mjs';
      task = pdf.getDocument({ url, cMapUrl: '/preview-assets/cmaps/', cMapPacked: true, standardFontDataUrl: '/preview-assets/standard_fonts/', useWasm: false, disableAutoFetch: true, disableStream: true });
      task.onPassword = () => { if (!cancelled) { setError('This PDF is password protected. Download it to open locally.'); setBusy(false); } void task?.destroy(); };
      return task.promise.then(value => { if (!cancelled) setDocument(value); });
    }).catch(() => { if (!cancelled) { setError('This PDF could not be opened. It may be damaged or unsupported.'); setBusy(false); } });
    return () => { cancelled = true; void task?.destroy(); };
  }, [url]);
  useEffect(() => {
    if (!document) return;
    let cancelled = false; let render: import('pdfjs-dist').RenderTask | undefined;
    setBusy(true);
    document.getPage(page).then(value => {
      if (cancelled || !canvas.current) return;
      const original = value.getViewport({ scale: 1 });
      const viewport = value.getViewport({ scale: Math.min(width / original.width, 1.5) * zoom });
      const ratio = Math.min(window.devicePixelRatio || 1, 2, Math.sqrt(16_000_000 / (viewport.width * viewport.height)));
      canvas.current.width = Math.floor(viewport.width * ratio); canvas.current.height = Math.floor(viewport.height * ratio);
      canvas.current.style.width = `${viewport.width}px`; canvas.current.style.height = `${viewport.height}px`;
      render = value.render({ canvas: canvas.current, viewport, transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : undefined });
      return render.promise;
    }).then(() => { if (!cancelled) setBusy(false); }).catch(error => { if (!cancelled && error?.name !== 'RenderingCancelledException') { setError('This PDF page could not be rendered.'); setBusy(false); } });
    return () => { cancelled = true; render?.cancel(); };
  }, [document, page, zoom, width]);
  return <div className="preview-pdf-view"><div className="preview-view-tools"><button className="icon-button" aria-label="Previous PDF page" disabled={!document || page === 1} onClick={() => setPage(page - 1)}><ChevronLeft size={18} /></button><span>Page {page} of {document?.numPages || '…'}</span><button className="icon-button" aria-label="Next PDF page" disabled={!document || page >= document.numPages} onClick={() => setPage(page + 1)}><ChevronRight size={18} /></button><button className="icon-button" aria-label="Zoom out PDF" disabled={zoom <= .5} onClick={() => setZoom(Math.max(.5, zoom - .25))}><ZoomOut size={18} /></button><span>{Math.round(zoom * 100)}%</span><button className="icon-button" aria-label="Zoom in PDF" disabled={zoom >= 3} onClick={() => setZoom(Math.min(3, zoom + .25))}><ZoomIn size={18} /></button></div><div className="preview-pdf-canvas" ref={box}>{error ? <p className="preview-message" role="alert">{error}</p> : <>{busy && <div className="preview-pdf-loading" role="status"><LoaderCircle className="spin" size={22} />Loading PDF…</div>}<canvas ref={canvas} aria-label={`PDF page ${page}`} role="img" /></>}</div></div>;
}
