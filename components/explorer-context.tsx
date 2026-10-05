'use client';
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { api } from '@/lib/client';
import type { TreeFolder } from '@/lib/types';

type Visit = { id: string; url: string; scroll: number };
type Explorer = { folders: TreeFolder[]; treeLoading: boolean; treeError: string; refreshTree: () => void; navigate: (id?: string) => void; back: () => void; forward: () => void; canBack: boolean; canForward: boolean; restoreScroll: () => void; folderId: string; view: URLSearchParams; updateView: (changes: Record<string, string>) => void };
const Context = createContext<Explorer | null>(null);
export function useExplorer() { const value = useContext(Context); if (!value) throw new Error('Explorer provider is missing.'); return value; }
export default function ExplorerProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter(); const pathname = usePathname(); const params = useSearchParams();
  const folderId = params.get('folder') || 'root'; const url = pathname + (params.toString() ? '?' + params.toString() : '');
  const [folders, setFolders] = useState<TreeFolder[]>([]); const [treeLoading, setTreeLoading] = useState(true); const [treeError, setTreeError] = useState(''); const [revision, setRevision] = useState(0);
  const visits = useRef<Visit[]>([]); const cursor = useRef(-1); const restored = useRef(false); const [history, setHistory] = useState({ back: false, forward: false });
  const pendingScroll = useRef<number | null>(null);
  const scrollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refreshTree = useCallback(() => setRevision(v => v + 1), []);
  useEffect(() => {
    // Restore only after all previously visible pages have loaded. Native
    // restoration can otherwise clamp the saved position to the loading shell.
    const previous = window.history.scrollRestoration;
    window.history.scrollRestoration = 'manual';
    return () => { window.history.scrollRestoration = previous; };
  }, []);
  useEffect(() => {
    const controller = new AbortController(); setTreeLoading(true); setTreeError('');
    api<{ folders: TreeFolder[] }>('/api/folders/tree', { signal: controller.signal }).then(data => { if (!controller.signal.aborted) setFolders(data.folders); }).catch(err => { if (err.name !== 'AbortError') setTreeError(err.message); }).finally(() => { if (!controller.signal.aborted) setTreeLoading(false); });
    return () => controller.abort();
  }, [revision]);
  const persist = useCallback(() => { try { sessionStorage.setItem('pocket-drive-visits', JSON.stringify({ visits: visits.current, cursor: cursor.current })); } catch {} }, []);
  const savePosition = useCallback(() => { const visit = visits.current[cursor.current]; if (visit && pendingScroll.current === null) visit.scroll = window.scrollY; persist(); }, [persist]);
  const freezeScroll = useCallback(() => { if (scrollTimer.current) clearTimeout(scrollTimer.current); pendingScroll.current = 0; }, []);
  const beginNavigation = useCallback(() => { savePosition(); freezeScroll(); }, [savePosition, freezeScroll]);
  useEffect(() => {
    if (!restored.current) {
      restored.current = true;
      try { const saved = JSON.parse(sessionStorage.getItem('pocket-drive-visits') || 'null'); if (saved && Array.isArray(saved.visits) && Number.isInteger(saved.cursor)) { visits.current = saved.visits; cursor.current = saved.cursor; } } catch {}
    }
    const marker = window.history.state?.pocketDriveVisit;
    const existing = marker?.url === url ? visits.current.findIndex(v => v.id === marker.id && v.url === url) : -1;
    if (existing >= 0) cursor.current = existing;
    else {
      const visit = { id: crypto.randomUUID(), url, scroll: 0 };
      visits.current = [...visits.current.slice(0, cursor.current + 1), visit].slice(-100); cursor.current = visits.current.length - 1;
      window.history.replaceState({ ...window.history.state, pocketDriveVisit: { id: visit.id, url } }, '', window.location.href);
    }
    if (scrollTimer.current) clearTimeout(scrollTimer.current);
    pendingScroll.current = pathname === '/files' ? visits.current[cursor.current].scroll : null;
    setHistory({ back: cursor.current > 0, forward: cursor.current < visits.current.length - 1 }); persist();
  }, [url, persist]);
  useEffect(() => {
    const save = () => { const visit = visits.current[cursor.current]; if (visit && pendingScroll.current === null) visit.scroll = window.scrollY; };
    const hide = () => { save(); persist(); };
    window.addEventListener('scroll', save, { passive: true }); window.addEventListener('pagehide', hide);
    return () => { window.removeEventListener('scroll', save); window.removeEventListener('pagehide', hide); };
  }, [persist]);
  useEffect(() => { window.addEventListener('popstate', freezeScroll); return () => window.removeEventListener('popstate', freezeScroll); }, [freezeScroll]);
  const updateView = useCallback((changes: Record<string, string>) => {
    savePosition();
    const next = new URLSearchParams(window.location.search);
    for (const [key, value] of Object.entries(changes)) { if (value) next.set(key, value); else next.delete(key); }
    const target = '/files' + (next.size ? '?' + next.toString() : '');
    const visit = visits.current[cursor.current];
    if (visit) visit.url = target;
    // Next integrates native history updates with useSearchParams. Replacing the
    // current view keeps typing/filter changes out of the folder history stack.
    window.history.replaceState(visit ? { pocketDriveVisit: { id: visit.id, url: target } } : null, '', target);
    persist();
  }, [savePosition, persist]);
  const navigate = useCallback((id = 'root') => {
    const next = new URLSearchParams(window.location.search);
    if (id === 'root') next.delete('folder'); else next.set('folder', id);
    next.delete('q'); next.delete('scope'); next.delete('recursive');
    const target = '/files' + (next.size ? '?' + next.toString() : '');
    if (target === url) return;
    beginNavigation(); router.push(target, { scroll: false });
  }, [router, beginNavigation, url]);
  const restoreScroll = useCallback(() => {
    if (pendingScroll.current === null) return;
    if (scrollTimer.current) clearTimeout(scrollTimer.current);
    // Let Next's focus/scroll effect finish after the folder contents render.
    // Ignore temporary scroll clamping while the loading state is shorter.
    scrollTimer.current = setTimeout(() => { if (pendingScroll.current !== null) window.scrollTo(0, pendingScroll.current); pendingScroll.current = null; }, 100);
  }, []);
  useEffect(() => () => { if (scrollTimer.current) clearTimeout(scrollTimer.current); }, []);
  return <Context.Provider value={{ folders, treeLoading, treeError, refreshTree, navigate, back: () => { beginNavigation(); router.back(); }, forward: () => { beginNavigation(); router.forward(); }, canBack: history.back, canForward: history.forward, restoreScroll, folderId, view: new URLSearchParams(params.toString()), updateView }}>{children}</Context.Provider>;
}
