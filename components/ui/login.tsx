'use client';
import { useEffect, useState } from 'react';
import { ArrowRight, HardDrive, LockKeyhole, Eye, EyeOff } from 'lucide-react';
import { api } from '@/lib/client/client';
export default function Login() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [show, setShow] = useState(false);
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(true), []);
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError('');
    const form = new FormData(event.currentTarget);
    try {
      await api('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: form.get('username'), password: form.get('password') }),
      });
      window.location.assign('/files');
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }
  return (
    <main className="login-page">
      <div className="login-brand">
        <span className="brand-icon">
          <HardDrive size={22} />
        </span>
        Pocket Drive
      </div>
      <div className="login-card">
        <span className="eyebrow">
          <LockKeyhole size={14} /> YOUR PRIVATE SPACE
        </span>
        <h1>Welcome back.</h1>
        <p className="muted">Sign in to upload, find, and download your files.</p>
        <form onSubmit={submit} method="post" action="/api/auth/login">
          <label htmlFor="username">Username</label>
          <input
            id="username"
            name="username"
            placeholder="admin"
            autoComplete="username"
            required
            maxLength={100}
          />
          <label htmlFor="password">Password</label>
          <div className="password-field">
            <input
              id="password"
              name="password"
              type={show ? 'text' : 'password'}
              placeholder="Your password"
              autoComplete="current-password"
              required
              maxLength={1024}
            />
            <button
              type="button"
              className="icon-button"
              aria-label={show ? 'Hide password' : 'Show password'}
              onClick={() => setShow(!show)}
            >
              {show ? <EyeOff size={18} /> : <Eye size={18} />}
            </button>
          </div>
          {error && (
            <p className="alert error" role="alert">
              {error}
            </p>
          )}
          <button className="button primary full" disabled={busy || !ready}>
            {busy ? (
              'Signing in…'
            ) : (
              <>
                Sign in <ArrowRight size={18} />
              </>
            )}
          </button>
        </form>
        <div className="login-note">
          <LockKeyhole size={14} /> Files are accessible only after signing in.
        </div>
      </div>
      <p className="login-footer">Your files. Your space.</p>
    </main>
  );
}
