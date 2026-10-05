'use client';
import { useEffect, useRef, useState } from 'react';
import { LoaderCircle, Maximize, RotateCcw, RotateCw } from 'lucide-react';
import { usePreviewState } from './preview-state';
type Preparation = { status: string; url: string | null; error: string | null; variant?: string | null };
export function usePrepared(id: string, variant: string | null) {
  const [value, setValue] = useState<Preparation>({ status: 'idle', url: null, error: null });
  useEffect(() => {
    if (!variant) { setValue({ status: 'idle', url: null, error: null }); return; }
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    setValue({ status: 'running', url: null, error: null, variant });
    async function poll(start: boolean) {
      try {
        const response = await fetch(`/api/files/${id}/preview/prepare?variant=${variant}`, { method: start ? 'POST' : 'GET', signal: controller.signal });
        const data = await response.json(); if (!response.ok) throw new Error(data.error || 'Preparation is unavailable.');
        if (controller.signal.aborted) return;
        setValue({ ...data, variant });
        if (['running', 'idle'].includes(data.status)) timer = setTimeout(() => void poll(data.status === 'idle'), 1500);
      } catch (error) { if (!controller.signal.aborted) setValue({ status: 'failed', url: null, error: (error as Error).message, variant }); }
    }
    void poll(true); return () => { controller.abort(); clearTimeout(timer); };
  }, [id, variant]);
  return value.variant === variant ? value : { status: 'running', url: null, error: null, variant };
}
export default function PreviewMedia({ id, name, video }: { id: string; name: string; video: boolean }) {
  const original = `/api/files/${id}/preview/content`;
  const [quality, setQuality] = useState('auto'); const [url, setUrl] = useState(original);
  const [rate, setRate] = usePreviewState('preferences', 'playback-rate', 1);
  const [error, setError] = useState(false); const [buffering, setBuffering] = useState(false);
  const media = useRef<HTMLMediaElement | null>(null); const resume = useRef<{ time: number; playing: boolean } | null>(null); const saved = useRef(0);
  const variant = video && quality !== 'original' ? quality === 'mobile' ? 'mobile' : 'stream' : null;
  const prepared = usePrepared(id, variant);
  useEffect(() => {
    if (prepared.status !== 'ready' || !prepared.url || prepared.url === url) return;
    const node = media.current;
    if (quality === 'auto' && node && !node.paused && !error) return;
    resume.current = { time: node?.currentTime || resume.current?.time || 0, playing: !!node && !node.paused };
    setUrl(prepared.url); setError(false);
  }, [prepared.status, prepared.url, quality, error, url]);
  useEffect(() => { if (media.current) media.current.playbackRate = Number.isFinite(rate) && rate >= .25 && rate <= 3 ? rate : 1; }, [rate]);
  useEffect(() => { const node = media.current; return () => { if (node) { try { sessionStorage.setItem(`pd-preview:${id}:media-time`, String(node.currentTime)); } catch {} node.pause(); node.removeAttribute('src'); node.load(); } }; }, [id]);
  function loaded() {
    const node = media.current!; node.playbackRate = Number.isFinite(rate) && rate >= .25 && rate <= 3 ? rate : 1;
    let time = resume.current?.time || 0; if (!resume.current) try { time = Number(sessionStorage.getItem(`pd-preview:${id}:media-time`)) || 0; } catch {}
    if (Number.isFinite(node.duration) && Number.isFinite(time) && time > 0 && time < node.duration - 2) node.currentTime = time;
    if (resume.current?.playing) void node.play().catch(() => {}); resume.current = null; setBuffering(false);
  }
  function choose(value: string) { const node = media.current; resume.current = { time: node?.currentTime || 0, playing: !!node && !node.paused }; setQuality(value); setError(false); if (value === 'original') setUrl(original); }
  function seek(seconds: number) { const node = media.current; if (node && Number.isFinite(node.duration)) node.currentTime = Math.max(0, Math.min(node.duration, node.currentTime + seconds)); }
  const events = { onLoadedMetadata: loaded, onWaiting: () => setBuffering(true), onPlaying: () => setBuffering(false), onCanPlay: () => setBuffering(false), onError: () => { setError(true); setBuffering(false); }, onTimeUpdate: () => { const node = media.current; if (node && Date.now() - saved.current > 2000) { saved.current = Date.now(); try { sessionStorage.setItem(`pd-preview:${id}:media-time`, String(node.currentTime)); } catch {} } } };
  return <div className="pro-media-view"><div className="preview-view-tools"><button className="preview-tool" aria-label="Back ten seconds" onClick={() => seek(-10)}><RotateCcw size={16} />10s</button><button className="preview-tool" aria-label="Forward ten seconds" onClick={() => seek(10)}><RotateCw size={16} />10s</button><label>Speed <select aria-label="Playback speed" value={rate} onChange={e => setRate(Number(e.target.value))}>{[.5,.75,1,1.25,1.5,1.75,2].map(value => <option key={value} value={value}>{value}×</option>)}</select></label>{video && <><select aria-label="Video quality" value={quality} onChange={e => choose(e.target.value)}><option value="auto">Auto · fast start</option><option value="original">Original</option><option value="mobile">720p · less data</option></select><button className="preview-tool" aria-label="Fullscreen video" onClick={() => { const node = media.current as HTMLVideoElement & { webkitEnterFullscreen?: () => void }; if (node?.requestFullscreen) void node.requestFullscreen().catch(() => {}); else node?.webkitEnterFullscreen?.(); }}><Maximize size={16} /></button></>}</div><div className="pro-media-stage">{video ? <video ref={node => { media.current = node; }} controls playsInline preload="metadata" src={url} aria-label={`Play ${name}`} {...events} /> : <><h3>{name}</h3><audio ref={node => { media.current = node; }} controls preload="metadata" src={url} aria-label={`Play ${name}`} {...events} /></>}{buffering && <span className="media-buffer" role="status"><LoaderCircle size={18} className="spin" />Buffering…</span>}{error && <p className="preview-notice" role="alert">Your browser cannot play this version. Try 720p or download the original.</p>}</div><div className="code-status" role="status">{video ? prepared.status === 'running' ? 'Preparing a faster streaming version. The original is available now.' : prepared.status === 'failed' ? `Original available · ${prepared.error}` : url === original ? 'Original · byte-range streaming' : quality === 'mobile' ? '720p · optimized streaming' : 'Optimized · fast-start streaming' : 'Resume position is saved on this device.'}</div></div>;
}
