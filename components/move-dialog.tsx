'use client';
import { useEffect, useMemo, useState } from 'react';
import { ArrowUp, ChevronRight, FolderClosed, FolderPlus, Home } from 'lucide-react';
import { api } from '@/lib/client';
import type { DriveItem } from '@/lib/types';
import Modal from './modal';
import { useExplorer } from './explorer-context';

export default function MoveDialog({ items, currentFolder, onClose, onMoved }: { items: DriveItem[]; currentFolder: string; onClose: () => void; onMoved: (destination: string, name: string, moved: number) => void }) {
  const { folders, refreshTree, treeLoading, treeError } = useExplorer();
  const [destination, setDestination] = useState(currentFolder); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const [creating, setCreating] = useState(false); const [name, setName] = useState('');
  const map = useMemo(() => new Map(folders.map(folder => [folder.id, folder])), [folders]);
  const selectedFolders = new Set(items.filter(item => item.type === 'folder').map(item => item.id));
  function blocked(id: string) { let current: string | null = id; let depth = 0; while (current && depth++ < 33) { if (selectedFolders.has(current)) return true; current = map.get(current)?.parent_id || null; } return false; }
  const crumbs = []; let current = map.get(destination);
  while (current && crumbs.length < 32) { crumbs.unshift(current); current = current.parent_id ? map.get(current.parent_id) : undefined; }
  const children = folders.filter(folder => (folder.parent_id || 'root') === destination);
  const valid = destination === 'root' || map.has(destination);
  useEffect(() => { refreshTree(); }, [refreshTree]);
  function go(id: string) { setDestination(id); setCreating(false); setError(''); }
  async function move() {
    setBusy(true); setError('');
    try { const result = await api<{ moved: number }>('/api/items/move', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items: items.map(({ id, type }) => ({ id, type })), destination_id: destination }) }); onMoved(destination, map.get(destination)?.name || 'My files', result.moved); }
    catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }
  async function create(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    try { await api('/api/folders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, parent_id: destination }) }); refreshTree(); setCreating(false); setName(''); }
    catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }
  return <Modal title={items.length === 1 ? 'Move this item' : `Move ${items.length} items`} onClose={() => { if (!busy) onClose(); }}><p className="muted move-summary">Choose a destination for {items.length === 1 ? <strong className="break-word">{items[0].name}</strong> : 'your selected files and folders'}.</p>
    <nav className="breadcrumbs move-path" aria-label="Destination path"><button onClick={() => go('root')} disabled={busy}><Home size={14} />My files</button>{crumbs.map(folder => <span key={folder.id}><ChevronRight size={13} /><button onClick={() => go(folder.id)} disabled={busy}>{folder.name}</button></span>)}</nav>
    <div className="destination-tools"><button className="button secondary" onClick={() => go(map.get(destination)?.parent_id || 'root')} disabled={busy || destination === 'root'}><ArrowUp size={15} />Up one level</button><button className="text-button" disabled={busy || !valid} onClick={() => { setCreating(v => !v); setName(''); setError(''); }}><FolderPlus size={15} />New folder</button></div>
    {creating && <form className="destination-create" onSubmit={create}><label htmlFor="destination-folder-name">Folder name</label><div><input id="destination-folder-name" value={name} onChange={event => setName(event.target.value)} autoFocus maxLength={255} required /><button className="button secondary" disabled={busy}>Create</button></div></form>}
    <div className="destination-list" aria-label="Destination folders">{!valid ? <p className="muted">This destination was deleted. Choose My files above.</p> : treeLoading && !folders.length ? <p className="muted">Loading folders…</p> : children.length ? children.map(folder => <button key={folder.id} className="destination-folder" disabled={busy || blocked(folder.id)} title={blocked(folder.id) ? 'A selected folder and its subfolders cannot be the destination.' : folder.name} onClick={() => go(folder.id)}><FolderClosed size={21} /><span>{folder.name}</span><ChevronRight size={17} /></button>) : <p className="muted">No subfolders here. You can move your items into this folder.</p>}</div>
    {(error || treeError) && <p className="alert error" role="alert">{error || treeError}</p>}
    <p className="destination-caption">Destination: <strong>{['My files', ...crumbs.map(folder => folder.name)].join(' / ')}</strong></p>
    <div className="modal-actions"><button className="button secondary" onClick={onClose} disabled={busy}>Cancel</button><button className="button primary" onClick={move} disabled={busy || creating || !valid || !!treeError || blocked(destination) || destination === currentFolder}>{busy ? 'Working…' : 'Move here'}</button></div>
  </Modal>;
}
