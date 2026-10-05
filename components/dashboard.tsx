'use client';
import dynamic from 'next/dynamic';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowDownToLine, ArrowUpFromLine, Check, CloudUpload, File, FileText, Image as ImageIcon, LoaderCircle, LockKeyhole, Plus, RefreshCw, Search, ShieldCheck, Trash2, X, FolderClosed, FolderPlus, FolderUp, ChevronRight, Home, ArrowLeft, ArrowRight, ArrowUp, FolderTree as FolderTreeIcon, FolderInput, Pencil } from 'lucide-react';
import { api, formatBytes, formatDate } from '@/lib/client';
import type { FileItem, FolderItem, FolderDetails, StorageInfo, DriveItem } from '@/lib/types';
import { droppedFiles, type UploadSource } from '@/lib/drop';
import Modal from './modal';
import { useExplorer } from './explorer-context';
import FolderTree from './folder-tree';
import ItemMenu from './item-menu';
import MoveDialog from './move-dialog';
import { useUploads } from './uploads';
const FilePreview = dynamic(() => import('./file-preview'), { ssr: false });
type FileResponse = { files: FileItem[]; total: number; offset: number; limit: number; folders: FolderItem[]; breadcrumbs: { id: string; name: string }[] };
export default function Dashboard() {
  const [preview, setPreview] = useState<{ files: FileItem[]; id: string } | null>(null);
  const uploads = useUploads(); const uploading = uploads.busy;
  const explorer = useExplorer(); const { folderId } = explorer;
  const [treeOpen, setTreeOpen] = useState(false);
  const [selected, setSelected] = useState<DriveItem[]>([]); const [moveSelection, setMoveSelection] = useState<DriveItem[] | null>(null);
  const [renameTarget, setRenameTarget] = useState<DriveItem | null>(null); const [renameName, setRenameName] = useState(''); const [actionBusy, setActionBusy] = useState(false); const [actionError, setActionError] = useState('');
  const [bulkDelete, setBulkDelete] = useState<DriveItem[] | null>(null); const [movedTo, setMovedTo] = useState<string | null>(null);
  const loadedView = useRef('');
  const [folders, setFolders] = useState<FolderItem[]>([]); const [breadcrumbs, setBreadcrumbs] = useState<{ id: string; name: string }[]>([]);
  const [newFolder, setNewFolder] = useState(false); const [folderName, setFolderName] = useState(''); const [folderBusy, setFolderBusy] = useState(false); const [folderError, setFolderError] = useState('');
  const [folderTarget, setFolderTarget] = useState<FolderItem | null>(null); const [folderDetails, setFolderDetails] = useState<FolderDetails | null>(null); const [readingDrop, setReadingDrop] = useState(false);
  const [storage, setStorage] = useState<StorageInfo | null>(null); const [files, setFiles] = useState<FileItem[]>([]); const [total, setTotal] = useState(0);
  const query = explorer.view.get('q') || '';
  const type = ['all', 'document', 'image', 'other'].includes(explorer.view.get('type') || '') ? explorer.view.get('type')! : 'all';
  const scope = explorer.view.get('scope') === 'drive' ? 'drive' : 'folder';
  const recursive = explorer.view.get('recursive') === '1';
  const sort = ['name', 'date', 'size', 'type'].includes(explorer.view.get('sort') || '') ? explorer.view.get('sort')! : 'date';
  const order = ['asc', 'desc'].includes(explorer.view.get('order') || '') ? explorer.view.get('order')! : sort === 'date' || sort === 'size' ? 'desc' : 'asc';
  const listing = new URLSearchParams({ folder_id: folderId, q: query, type, scope, recursive: recursive ? '1' : '0', sort, order }).toString();
  const showLocations = scope === 'drive' || recursive;
  const [loading, setLoading] = useState(true); const [search, setSearch] = useState(query);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const visibleCounts = useRef(new Map<string, number>());
  useEffect(() => {
    try {
      const saved: unknown = JSON.parse(sessionStorage.getItem('pocket-drive-visible-pages') || '[]');
      if (Array.isArray(saved)) for (const entry of saved.slice(-20)) {
        if (Array.isArray(entry) && typeof entry[0] === 'string' && entry[0].length < 2000 && Number.isSafeInteger(entry[1]) && entry[1] > 0 && entry[1] <= 10000) visibleCounts.current.set(entry[0], entry[1]);
      }
    } catch {}
  }, []);
  function rememberView(key: string, result: FileResponse) {
    visibleCounts.current.set(key, result.files.length);
    if (visibleCounts.current.size > 20) visibleCounts.current.delete(visibleCounts.current.keys().next().value!);
    try { sessionStorage.setItem('pocket-drive-visible-pages', JSON.stringify([...visibleCounts.current])); } catch {}
  }
  const [error, setError] = useState(''); const [notice, setNotice] = useState(''); const [dragging, setDragging] = useState(false);
  const [target, setTarget] = useState<FileItem | null>(null); const [deleting, setDeleting] = useState(false); const [deleteError, setDeleteError] = useState('');
  const [revision, setRevision] = useState(0); const [moreBusy, setMoreBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const pageIdentity = useRef('');
  useEffect(() => { setSearch(query); if (searchTimer.current) clearTimeout(searchTimer.current); }, [query, folderId, scope, recursive]);
  useEffect(() => () => { if (searchTimer.current) clearTimeout(searchTimer.current); }, []);
  function changeSearch(value: string) {
    setSearch(value); if (searchTimer.current) clearTimeout(searchTimer.current);
    const source = window.location.href;
    searchTimer.current = setTimeout(() => { if (window.location.href === source) explorer.updateView({ q: value }); }, 250);
  }
  function changeView(changes: Record<string, string>) {
    if (searchTimer.current) clearTimeout(searchTimer.current);
    explorer.updateView({ q: search, ...changes });
  }
  const refresh = useCallback(() => { setRevision(v => v + 1); explorer.refreshTree(); }, [explorer.refreshTree]);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const uploaded = (event: Event) => {
      if ((event as CustomEvent).detail?.complete) { clearTimeout(timer); timer = undefined; refresh(); }
      else if (!timer) timer = setTimeout(() => { timer = undefined; refresh(); },500);
    };
    window.addEventListener('pocket-drive-uploaded',uploaded);
    return () => { clearTimeout(timer); window.removeEventListener('pocket-drive-uploaded',uploaded); };
  },[refresh]);
  useEffect(() => { setSelected([]); }, [listing]);
  useEffect(() => { if (!loading && (loadedView.current === listing || error)) { const frame = requestAnimationFrame(explorer.restoreScroll); return () => cancelAnimationFrame(frame); } }, [loading, listing, error, explorer.restoreScroll]);
  useEffect(() => {
    const controller = new AbortController(); const identity = `${listing}:${revision}`; pageIdentity.current = identity;
    const visibleCount = visibleCounts.current.get(listing) || 0;
    setLoading(loadedView.current !== listing); setError('');
    const fetchListing = async () => {
      const result = await api<FileResponse>(`/api/files?${listing}`, { signal: controller.signal });
      // Reload previously visible pages before restoring this view's scroll.
      while (result.files.length < Math.min(visibleCount, result.total)) {
        const page = await api<FileResponse>(`/api/files?${listing}&offset=${result.files.length}`, { signal: controller.signal });
        if (!page.files.length) break; result.files.push(...page.files);
      }
      return result;
    };
    Promise.all([api<StorageInfo>('/api/storage', { signal: controller.signal }), fetchListing()])
      .then(([usage, result]) => { if (controller.signal.aborted) return; loadedView.current = listing; rememberView(listing, result); setSelected(old => old.filter(item => [...result.files, ...result.folders].some(current => current.id === item.id))); setStorage(usage); setFiles(result.files); setTotal(result.total); setFolders(result.folders); setBreadcrumbs(result.breadcrumbs); })
      .catch(err => { if (err.name !== 'AbortError') setError(err.message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [folderId, listing, revision]);
  useEffect(() => {
    setFolderDetails(null); setFolderError('');
    if (!folderTarget) return;
    const controller = new AbortController();
    api<FolderDetails>(`/api/folders/${folderTarget.id}`, { signal: controller.signal }).then(setFolderDetails).catch(err => { if (err.name !== 'AbortError') setFolderError(err.message); });
    return () => controller.abort();
  }, [folderTarget]);
  function navigate(id = 'root') { if (searchTimer.current) clearTimeout(searchTimer.current); explorer.navigate(id); setTreeOpen(false); }
  const visibleItems: DriveItem[] = [...folders.map(folder => ({ id: folder.id, name: folder.name, type: 'folder' as const })), ...files.map(file => ({ id: file.id, name: file.name, type: 'file' as const }))];
  function toggle(item: DriveItem) { setSelected(old => old.some(current => current.id === item.id) ? old.filter(current => current.id !== item.id) : old.length >= 100 ? (setError('Select up to 100 items at a time.'), old) : [...old, item]); }
  function beginRename(item: DriveItem) { setRenameTarget(item); setRenameName(item.name); setActionError(''); }
  async function rename(event: React.FormEvent) {
    event.preventDefault(); if (!renameTarget) return; setActionBusy(true); setActionError('');
    try { await api(`/api/${renameTarget.type === 'folder' ? 'folders' : 'files'}/${renameTarget.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: renameName }) }); setNotice('Item renamed successfully.'); setMovedTo(null); setRenameTarget(null); setSelected([]); refresh(); }
    catch (err) { setActionError((err as Error).message); } finally { setActionBusy(false); }
  }
  async function deleteSelection() {
    if (!bulkDelete) return; setActionBusy(true); setActionError('');
    try { await api('/api/items/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items: bulkDelete.map(({id,type}) => ({id,type})) }) }); setNotice(`${bulkDelete.length} items deleted.`); setMovedTo(null); setBulkDelete(null); setSelected([]); refresh(); }
    catch (err) { setActionError((err as Error).message); } finally { setActionBusy(false); }
  }
  function moved(destination: string, name: string, count: number) { setMoveSelection(null); setSelected([]); setNotice(count ? `${count} ${count === 1 ? 'item moved' : 'items moved'} to ${name}.` : 'These items are already in that folder.'); setMovedTo(destination); refresh(); }
  async function createFolder(event: React.FormEvent) {
    event.preventDefault(); setFolderBusy(true); setFolderError('');
    try { await api('/api/folders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: folderName, parent_id: folderId }) }); setNewFolder(false); setFolderName(''); refresh(); }
    catch (err) { setFolderError((err as Error).message); } finally { setFolderBusy(false); }
  }
  async function removeFolder() {
    if (!folderTarget) return; setFolderBusy(true); setFolderError('');
    try { await api(`/api/folders/${folderTarget.id}`, { method: 'DELETE' }); setNotice(`“${folderTarget.name}” and its contents were deleted.`); setFolderTarget(null); refresh(); }
    catch (err) { setFolderError((err as Error).message); } finally { setFolderBusy(false); }
  }
  async function loadMore() {
    const identity = pageIdentity.current; setMoreBusy(true);
    try { const data = await api<FileResponse>(`/api/files?${listing}&offset=${files.length}`); if (pageIdentity.current === identity) { const combined = [...files, ...data.files]; setFiles(combined); setTotal(data.total); rememberView(listing, { ...data, files: combined }); } }
    catch (err) { if (pageIdentity.current === identity) setError((err as Error).message); } finally { setMoreBusy(false); }
  }
  async function uploadFiles(selected: FileList | globalThis.File[] | null, sources?: UploadSource[]) {
    if (!selected?.length || uploading || !uploads.ready || !storage) return;
    setNotice(''); setMovedTo(null); setError('');
    try { await uploads.add(sources || Array.from(selected).map(file => ({ file, relativePath: file.webkitRelativePath || '' })),folderId,storage.max_file_bytes); }
    catch (err) { setError((err as Error).message); }
    finally { if (input.current) input.current.value = ''; if (folderInput.current) folderInput.current.value = ''; }
  }
  async function drop(event: React.DragEvent) {
    event.preventDefault(); setDragging(false);
    if (uploading || !uploads.ready || readingDrop || !storage || paused) return;
    setReadingDrop(true); setError('');
    try { const sources = await droppedFiles(event.dataTransfer.items, event.dataTransfer.files); if (!sources.length) { setError('This folder has no files. Use New folder to create an empty folder.'); return; } await uploadFiles(sources.map(source => source.file), sources); }
    catch (err) { setError((err as Error).message); } finally { setReadingDrop(false); }
  }
  async function removeFile() {
    if (!target) return; setDeleting(true); setDeleteError('');
    try { await api(`/api/files/${target.id}`, { method: 'DELETE' }); setNotice(`“${target.name}” was deleted.`); setTarget(null); refresh(); }
    catch (err) { setDeleteError((err as Error).message); } finally { setDeleting(false); }
  }
  const percent = storage ? Math.min(100, storage.used_bytes / storage.quota_bytes * 100) : 0;
  const paused = !!storage && storage.available_bytes <= 0;
  return <div className="page-content compact-explorer"><div className="explorer-navigation"><div className="navigation-buttons"><button className="icon-button" aria-label="Back" title="Back" disabled={!explorer.canBack} onClick={explorer.back}><ArrowLeft size={19} /></button><button className="icon-button" aria-label="Forward" title="Forward" disabled={!explorer.canForward} onClick={explorer.forward}><ArrowRight size={19} /></button><button className="icon-button" aria-label="Up one level" title="Up one level" disabled={folderId === 'root' || loading} onClick={() => navigate(breadcrumbs.at(-2)?.id || 'root')}><ArrowUp size={19} /></button></div><nav className="breadcrumbs" aria-label="Folder path"><button onClick={() => navigate()} aria-current={folderId === 'root' ? 'page' : undefined}><Home size={15} />My files</button>{breadcrumbs.map((folder, index) => <span key={folder.id}><ChevronRight size={14} /><button onClick={() => navigate(folder.id)} title={folder.name} aria-current={index === breadcrumbs.length - 1 ? 'page' : undefined}>{folder.name}</button></span>)}</nav><button className="button secondary mobile-tree-button" onClick={() => setTreeOpen(true)}><FolderTreeIcon size={17} />Folders</button></div><div className="page-heading explorer-heading"><div><h1 className="folder-title" title={breadcrumbs.at(-1)?.name}>{folderId === 'root' ? 'My files' : breadcrumbs.at(-1)?.id === folderId ? breadcrumbs.at(-1)?.name : 'Your folder'}</h1></div><div className="explorer-actions"><button className="button secondary" onClick={() => { setFolderName(''); setFolderError(''); setNewFolder(true); }} disabled={loading}><FolderPlus size={17} />New folder</button><button className="button secondary" onClick={() => folderInput.current?.click()} disabled={uploading || !uploads.ready || readingDrop || !storage || paused}><FolderUp size={17} />Upload folder</button><button className="button primary" onClick={() => input.current?.click()} disabled={uploading || !uploads.ready || readingDrop || !storage || paused}><Plus size={18} />Upload files</button></div></div>
    <input ref={input} type="file" multiple hidden aria-label="Choose files to upload" onChange={event => uploadFiles(event.target.files)} />
    <input ref={folderInput} type="file" multiple hidden {...{ webkitdirectory: '' }} aria-label="Choose a folder to upload" onChange={event => uploadFiles(event.target.files)} />
    {error && <div className="alert error" role="alert">{error}<button className="text-button" onClick={refresh}>Try again</button></div>}
    {notice && <div className="alert success" role="status"><Check size={16} />{notice}{movedTo !== null && <button className="text-button open-destination" onClick={() => { navigate(movedTo); setMovedTo(null); }}>Open destination</button>}<button className="icon-button" aria-label="Dismiss notification" onClick={() => setNotice('')}><X size={16} /></button></div>}
    <section className="drive-status" aria-label="Storage overview"><div className="drive-usage"><span className="status-meter progress-track" role="progressbar" aria-label="Storage used" aria-valuenow={Math.round(percent)} aria-valuemin={0} aria-valuemax={100}><span style={{width:`${percent}%`}} /></span><span><strong>{storage ? formatBytes(storage.used_bytes) : '—'}</strong> / {storage ? formatBytes(storage.quota_bytes,0) : '—'}</span><span className="status-free">{storage ? `${formatBytes(storage.available_bytes)} free` : 'Checking storage…'}{storage && storage.reserved_bytes > 0 ? ' · Upload space reserved' : ''}</span></div><div className="drive-status-details"><span>{storage ? `${storage.file_count} ${storage.file_count === 1 ? 'file' : 'files'}` : '—'}</span><span title="Only you and your API keys can access this drive."><LockKeyhole size={13} />Private</span></div></section>
    <button className={`upload-zone ${dragging ? 'dragging' : ''}`} disabled={uploading || !uploads.ready || readingDrop || !storage || paused} onClick={() => input.current?.click()} onDragOver={event => { event.preventDefault(); if (!uploading && !paused) setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={drop}><span className="upload-icon"><CloudUpload size={19} strokeWidth={1.7} /></span><span><strong>{readingDrop && !uploading ? 'Reading your folder…' : uploading ? 'Uploading…' : paused ? 'Your storage is full' : dragging ? 'Drop your files or folders here' : 'Drop files or folders here'}</strong><span className="upload-hint">{paused ? 'Free up space by deleting files below.' : storage ? `Up to ${formatBytes(storage.max_file_bytes, 0)} per file` : 'Checking your storage…'}</span></span><span className="upload-zone-arrow"><ArrowUpFromLine size={20} /></span></button>
    <section className="file-section" aria-label="Your files"><div className="file-heading"><div><h2>{query || showLocations ? 'Search results' : 'Folder contents'} <span className="count-badge">{loading ? '…' : total + folders.length}</span></h2><p className="small muted">{folders.length ? `${folders.length} ${folders.length === 1 ? 'folder' : 'folders'} · ` : ''}{total} {total === 1 ? 'file' : 'files'} {scope === 'drive' ? 'across your drive' : recursive ? 'in this folder and subfolders' : 'in this location'}</p></div><div className="file-tools"><div className="search-box"><Search size={17} /><input aria-label="Search files" value={search} maxLength={200} onChange={event => changeSearch(event.target.value)} placeholder={scope === 'drive' ? 'Search your entire drive…' : recursive ? 'Search folder and subfolders…' : 'Search this folder…'} />{search && <button className="icon-button" aria-label="Clear search" onClick={() => changeSearch('')}><X size={14} /></button>}</div><button className="icon-button refresh" aria-label="Refresh files" onClick={refresh} disabled={loading}><RefreshCw size={18} className={loading ? 'spin' : ''} /></button></div></div>
      <div className="explorer-view-tools"><label className="view-control">Search in<select aria-label="Search scope" value={scope} onChange={event => changeView({ scope: event.target.value, recursive: '' })}><option value="folder">This folder</option><option value="drive">Entire drive</option></select></label>{scope === 'folder' && <label className="subfolder-control"><input type="checkbox" checked={recursive} onChange={event => changeView({ recursive: event.target.checked ? '1' : '' })} />Include subfolders</label>}<label className="view-control sort-control">Sort by<select aria-label="Sort files" value={`${sort}:${order}`} onChange={event => { const [sort, order] = event.target.value.split(':'); changeView({ sort, order }); }}><option value="date:desc">Newest first</option><option value="date:asc">Oldest first</option><option value="name:asc">Name: A–Z</option><option value="name:desc">Name: Z–A</option><option value="size:desc">Size: largest first</option><option value="size:asc">Size: smallest first</option><option value="type:asc">File type: A–Z</option><option value="type:desc">File type: Z–A</option></select></label></div>
      <div className="filter-bar" role="group" aria-label="Filter files">{[{ value: 'all', label: 'All files' }, { value: 'document', label: 'Documents' }, { value: 'image', label: 'Images' }, { value: 'other', label: 'Other' }].map(filter => <button key={filter.value} aria-pressed={type === filter.value} className={`filter ${type === filter.value ? 'selected' : ''}`} onClick={() => changeView({ type: filter.value === 'all' ? '' : filter.value })}>{filter.label}</button>)}</div>
      {selected.length > 0 && <div className="selection-bar" role="region" aria-label="Selected items"><strong>{selected.length} selected</strong><div><a className="button secondary" href={`/api/items/download?${new URLSearchParams({items:selected.map(item => `${item.type}:${item.id}`).join(',')})}`}><ArrowDownToLine size={16} />Download ZIP</a><button className="button secondary" onClick={() => setMoveSelection([...selected])}><FolderInput size={16} />Move</button><button className="button secondary danger-hover" onClick={() => { setBulkDelete([...selected]); setActionError(''); }}><Trash2 size={16} />Delete</button><button className="icon-button" aria-label="Clear selection" onClick={() => setSelected([])}><X size={17} /></button></div></div>}
      <div className="file-table explorer-table"><div className="table-head"><input type="checkbox" aria-label="Select all visible items" disabled={loading || !visibleItems.length} checked={!!visibleItems.length && visibleItems.slice(0,100).every(item => selected.some(current => current.id === item.id))} onChange={event => setSelected(event.target.checked ? visibleItems.slice(0,100) : [])} /><span>NAME</span><span>SIZE</span><span>UPLOADED</span><span className="right">ACTIONS</span></div>
        {!loading && folders.map(folder => { const item: DriveItem = {id:folder.id,name:folder.name,type:'folder'}; return <div className={`file-row folder-row ${selected.some(current => current.id === folder.id) ? 'row-selected' : ''}`} key={folder.id}><input type="checkbox" aria-label={`Select folder ${folder.name}`} checked={selected.some(current => current.id === folder.id)} onChange={() => toggle(item)} /><button className="file-name folder-open" onClick={() => navigate(folder.id)} aria-label={`Open folder ${folder.name}`}><span className="file-type-icon folder"><FolderClosed size={22} /></span><span className="file-name-text"><strong title={folder.name}>{folder.name}</strong><span className="small muted">{folder.item_count} {folder.item_count === 1 ? 'item' : 'items'}</span>{showLocations && <span className="result-location" title={folder.location}>{folder.location}</span>}</span></button><span className="file-size">Folder</span><span className="file-date">{formatDate(folder.created_at)}</span><div className="file-actions">{showLocations && <button className="icon-button" title="Open location" aria-label={`Open location of ${folder.name}`} onClick={() => navigate(folder.parent_id || 'root')}><FolderInput size={17} /></button>}<ItemMenu item={item} onRename={() => beginRename(item)} onMove={() => setMoveSelection([item])} onDelete={() => setFolderTarget(folder)} /></div></div>; })}
        {loading ? <div className="empty-state"><LoaderCircle className="spin" size={26} /><p>Loading your files…</p></div> : files.length === 0 && folders.length === 0 ? <div className="empty-state"><span className="empty-icon">{query || type !== 'all' ? <Search size={26} /> : <FolderIllustration />}</span><h3>{query || type !== 'all' ? 'No matching files' : folderId === 'root' ? 'Make yourself at home.' : 'This folder is ready for you.'}</h3><p>{query || type !== 'all' ? 'Try another search or choose All files.' : 'Upload files or a folder to get started.'}</p>{!query && type === 'all' && <button className="button secondary" onClick={() => input.current?.click()} disabled={!uploads.ready || !storage || paused || uploading}><Plus size={17} />Upload your first file</button>}</div> : files.map(file => { const item: DriveItem = {id:file.id,name:file.name,type:'file'}; return <div className={`file-row ${selected.some(current => current.id === file.id) ? 'row-selected' : ''}`} key={file.id}><input type="checkbox" aria-label={`Select file ${file.name}`} checked={selected.some(current => current.id === file.id)} onChange={() => toggle(item)} /><div className="file-name"><span className={`file-type-icon ${file.kind}`}>{file.kind === 'image' ? <ImageIcon size={21} /> : file.kind === 'document' ? <FileText size={21} /> : <File size={21} />}</span><span className="file-name-text"><button className="file-preview-trigger" title={`Preview ${file.name}`} aria-label={`Preview ${file.name}`} onClick={() => setPreview({files:[...files],id:file.id})}>{file.name}</button><span className="small muted">{file.name.split('.').length > 1 ? file.name.split('.').pop()?.toUpperCase().slice(0, 12) : 'FILE'}<span className="mobile-size"> · {formatBytes(file.size)}</span></span>{showLocations && <button className="result-location" title={`${file.location} · Open location`} aria-label={`Open location of ${file.name}`} onClick={() => navigate(file.folder_id || 'root')}><FolderInput size={12} /><span>{file.location}</span></button>}</span></div><span className="file-size">{formatBytes(file.size)}</span><span className="file-date">{formatDate(file.created_at)}</span><div className="file-actions"><a className="icon-button" href={`/api/files/${file.id}/download`} aria-label={`Download ${file.name}`} title="Download"><ArrowDownToLine size={18} /></a><ItemMenu item={item} onPreview={() => setPreview({files:[...files],id:file.id})} onRename={() => beginRename(item)} onMove={() => setMoveSelection([item])} onDelete={() => { setDeleteError(''); setTarget(file); }} /></div></div>; })}
      </div>{files.length < total && !loading && <div className="load-more"><span className="small muted">Showing {files.length} of {total} files</span><button className="button secondary" onClick={loadMore} disabled={moreBusy}>{moreBusy ? 'Loading…' : 'Load more files'}</button></div>}
    </section><footer className="page-footer"><LockKeyhole size={13} /> Your drive is private. Downloads require a login or an API key.</footer>
    {treeOpen && <Modal title="Browse folders" drawer onClose={() => setTreeOpen(false)}><div className="mobile-tree-panel"><FolderTree onNavigate={() => setTreeOpen(false)} /></div></Modal>}
    {moveSelection && <MoveDialog items={moveSelection} currentFolder={folderId} onClose={() => setMoveSelection(null)} onMoved={moved} />}
    {preview && <FilePreview files={preview.files} initialId={preview.id} onClose={() => setPreview(null)} />}
    {renameTarget && <Modal title={`Rename ${renameTarget.type}`} onClose={() => { if (!actionBusy) setRenameTarget(null); }}><form onSubmit={rename}><label htmlFor="rename-name">New name</label><input id="rename-name" value={renameName} onChange={event => setRenameName(event.target.value)} required maxLength={255} autoFocus />{renameTarget.type === 'file' && <p className="small muted rename-hint">Keep the file extension unless you want to change it.</p>}{actionError && <p className="alert error" role="alert">{actionError}</p>}<div className="modal-actions"><button type="button" className="button secondary" disabled={actionBusy} onClick={() => setRenameTarget(null)}>Cancel</button><button className="button primary" disabled={actionBusy}>{actionBusy ? 'Saving…' : 'Save name'}</button></div></form></Modal>}
    {bulkDelete && <Modal title={`Delete ${bulkDelete.length} selected items?`} onClose={() => { if (!actionBusy) setBulkDelete(null); }}><p className="muted">Selected folders and everything inside them will also be deleted.</p><ul className="selected-delete-list">{bulkDelete.slice(0,5).map(item => <li key={item.id}>{item.name}</li>)}{bulkDelete.length > 5 && <li>And {bulkDelete.length - 5} more…</li>}</ul><p className="small muted">This is permanent and cannot be undone.</p>{actionError && <p className="alert error" role="alert">{actionError}</p>}<div className="modal-actions"><button className="button secondary" disabled={actionBusy} onClick={() => setBulkDelete(null)}>Keep items</button><button className="button danger" disabled={actionBusy} onClick={deleteSelection}>{actionBusy ? 'Deleting…' : 'Delete selected items'}</button></div></Modal>}
    {newFolder && <Modal title="New folder" onClose={() => { if (!folderBusy) setNewFolder(false); }}><p className="muted">Create a folder in {folderId === 'root' ? 'My files' : breadcrumbs.at(-1)?.name}.</p><form onSubmit={createFolder}><label htmlFor="folder-name">Folder name</label><input id="folder-name" value={folderName} onChange={event => setFolderName(event.target.value)} placeholder="e.g. Work or Photos" maxLength={255} required autoFocus />{folderError && <p className="alert error" role="alert">{folderError}</p>}<div className="modal-actions"><button type="button" className="button secondary" disabled={folderBusy} onClick={() => setNewFolder(false)}>Cancel</button><button className="button primary" disabled={folderBusy}>{folderBusy ? 'Creating…' : 'Create folder'}</button></div></form></Modal>}
    {folderTarget && <Modal title="Delete this folder?" onClose={() => { if (!folderBusy) setFolderTarget(null); }}><p className="muted">Permanently delete <strong className="break-word">{folderTarget.name}</strong> and everything inside it?</p>{folderDetails && <p className="small muted">This includes {folderDetails.file_count} files and {folderDetails.folder_count} subfolders, using {formatBytes(folderDetails.size)}.</p>}<p className="small muted">This action cannot be undone.</p>{folderError && <p className="alert error" role="alert">{folderError}</p>}<div className="modal-actions"><button className="button secondary" disabled={folderBusy} onClick={() => setFolderTarget(null)}>Keep folder</button><button className="button danger" disabled={folderBusy || !folderDetails} onClick={removeFolder}>{folderBusy ? 'Deleting…' : 'Delete folder'}</button></div></Modal>}
    {target && <Modal title="Delete this file?" onClose={() => { if (!deleting) setTarget(null); }}><p className="muted">You are about to permanently delete <strong className="break-word">{target.name}</strong>. This will free up {formatBytes(target.size)} of space.</p><p className="small muted">This action cannot be undone.</p>{deleteError && <p className="alert error" role="alert">{deleteError}</p>}<div className="modal-actions"><button className="button secondary" disabled={deleting} onClick={() => setTarget(null)}>Keep file</button><button className="button danger" onClick={removeFile} disabled={deleting}>{deleting ? 'Deleting…' : 'Delete file'}</button></div></Modal>}
  </div>;
}
function FolderIllustration() { return <svg width="48" height="42" viewBox="0 0 48 42" fill="none" aria-hidden="true"><path d="M4 10a4 4 0 0 1 4-4h10l5 6h17a4 4 0 0 1 4 4v20H4V10Z" fill="#DBE8DF" stroke="#537F64" strokeWidth="1.5"/><path d="M4 18h40l-4 18H8L4 18Z" fill="#F0F6F2" stroke="#537F64" strokeWidth="1.5"/></svg>; }
