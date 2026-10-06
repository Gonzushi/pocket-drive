'use client';
import { useEffect, useState } from 'react';
import {
  Check,
  Copy,
  KeyRound,
  Plus,
  ShieldCheck,
  Terminal,
  Trash2,
  ArrowUpRight,
  Code2,
} from 'lucide-react';
import { api, formatDate } from '@/lib/client/client';
import type { ApiKey } from '@/lib/shared/types';
import Modal from './modal';
export default function Keys() {
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [modalError, setModalError] = useState('');
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<string[]>(['read', 'upload']);
  const [newToken, setNewToken] = useState('');
  const [target, setTarget] = useState<ApiKey | null>(null);
  const [copied, setCopied] = useState('');
  const [copyError, setCopyError] = useState('');
  const [origin, setOrigin] = useState('https://files.yourdomain.com');
  const [example, setExample] = useState<'curl' | 'python'>('curl');
  useEffect(() => {
    setOrigin(window.location.origin);
    reload();
  }, []);
  async function reload() {
    setLoading(true);
    try {
      const data = await api<{ keys: ApiKey[] }>('/api/keys');
      setKeys(data.keys);
      setError('');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }
  async function create(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setModalError('');
    try {
      const data = await api<{ token: string }>('/api/keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, scopes }),
      });
      setNewToken(data.token);
      setCreating(false);
      setName('');
      await reload();
    } catch (err) {
      setModalError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function revoke() {
    if (!target) return;
    setBusy(true);
    setModalError('');
    try {
      await api(`/api/keys/${target.id}`, { method: 'DELETE' });
      setTarget(null);
      await reload();
    } catch (err) {
      setModalError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function copy(text: string, id: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(id);
      setCopyError('');
      setTimeout(() => setCopied(''), 2000);
    } catch {
      setCopyError('Copy is unavailable. Select the text and copy it manually.');
    }
  }
  const code =
    example === 'curl'
      ? `curl -X POST '${origin}/api/files' \\\n  -H 'Authorization: Bearer YOUR_API_KEY' \\\n  -F 'file=@report.pdf'`
      : `import requests\n\nwith open("report.pdf", "rb") as file:\n    response = requests.post(\n        "${origin}/api/files",\n        headers={"Authorization": "Bearer YOUR_API_KEY"},\n        files={"file": file},\n        timeout=300,\n    )\n    response.raise_for_status()\n    print(response.json())`;
  const endpoints = [
    ['POST', '/api/files', 'Upload one file', 'upload'],
    ['GET', '/api/files', 'List files', 'read'],
    ['GET', '/api/files/{id}', 'Get file details', 'read'],
    ['GET', '/api/files/{id}/download', 'Download a file', 'read'],
    ['DELETE', '/api/files/{id}', 'Delete a file', 'delete'],
    ['GET', '/api/storage', 'Check available space', 'read'],
    ['GET', '/api/folders/{id}/download', 'Download a folder ZIP', 'read'],
    ['POST', '/api/items/download', 'Download selected items as ZIP', 'read'],
    ['GET', '/api/folders/tree', 'Browse folder tree', 'read'],
    ['POST', '/api/folders', 'Create a folder', 'upload'],
    ['PATCH', '/api/files/{id}', 'Rename a file', 'upload'],
    ['PATCH', '/api/folders/{id}', 'Rename a folder', 'upload'],
    ['POST', '/api/items/move', 'Move files or folders', 'upload'],
    ['POST', '/api/items/delete', 'Delete selected items', 'delete'],
    ['DELETE', '/api/folders/{id}', 'Delete a folder and its contents', 'delete'],
  ];
  return (
    <div className="page-content">
      <div className="page-heading">
        <div>
          <span className="eyebrow">CONNECT YOUR TOOLS</span>
          <h1>Your files, automated.</h1>
          <p className="muted">Give your scripts a secure way to upload and access files.</p>
        </div>
        <button
          className="button primary"
          onClick={() => {
            setScopes(['read', 'upload']);
            setModalError('');
            setCreating(true);
          }}
        >
          <Plus size={18} />
          Create API key
        </button>
      </div>
      {error && (
        <div className="alert error" role="alert">
          {error}
          <button className="text-button" onClick={reload}>
            Try again
          </button>
        </div>
      )}
      {copyError && (
        <p className="alert error" role="alert">
          {copyError}
        </p>
      )}
      {newToken && (
        <section className="new-key-card">
          <div className="new-key-head">
            <span className="stat-icon">
              <Check size={22} />
            </span>
            <div>
              <h2>Your API key is ready.</h2>
              <p>Copy it now. The full key will not be shown again.</p>
            </div>
          </div>
          <div className="token-box">
            <code>{newToken}</code>
            <button className="button secondary" onClick={() => copy(newToken, 'token')}>
              {copied === 'token' ? <Check size={16} /> : <Copy size={16} />}
              {copied === 'token' ? 'Copied' : 'Copy key'}
            </button>
          </div>
          <button className="text-button" onClick={() => setNewToken('')}>
            I have saved my key · Hide it
          </button>
        </section>
      )}
      <section className="keys-card">
        <div className="section-title">
          <div>
            <h2>
              API keys <span className="count-badge">{keys.length}</span>
            </h2>
            <p className="small muted">Create a separate key for each script or app.</p>
          </div>
          <ShieldCheck size={22} className="muted" />
        </div>
        {loading ? (
          <div className="empty-state">
            <p>Loading your keys…</p>
          </div>
        ) : keys.length === 0 ? (
          <div className="empty-state compact">
            <span className="empty-icon">
              <KeyRound size={27} />
            </span>
            <h3>Connect your first tool.</h3>
            <p>Create a key, then use it in the example below.</p>
          </div>
        ) : (
          <div className="key-list">
            {keys.map((key) => (
              <div className="key-row" key={key.id}>
                <span className="file-type-icon document">
                  <KeyRound size={19} />
                </span>
                <div className="key-detail">
                  <strong>{key.name}</strong>
                  <span className="small muted">
                    Created {formatDate(key.created_at)} ·{' '}
                    {key.last_used_at
                      ? `Last used ${formatDate(key.last_used_at)}`
                      : 'Not used yet'}
                  </span>
                </div>
                <div className="scope-tags">
                  {key.scopes.map((scope) => (
                    <span key={scope}>{scope}</span>
                  ))}
                </div>
                <button
                  className="icon-button danger-hover"
                  title="Revoke key"
                  aria-label={`Revoke ${key.name}`}
                  onClick={() => {
                    setTarget(key);
                    setModalError('');
                  }}
                >
                  <Trash2 size={17} />
                </button>
              </div>
            ))}
          </div>
        )}
      </section>
      <section className="api-guide">
        <div className="guide-heading">
          <span className="stat-icon">
            <Terminal size={23} />
          </span>
          <div>
            <h2>Upload from a script.</h2>
            <p className="muted small">
              Replace YOUR_API_KEY with your key and report.pdf with your file.
            </p>
          </div>
          <ArrowUpRight size={21} className="muted" />
        </div>
        <div className="code-card">
          <div className="code-head">
            <div className="code-tabs">
              <button
                className={example === 'curl' ? 'active' : ''}
                onClick={() => setExample('curl')}
              >
                cURL
              </button>
              <button
                className={example === 'python' ? 'active' : ''}
                onClick={() => setExample('python')}
              >
                Python
              </button>
            </div>
            <button className="code-copy" onClick={() => copy(code, 'code')}>
              {copied === 'code' ? <Check size={15} /> : <Copy size={15} />}
              {copied === 'code' ? 'Copied' : 'Copy example'}
            </button>
          </div>
          <pre>
            <code>{code}</code>
          </pre>
        </div>
        <p className="small muted guide-note">
          Python needs the requests package: <code>pip install requests</code>. Uploads stay private
          and use the same storage quota as the website.
        </p>
      </section>
      <section className="endpoint-card">
        <div className="section-title">
          <div>
            <h2>What your API can do</h2>
            <p className="small muted">Send your key in the Authorization: Bearer header.</p>
          </div>
          <Code2 size={22} className="muted" />
        </div>
        <div className="endpoint-list">
          {endpoints.map(([method, path, description, scope]) => (
            <div className="endpoint-row" key={method + path}>
              <span className={`method ${method.toLowerCase()}`}>{method}</span>
              <code>{path}</code>
              <span>{description}</span>
              <span className="endpoint-scope">{scope}</span>
            </div>
          ))}
        </div>
      </section>
      <footer className="page-footer">
        <ShieldCheck size={14} />
        Treat API keys like passwords. Revoke a key whenever you no longer need it.
      </footer>
      {creating && (
        <Modal
          title="Create an API key"
          onClose={() => {
            if (!busy) setCreating(false);
          }}
        >
          <p className="muted">Name the tool that will use this key.</p>
          <form onSubmit={create}>
            <label htmlFor="key-name">Key name</label>
            <input
              id="key-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="e.g. Python reports or n8n"
              required
              maxLength={60}
              autoFocus
            />
            <label>Permissions</label>
            <div className="permission-list">
              {[
                {
                  id: 'read',
                  label: 'Read & download',
                  detail: 'Browse folders, download files, and check storage.',
                },
                {
                  id: 'upload',
                  label: 'Upload & organize',
                  detail: 'Add files and folders, rename items, and move them.',
                },
                {
                  id: 'delete',
                  label: 'Delete files & folders',
                  detail: 'Permanently remove items and folder contents.',
                },
              ].map((permission) => (
                <label className="permission" key={permission.id}>
                  <input
                    type="checkbox"
                    checked={scopes.includes(permission.id)}
                    onChange={(event) =>
                      setScopes((v) =>
                        event.target.checked
                          ? [...v, permission.id]
                          : v.filter((s) => s !== permission.id),
                      )
                    }
                  />
                  <span>
                    <strong>{permission.label}</strong>
                    <span>{permission.detail}</span>
                  </span>
                </label>
              ))}
            </div>
            {modalError && (
              <p className="alert error" role="alert">
                {modalError}
              </p>
            )}
            <div className="modal-actions">
              <button
                type="button"
                className="button secondary"
                disabled={busy}
                onClick={() => setCreating(false)}
              >
                Cancel
              </button>
              <button className="button primary" disabled={busy || !scopes.length}>
                {busy ? 'Creating…' : 'Create key'}
              </button>
            </div>
          </form>
        </Modal>
      )}
      {target && (
        <Modal
          title="Revoke this API key?"
          onClose={() => {
            if (!busy) setTarget(null);
          }}
        >
          <p className="muted">
            <strong>{target.name}</strong> will immediately lose access. Scripts using it will stop
            working until you give them a new key.
          </p>
          {modalError && (
            <p className="alert error" role="alert">
              {modalError}
            </p>
          )}
          <div className="modal-actions">
            <button className="button secondary" disabled={busy} onClick={() => setTarget(null)}>
              Keep key
            </button>
            <button className="button danger" disabled={busy} onClick={revoke}>
              {busy ? 'Revoking…' : 'Revoke key'}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
