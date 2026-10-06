'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import dynamic from 'next/dynamic';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Bot, Plus, Send, Square, FileText, FolderClosed, LoaderCircle, LogOut, ShieldCheck, Trash2 } from 'lucide-react';
import { api as clientApi } from '@/lib/client';
import type { FileItem } from '@/lib/types';
const FilePreview = dynamic(() => import('./file-preview'), { ssr: false });
function api<T>(url: string, init?: RequestInit) { return clientApi<T>(url, init?.body ? { ...init, headers: { 'Content-Type': 'application/json', ...init.headers } } : init); }
interface Chat { id: string; title: string }
interface Message { id: string; role: string; text: string }
interface Run { id: string; status: string; message_id: string; error: string | null }
interface Source extends FileItem { folder_url: string }
interface Snapshot { chat: Chat; messages: Message[]; runs: Run[]; hasOlder: boolean; before: number; events: { id: number; run_id: string; kind: string; data: { tool?: string; sources?: Source[]; mutation?: boolean } }[] }
interface Login { verificationUrl: string; userCode: string }
interface Status { enabled: boolean; connected: boolean; offline?: boolean; error?: string; login?: Login; account?: { email: string; plan: string }; index?: { total: number; indexed: number; pending: number; unreadable: number; limited: number; indexing: boolean } }
const activity: Record<string, string> = { search_files: 'Searching your drive', list_folders: 'Finding folders', get_file_details: 'Checking file location', read_document: 'Reading a document', create_folder: 'Creating a folder', rename_item: 'Renaming an item', move_items: 'Moving items' };
export default function Assistant() {
  const params = useSearchParams(); const contextId = params.get('file');
  const [status, setStatus] = useState<Status | null>(null); const [chats, setChats] = useState<Chat[]>([]); const [selected, setSelected] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null); const [text, setText] = useState(''); const [organize, setOrganize] = useState(false);
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false); const [login, setLogin] = useState<Login | null>(null); const [context, setContext] = useState<FileItem | null>(null); const [preview, setPreview] = useState<Source | null>(null);
  const [older, setOlder] = useState<Snapshot | null>(null); const [loadingOlder, setLoadingOlder] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false); const running = useRef(false); running.current = Boolean(snapshot?.runs.some(run => run.status === 'running'));
  const end = useRef<HTMLDivElement>(null); const current = useRef(selected); current.current = selected;
  const refreshChats = useCallback(async () => { const result = await api<{ chats: Chat[] }>('/api/assistant/chats'); setChats(result.chats); }, []);
  const refreshStatus = useCallback(async () => { const value = await api<Status>('/api/assistant/status'); setStatus(value); if (value.connected) setLogin(null); else if (value.login) setLogin(value.login); }, []);
  useEffect(() => { let live = true; Promise.all([refreshChats(), refreshStatus()]).catch(err => { if (live) setError(err.message); }); const timer = setInterval(() => { void refreshStatus().catch(() => {}); }, 7000); return () => { live = false; clearInterval(timer); }; }, [refreshChats, refreshStatus]);
  useEffect(() => { const controller = new AbortController(); setContext(null); if (contextId) api<FileItem>('/api/files/' + encodeURIComponent(contextId), { signal: controller.signal }).then(setContext).catch(err => { if (!controller.signal.aborted) setError(err.message); }); return () => controller.abort(); }, [contextId]);
  useEffect(() => {
    setSnapshot(null); setOlder(null); if (!selected) return;
    const controller = new AbortController();
    let fetching = false; let checked = 0;
    async function update() { if (fetching) return; fetching = true; try { const value = await api<Snapshot>('/api/assistant/chats/' + selected, { signal: controller.signal }); if (current.current === selected) setSnapshot(value); } catch (err) { if (!controller.signal.aborted) setError((err as Error).message); } finally { fetching = false; checked = Date.now(); } }
    void update(); const timer = setInterval(() => { if (running.current || Date.now() - checked >= 7000) void update(); }, 1000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [selected]);
  const active = snapshot?.runs.find(run => run.status === 'running');
  const lastMessage = snapshot?.messages.at(-1);
  useEffect(() => { end.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }, [lastMessage?.id, lastMessage?.text]);
  async function newChat() { setError(''); setBusy(true); try { const chat = await api<Chat>('/api/assistant/chats', { method: 'POST' }); setSelected(chat.id); await refreshChats(); } catch (err) { setError((err as Error).message); } finally { setBusy(false); } }
  async function deleteConversation(chat: Chat) {
    if (busy || (active && selected === chat.id)) return;
    if (!window.confirm(`Delete "${chat.title}"? This conversation cannot be recovered.`)) return;
    setError(''); setBusy(true);
    try {
      await api('/api/assistant/chats/' + chat.id, { method: 'DELETE' });
      if (selected === chat.id) { setSelected(null); setSnapshot(null); setOlder(null); }
      await refreshChats();
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }
  async function submit(event: React.FormEvent) {
    event.preventDefault(); if (!text.trim() || active || busy) return; setError(''); setBusy(true);
    try {
      let id = selected; if (!id) { const chat = await api<Chat>('/api/assistant/chats', { method: 'POST' }); id = chat.id; setSelected(id); }
      await api('/api/assistant/chats/' + id + '/messages', { method: 'POST', body: JSON.stringify({ text, organize, ...(context ? { file_id: context.id } : {}) }) });
      setText(''); setOrganize(false); setSnapshot(await api<Snapshot>('/api/assistant/chats/' + id)); await refreshChats();
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }
  async function connect() { setBusy(true); setError(''); try { setLogin(await api<Login>('/api/assistant/login', { method: 'POST' })); } catch (err) { setError((err as Error).message); } finally { setBusy(false); } }
  async function disconnect() { setBusy(true); setError(''); try { await api('/api/assistant/logout', { method: 'POST' }); setLogin(null); await refreshStatus(); } catch (err) { setError((err as Error).message); } finally { setBusy(false); } }
  async function stop() { if (!active) return; try { await api('/api/assistant/runs/' + active.id + '/cancel', { method: 'POST' }); } catch (err) { setError((err as Error).message); } }
  async function loadOlder() {
    if (!snapshot || loadingOlder) return; setLoadingOlder(true);
    try {
      const value = await api<Snapshot>('/api/assistant/chats/' + snapshot.chat.id + '?before=' + (older?.before || snapshot.before));
      if (current.current === snapshot.chat.id) setOlder(previous => ({ ...value, messages: [...value.messages, ...(previous?.messages || [])], runs: [...value.runs, ...(previous?.runs || [])], events: [...value.events, ...(previous?.events || [])] }));
    } catch (err) { setError((err as Error).message); } finally { setLoadingOlder(false); }
  }
  const visible = snapshot ? { ...snapshot, messages: [...(older?.messages || []), ...snapshot.messages].filter((message, index, array) => array.findIndex(item => item.id === message.id) === index), runs: [...snapshot.runs, ...(older?.runs || [])], events: [...(older?.events || []), ...snapshot.events] } : null;
  const lastActivity = snapshot?.events.filter(event => event.run_id === active?.id && event.kind === 'activity').at(-1)?.data.tool;
  return <section className="assistant-page">
    <div className="assistant-heading"><div><h1><Bot size={28} />Drive assistant</h1><p>Find answers in your files, with sources you can open.</p></div><span className="assistant-model">GPT-6.1 Sol · Medium</span></div>
    {error && <p className="error-text assistant-alert" role="alert">{error}</p>}
    <div className="assistant-layout"><aside className="assistant-history" aria-label="Conversations"><button className="btn primary" onClick={newChat} disabled={busy}><Plus size={16} />New conversation</button><div className="assistant-chat-list">{chats.map(chat => <div className="assistant-chat-row" key={chat.id}><button className={'assistant-chat-select' + (selected === chat.id ? ' selected' : '')} onClick={() => setSelected(chat.id)} title={chat.title}>{chat.title}</button><button className="assistant-chat-delete" type="button" onClick={() => void deleteConversation(chat)} disabled={busy || Boolean(active && selected === chat.id)} aria-label={'Delete conversation ' + chat.title} title="Delete conversation"><Trash2 size={14} /></button></div>)}</div>
      {status?.connected && <button className="assistant-settings-toggle btn" aria-expanded={settingsOpen} onClick={() => setSettingsOpen(!settingsOpen)}><ShieldCheck size={15} />{settingsOpen ? 'Hide account details' : 'Codex connected · Account details'}</button>}
      <div className={'assistant-account' + (status?.connected && !settingsOpen ? ' mobile-collapsed' : '')}>{status?.connected ? <><ShieldCheck size={18} /><strong>Personal Codex connected</strong><span>{status.account?.email}</span><span>{status.account?.plan} subscription · Usage limits apply</span><button className="btn" onClick={disconnect} disabled={busy || Boolean(active)}><LogOut size={14} />Disconnect</button></> : <><strong>{status?.offline ? 'Worker unavailable' : 'Connect personal Codex'}</strong><p>{status?.enabled ? status.error || 'Sign in with the ChatGPT account you use for Codex.' : 'Deploy the Codex worker using the repository’s assistant setup guide.'}</p><button className="btn" onClick={connect} disabled={busy || !status?.enabled || status.offline}>Connect Codex</button></>}
      {login && !status?.connected && <div className="assistant-device"><p>Open the sign-in page and enter this code:</p><code>{login.userCode}</code><a className="btn primary" href={login.verificationUrl} target="_blank" rel="noopener noreferrer">Open Codex sign-in</a><span>This page updates when sign-in finishes.</span></div>}
      {status?.index && <span className="assistant-coverage">{status.index.indexed} / {status.index.total} files readable{status.index.indexing ? ' · Indexing…' : ''}{status.index.unreadable ? ' · ' + status.index.unreadable + ' unsupported or unreadable' : ''}{status.index.limited ? ' · ' + status.index.limited + ' limited' : ''}</span>}</div>
    </aside><div className="assistant-conversation">
      {context && <div className="assistant-context"><FileText size={17} /><span>Asking about <strong>{context.name}</strong></span><Link href="/assistant" className="btn">Clear</Link></div>}
      <div className="assistant-messages" aria-label="Messages" aria-busy={Boolean(active)}>
        {(older ? older.hasOlder : snapshot?.hasOlder) && <button className="btn" onClick={loadOlder} disabled={loadingOlder}>{loadingOlder ? 'Loading…' : 'Load earlier messages'}</button>}
        {!snapshot?.messages.length && <div className="assistant-empty"><Bot size={42} /><h2>Your files, easier to understand</h2><p>Ask a question. The assistant will find and read relevant documents on its own.</p><div className="assistant-suggestions">{(context ? ['Summarize this file and cite the important sections.', 'Explain this code and point out potential issues.', 'What are the key facts in this document?'] : ['Find my invoices and tell me where they are.', 'Summarize the main points across my project documents.', 'Find the spreadsheet about expenses and explain it.']).map(prompt => <button key={prompt} onClick={() => setText(prompt)}>{prompt}</button>)}</div></div>}
        {visible?.messages.map(message => {
          const run = visible.runs.find(run => run.message_id === message.id);
          const sources = [...new Map(visible.events.filter(event => event.run_id === run?.id).flatMap(event => event.data.sources || []).map(source => [source.id, source])).values()];
          return <article key={message.id} className={'assistant-message ' + message.role}><div className="assistant-message-label">{message.role === 'user' ? 'You' : 'Drive assistant'}</div><div className="assistant-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} components={{ img: ({ alt }) => <span>{alt || 'Image reference'}</span>, a: ({ href, children }) => <a href={href} target="_blank" rel="noopener noreferrer">{children}</a> }}>{message.text || (run?.status === 'running' ? 'Working on your request…' : '')}</ReactMarkdown></div>{run?.error && <p className="error-text" role="alert">{run.error}</p>}{sources.length > 0 && <div className="assistant-sources"><span>Sources</span>{sources.map(source => <div key={source.id} className="assistant-source"><button onClick={async () => { try { const current = await api<Source>('/api/files/' + source.id); setPreview({ ...current, location: source.location, folder_url: source.folder_url }); } catch (err) { setError((err as Error).message); } }}><FileText size={16} /><span><strong>{source.name}</strong><small>{source.location}</small></span></button><Link href={source.folder_url} aria-label={'Open folder for ' + source.name}><FolderClosed size={17} /></Link></div>)}</div>}</article>;
        })}
        {active && <div className="assistant-working" role="status"><LoaderCircle size={16} className="spin" />{activity[lastActivity || ''] || 'Writing your reply'}…</div>}<div ref={end} />
      </div>
      <form className="assistant-composer" onSubmit={submit}><label className="sr-only" htmlFor="assistant-message">Message the drive assistant</label><textarea id="assistant-message" rows={3} maxLength={8000} value={text} onChange={event => setText(event.target.value)} placeholder={context ? 'Ask about ' + context.name + '…' : 'Ask about your files…'} disabled={!status?.connected} onKeyDown={event => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} /><div className="assistant-composer-actions"><label><input type="checkbox" checked={organize} onChange={event => setOrganize(event.target.checked)} disabled={Boolean(active)} />Allow folder creation, moving and renaming for this message</label>{active ? <button className="btn" type="button" onClick={stop}><Square size={15} />Stop</button> : <button className="btn primary" type="submit" disabled={busy || !status?.connected || !text.trim()}><Send size={16} />Send</button>}</div><small>Document contents are sent to your connected Codex account when read. Check important answers against the cited sources.</small></form>
    </div></div>
    {preview && <FilePreview files={[preview]} initialId={preview.id} listing={'folder_id=' + (preview.folder_id || 'root')} total={1} onClose={() => setPreview(null)} />}
  </section>;
}
