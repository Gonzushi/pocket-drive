'use client';
import { useEffect, useState } from 'react';
export function usePreviewState<T>(id: string, key: string, initial: T) {
  const [value, setValue] = useState<T>(initial);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    try { const saved = sessionStorage.getItem(`pd-preview:${id}:${key}`); if (saved !== null) { const candidate = JSON.parse(saved); if ((initial === null && (candidate === null || typeof candidate === 'number' && Number.isFinite(candidate))) || (initial !== null && typeof candidate === typeof initial && (typeof candidate !== 'number' || Number.isFinite(candidate)))) setValue(candidate); } } catch {}
    setReady(true);
  }, [id, key]);
  useEffect(() => { if (ready) try { sessionStorage.setItem(`pd-preview:${id}:${key}`, JSON.stringify(value)); } catch {} }, [id, key, value, ready]);
  return [value, setValue] as const;
}
