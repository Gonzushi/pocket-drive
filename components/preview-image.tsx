'use client';
import { useEffect, useRef, useState } from 'react';
import { LoaderCircle, RotateCw, ZoomIn, ZoomOut } from 'lucide-react';
import { usePreviewState } from './preview-state';
export default function PreviewImage({ url, name }: { url: string; name: string }) {
  const [zoom, setZoom] = usePreviewState<number | null>(url, 'image-zoom', null); const [rotation, setRotation] = usePreviewState(url, 'image-rotation', 0);
  const [busy, setBusy] = useState(true); const [error, setError] = useState(false);
  const box = useRef<HTMLDivElement>(null); const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef({ distance: 0, scale: 1, x: 0, y: 0, left: 0, top: 0 });
  const [bounds, setBounds] = useState({ width: 800, height: 500 }); const [natural, setNatural] = useState({ width: 0, height: 0 });
  useEffect(() => { const observer = new ResizeObserver(entries => setBounds({ width: entries[0].contentRect.width, height: entries[0].contentRect.height })); observer.observe(box.current!); return () => observer.disconnect(); }, []);
  const angle = Number.isFinite(rotation) ? Math.round(rotation / 90) * 90 % 360 : 0;
  const sideways = Math.abs(angle % 180) === 90; const width = sideways ? natural.height : natural.width; const height = sideways ? natural.width : natural.height;
  const fit = width ? Math.max(.02, Math.min((bounds.width - 32) / width, (bounds.height - 32) / height, 1)) : 1;
  const scale = zoom === null || !Number.isFinite(zoom) ? fit : Math.max(.02, Math.min(4, zoom));
  function start(event: React.PointerEvent<HTMLDivElement>) {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    const node = box.current!; node.setPointerCapture(event.pointerId); pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const points = [...pointers.current.values()]; gesture.current = { scale, distance: points.length === 2 ? Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y) : 0, x: event.clientX, y: event.clientY, left: node.scrollLeft, top: node.scrollTop };
  }
  function move(event: React.PointerEvent<HTMLDivElement>) {
    if (!pointers.current.has(event.pointerId)) return; pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const points = [...pointers.current.values()]; const initial = gesture.current;
    if (points.length === 2 && initial.distance > 0) setZoom(Math.max(.02, Math.min(4, initial.scale * Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y) / initial.distance)));
    else if (points.length === 1) { box.current!.scrollLeft = initial.left + initial.x - event.clientX; box.current!.scrollTop = initial.top + initial.y - event.clientY; }
  }
  function end(event: React.PointerEvent<HTMLDivElement>) { pointers.current.delete(event.pointerId); if (box.current?.hasPointerCapture(event.pointerId)) box.current.releasePointerCapture(event.pointerId); const point = [...pointers.current.values()][0]; if (point) gesture.current = { ...gesture.current, x: point.x, y: point.y, left: box.current!.scrollLeft, top: box.current!.scrollTop }; }
  return <div className="preview-image-view"><div className="preview-view-tools"><button className="icon-button" aria-label="Zoom out image" disabled={scale <= .02} onClick={() => setZoom(Math.max(.02, scale / 1.25))}><ZoomOut size={18} /></button><span>{Math.round(scale * 100)}%</span><button className="icon-button" aria-label="Zoom in image" disabled={scale >= 4} onClick={() => setZoom(Math.min(4, scale * 1.25))}><ZoomIn size={18} /></button><button className="preview-tool" onClick={() => setZoom(null)}>Fit to screen</button><button className="preview-tool" onClick={() => setZoom(1)}>Actual size</button><button className="preview-tool" aria-label="Rotate image" onClick={() => setRotation((angle + 90) % 360)}><RotateCw size={16} /></button>{natural.width > 0 && <span className="small muted">{natural.width} × {natural.height}</span>}</div><div className="preview-image-canvas pro-image-canvas" ref={box} onPointerDown={start} onPointerMove={move} onPointerUp={end} onPointerCancel={end} onDoubleClick={() => setZoom(zoom === null ? 1 : null)}>{busy && <div className="preview-message" role="status"><LoaderCircle className="spin" />Loading image…</div>}{error ? <p className="preview-message" role="alert">This image could not be opened.</p> : <div className="preview-image-stage"><div style={{ position: 'relative', width: width * scale, height: height * scale }}><img src={url} alt={name} draggable={false} style={{ position: 'absolute', left: '50%', top: '50%', transform: `translate(-50%, -50%) rotate(${angle}deg)`, width: natural.width ? natural.width * scale : 'auto', height: natural.height ? natural.height * scale : 'auto', visibility: busy ? 'hidden' : 'visible' }} onLoad={event => { setNatural({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight }); setBusy(false); }} onError={() => { setBusy(false); setError(true); }} /></div></div>}</div></div>;
}
