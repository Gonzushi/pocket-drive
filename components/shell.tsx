'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';
import { HardDrive, FolderClosed, KeyRound, LogOut, LockKeyhole } from 'lucide-react';
import { api } from '@/lib/client';
import ExplorerProvider from './explorer-context';
import FolderTree from './folder-tree';
import UploadProvider from './uploads';
export default function Shell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname(); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  async function logout() { setBusy(true); try { await api('/api/auth/logout', { method: 'POST' }); window.location.assign('/login'); } catch (err) { setError((err as Error).message); setBusy(false); } }
  return <UploadProvider><ExplorerProvider><div className="app-shell"><a href="#main" className="skip-link">Skip to content</a><aside className="sidebar">
    <Link href="/files" className="brand"><span className="brand-icon"><HardDrive size={22} /></span><span>Pocket Drive<span className="brand-sub">A little space for everything.</span></span></Link>
    <div className="nav-label">YOUR WORKSPACE</div><nav aria-label="Main navigation"><Link href="/files" className={pathname === '/files' ? 'nav-item active' : 'nav-item'} aria-current={pathname === '/files' ? 'page' : undefined}><FolderClosed size={19} />My files<span className="nav-dot" /></Link><Link href="/keys" className={pathname === '/keys' ? 'nav-item active' : 'nav-item'} aria-current={pathname === '/keys' ? 'page' : undefined}><KeyRound size={19} />API keys</Link></nav>
    {pathname === '/files' && <div className="desktop-tree"><FolderTree /></div>}
    <div className="sidebar-bottom"><span className="private-pill"><LockKeyhole size={13} /> Private workspace</span><button onClick={logout} className="logout" disabled={busy}><LogOut size={16} />{busy ? 'Signing out…' : 'Sign out'}</button>{error && <p className="small error-text" role="alert">{error}</p>}</div>
  </aside><main id="main" className="main-content"><header className="topbar"><span>{pathname === '/keys' ? 'Workspace / API keys' : 'Workspace / My files'}</span><span className="owner"><span className="avatar">ME</span>Personal workspace</span></header>{children}</main></div></ExplorerProvider></UploadProvider>;
}
