'use client';
import { createContext, useContext, useEffect, useRef, useState, useCallback } from 'react';
import Link from 'next/link';
import {
  CloudUpload,
  Check,
  ChevronDown,
  ChevronUp,
  CircleAlert,
  LoaderCircle,
  Pause,
  Play,
  X,
} from 'lucide-react';
import { formatBytes } from '@/lib/client/client';
import {
  changeQueue,
  clearQueue,
  readQueue,
  saveQueue,
  sourceFile,
  type QueueItem,
  type UploadJob,
} from '@/lib/client/upload-queue';
import type { UploadSource } from '@/lib/client/drop';

interface Status {
  id: string;
  offset: number;
  size: number;
  status: string;
  chunk_size: number;
  busy: boolean;
}
class UploadError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
const aborted = () => new DOMException('Upload paused.', 'AbortError');
const wait = (time: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(aborted());
      return;
    }
    const abort = () => {
      clearTimeout(timer);
      reject(aborted());
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, time);
    signal.addEventListener('abort', abort, { once: true });
  });
async function call<T>(url: string, options: RequestInit, signal: AbortSignal): Promise<T> {
  const response = await fetch(url, { ...options, signal, cache: 'no-store' });
  let data;
  try {
    data = await response.json();
  } catch {
    throw new UploadError(response.status || 502, 'Upload response was interrupted. Retrying…');
  }
  if (!response.ok) throw new UploadError(response.status, data.error || 'Upload failed.');
  return data;
}
function chunk(
  id: string,
  offset: number,
  bytes: Blob,
  signal: AbortSignal,
  progress: (bytes: number) => void,
): Promise<Status> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    const abort = () => {
      request.abort();
      reject(aborted());
    };
    if (signal.aborted) {
      reject(aborted());
      return;
    }
    signal.addEventListener('abort', abort, { once: true });
    const done = () => signal.removeEventListener('abort', abort);
    request.open('PATCH', `/api/uploads/${id}`);
    request.setRequestHeader('Content-Type', 'application/octet-stream');
    request.setRequestHeader('Upload-Offset', String(offset));
    request.timeout = 135_000;
    request.upload.onprogress = (event) => progress(Math.min(bytes.size, event.loaded));
    request.onload = () => {
      done();
      let data;
      try {
        data = JSON.parse(request.responseText);
      } catch {
        reject(new UploadError(502, 'Upload response was interrupted. Retrying…'));
        return;
      }
      if (request.status >= 200 && request.status < 300) resolve(data);
      else reject(new UploadError(request.status, data.error || 'Upload failed.'));
    };
    request.onerror = () => {
      done();
      reject(new UploadError(0, 'Waiting for your connection…'));
    };
    request.ontimeout = () => {
      done();
      reject(new UploadError(408, 'Connection timed out. Retrying…'));
    };
    request.onabort = () => {
      done();
      reject(aborted());
    };
    request.send(bytes);
  });
}
interface Context {
  busy: boolean;
  ready: boolean;
  add: (sources: UploadSource[], destination: string, maxFile: number) => Promise<void>;
}
const UploadContext = createContext<Context | null>(null);
export function useUploads() {
  const value = useContext(UploadContext);
  if (!value) throw new Error('Upload provider missing.');
  return value;
}

export default function UploadProvider({ children }: { children: React.ReactNode }) {
  const [job, setJob] = useState<UploadJob | null>(null);
  const [ready, setReady] = useState(false);
  const [preparing, setPreparing] = useState(0);
  const [phase, setPhase] = useState('');
  const [fatal, setFatal] = useState('');
  const [live, setLive] = useState<{ id: string; bytes: number } | null>(null);
  const current = useRef<AbortController | null>(null);
  const channel = useRef<BroadcastChannel | null>(null);
  const preparingLock = useRef(false);
  const mounted = useRef(false);
  const publish = useCallback((value: UploadJob | null) => {
    if (mounted.current) setJob(value);
    channel.current?.postMessage('changed');
  }, []);
  const mutate = useCallback(
    async (id: string, change: (job: UploadJob) => void, remove?: string) => {
      const value = await changeQueue(id, change, remove);
      publish(value);
      return value;
    },
    [publish],
  );
  useEffect(() => {
    mounted.current = true;
    const stop = new AbortController();
    if (typeof BroadcastChannel !== 'undefined') {
      channel.current = new BroadcastChannel('pocket-drive-uploads');
      channel.current.onmessage = () => {
        readQueue()
          .then((value) => {
            if (!stop.signal.aborted && !preparingLock.current) {
              setJob(value);
              if (!value || value.paused || value.cancelled) current.current?.abort();
            }
          })
          .catch(() => {});
      };
    }
    const offline = () => current.current?.abort();
    window.addEventListener('offline', offline);
    const updateItem = (jobId: string, id: string, patch: Partial<QueueItem>, remove = false) =>
      mutate(
        jobId,
        (value) => {
          const item = value.items.find((item) => item.id === id);
          if (item && item.state !== 'done') Object.assign(item, patch);
        },
        remove ? id : undefined,
      );
    async function uploadOne(batch: UploadJob, item: QueueItem, signal: AbortSignal) {
      await updateItem(batch.id, item.id, {
        state: 'uploading',
        attempted: true,
        message: undefined,
      });
      const create = async (): Promise<Status> => {
        const name = item.name.normalize('NFC').trim();
        const parts = item.relativePath.split('/');
        if (item.relativePath) parts[parts.length - 1] = name;
        return call(
          '/api/uploads',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              id: item.id,
              name,
              size: item.size,
              mime_type: item.mime,
              folder_id: batch.destination,
              relative_path: item.relativePath ? parts.join('/') : '',
            }),
          },
          signal,
        );
      };
      let status: Status;
      if (!item.attempted) status = await create();
      else {
        try {
          status = await call(`/api/uploads/${item.id}`, {}, signal);
        } catch (error) {
          if (!(error instanceof UploadError) || error.status !== 404) throw error;
          status = await create();
        }
      }
      await updateItem(batch.id, item.id, { offset: status.offset });
      if (status.status !== 'complete') {
        if (status.busy) throw new UploadError(409, 'Recovering the interrupted chunk…');
        const file = await sourceFile(item.id);
        if (!file || file.size !== item.size)
          throw new UploadError(
            400,
            'The saved source is unavailable. Cancel this batch and select the files again.',
          );
        while (status.offset < item.size) {
          const saved = await readQueue();
          if (signal.aborted || saved?.id !== batch.id || saved.paused || saved.cancelled)
            throw aborted();
          const offset = status.offset;
          setLive({ id: item.id, bytes: 0 });
          status = await chunk(
            item.id,
            offset,
            file.slice(offset, Math.min(item.size, offset + status.chunk_size)),
            signal,
            (bytes) => {
              if (!signal.aborted && mounted.current) setLive({ id: item.id, bytes });
            },
          );
          await updateItem(batch.id, item.id, { offset: status.offset });
          setLive(null);
        }
        const saved = await readQueue();
        if (signal.aborted || saved?.id !== batch.id || saved.paused || saved.cancelled)
          throw aborted();
        await updateItem(batch.id, item.id, { state: 'finishing' });
        setPhase('Saving your file…');
        status = await call(`/api/uploads/${item.id}/complete`, { method: 'POST' }, signal);
      }
      if (status.status === 'complete') {
        const saved = await updateItem(
          batch.id,
          item.id,
          { state: 'done', offset: item.size, message: undefined },
          true,
        );
        window.dispatchEvent(
          new CustomEvent('pocket-drive-uploaded', {
            detail: { complete: saved?.items.every((item) => item.state === 'done') },
          }),
        );
      }
    }
    async function cancel(batch: UploadJob) {
      for (const item of batch.items) {
        if (!item.attempted || item.state === 'done') continue;
        try {
          await call(`/api/uploads/${item.id}`, { method: 'DELETE' }, stop.signal);
        } catch (error) {
          if (!(error instanceof UploadError) || error.status !== 404) throw error;
        }
      }
      await clearQueue(batch.id);
      publish(null);
      window.dispatchEvent(new Event('pocket-drive-uploaded'));
    }
    async function cycle() {
      let failures = 0;
      while (!stop.signal.aborted) {
        if (preparingLock.current) {
          await wait(100, stop.signal);
          continue;
        }
        const batch = await readQueue();
        if (stop.signal.aborted) return;
        setJob(batch);
        setReady(true);
        if (
          !batch ||
          batch.paused ||
          !navigator.onLine ||
          (!batch.cancelled &&
            !batch.items.some((item) => ['waiting', 'uploading', 'finishing'].includes(item.state)))
        ) {
          setPhase(!navigator.onLine && batch ? 'Offline — resumes when you reconnect.' : '');
          await wait(1000, stop.signal);
          continue;
        }
        const run = new AbortController();
        current.current = run;
        const signal = AbortSignal.any([stop.signal, run.signal]);
        const item = batch.items.find((item) =>
          ['waiting', 'uploading', 'finishing'].includes(item.state),
        );
        try {
          setPhase(batch.cancelled ? 'Cancelling unfinished uploads…' : 'Uploading…');
          if (batch.cancelled) await cancel(batch);
          else if (item) await uploadOne(batch, item, signal);
          failures = 0;
          setFatal('');
        } catch (error) {
          if (stop.signal.aborted) return;
          if (item) await updateItem(batch.id, item.id, { state: 'waiting' });
          if ((error as Error).name === 'AbortError') continue;
          const status = error instanceof UploadError ? error.status : 0;
          if ([401, 403, 507].includes(status))
            await mutate(batch.id, (value) => {
              value.paused = true;
              value.message =
                status === 401
                  ? 'Sign in again to continue your uploads.'
                  : (error as Error).message;
            });
          else if ([400, 404, 410, 413].includes(status) && item && !batch.cancelled)
            await updateItem(batch.id, item.id, {
              state: 'error',
              message: (error as Error).message,
            });
          else {
            setPhase((error as Error).message || 'Retrying your upload…');
            await wait(
              status === 409 ? 1000 : Math.min(30_000, 1000 * 2 ** Math.min(++failures, 5)),
              stop.signal,
            );
          }
        } finally {
          current.current = null;
          if (!stop.signal.aborted) setLive(null);
        }
      }
    }
    async function start() {
      try {
        const recovered = await readQueue();
        if (stop.signal.aborted) return;
        setJob(recovered);
        setReady(true);
        while (!stop.signal.aborted) {
          if (navigator.locks) {
            await navigator.locks.request(
              'pocket-drive-upload-runner',
              { ifAvailable: true },
              async (lock) => {
                if (stop.signal.aborted) return;
                if (lock) await cycle();
                else {
                  setPhase('Uploading in another tab.');
                  const saved = await readQueue();
                  if (!stop.signal.aborted) setJob(saved);
                }
              },
            );
            await wait(1000, stop.signal);
          } else await cycle();
        }
      } catch (error) {
        if (!stop.signal.aborted) {
          setReady(false);
          setFatal('Uploads could not be restored on this browser. Reload to retry.');
        }
      }
    }
    void start();
    return () => {
      mounted.current = false;
      stop.abort();
      current.current?.abort();
      channel.current?.close();
      channel.current = null;
      window.removeEventListener('offline', offline);
    };
  }, [mutate, publish]);
  async function add(sources: UploadSource[], destination: string, maxFile: number) {
    if (preparingLock.current) return;
    if (!sources.length || sources.length > 5000)
      throw new Error('Choose between 1 and 5,000 files per batch.');
    const oversized = sources.find((source) => source.file.size > maxFile);
    if (oversized)
      throw new Error(`“${oversized.file.name}” exceeds the ${formatBytes(maxFile)} file limit.`);
    preparingLock.current = true;
    setFatal('');
    const batch: UploadJob = {
      id: crypto.randomUUID(),
      destination,
      items: sources.map(({ file, relativePath }) => ({
        id: crypto.randomUUID(),
        name: file.name,
        relativePath,
        size: file.size,
        mime: file.type || 'application/octet-stream',
        offset: 0,
        state: 'waiting',
      })),
      paused: false,
      cancelled: false,
      collapsed: sources.length > 5,
    };
    try {
      const existing = await readQueue();
      if (existing?.items.some((item) => item.state !== 'done'))
        throw new Error('Finish or cancel your current uploads before adding another batch.');
      const bytes = batch.items.reduce((sum, item) => sum + item.size, 0);
      const estimate = await navigator.storage?.estimate?.();
      if (estimate?.quota && bytes + 2 * 1024 * 1024 > estimate.quota - (estimate.usage || 0))
        throw new Error(
          'This device needs more browser storage to resume these files after refresh. Free device space or select a smaller batch.',
        );
      void navigator.storage?.persist?.().catch(() => {});
      setJob(batch);
      setPreparing(1);
      setPhase('Saving files on this device. Keep this tab open until preparation finishes.');
      try {
        await saveQueue(
          batch,
          sources.map((source) => source.file),
          (count) => setPreparing(Math.max(1, Math.round((count / sources.length) * 100))),
        );
      } catch (error) {
        throw new Error(
          (error as Error).message.includes('current uploads')
            ? (error as Error).message
            : 'Could not save these files on your device for refresh recovery. Free device space or choose a smaller batch.',
        );
      }
      publish(batch);
    } catch (error) {
      setJob(await readQueue().catch(() => null));
      throw error;
    } finally {
      preparingLock.current = false;
      setPreparing(0);
    }
  }
  const action = async (kind: 'pause' | 'resume' | 'cancel' | 'collapse' | 'dismiss') => {
    if (!job) return;
    try {
      if (kind === 'dismiss') {
        await clearQueue(job.id);
        publish(null);
        return;
      }
      await mutate(job.id, (value) => {
        if (kind === 'collapse') value.collapsed = !value.collapsed;
        else if (kind === 'cancel') {
          value.cancelled = true;
          value.paused = false;
        } else {
          value.paused = kind === 'pause';
          if (kind === 'resume') {
            value.message = undefined;
            value.items.forEach((item) => {
              if (item.state === 'error') {
                item.state = 'waiting';
                item.message = undefined;
              }
            });
          }
        }
      });
      if (kind === 'pause' || kind === 'cancel') current.current?.abort();
    } catch {
      setFatal('Could not save that change. Reload and try again.');
    }
  };
  const busy = !!preparing || !!job?.items.some((item) => item.state !== 'done');
  return (
    <UploadContext.Provider value={{ busy, ready, add }}>
      {children}
      {(job || fatal) && (
        <UploadPanel
          job={job}
          live={live}
          preparing={preparing}
          phase={phase}
          fatal={fatal}
          action={action}
        />
      )}
    </UploadContext.Provider>
  );
}

function UploadPanel({
  job,
  live,
  preparing,
  phase,
  fatal,
  action,
}: {
  job: UploadJob | null;
  live: { id: string; bytes: number } | null;
  preparing: number;
  phase: string;
  fatal: string;
  action: (kind: 'pause' | 'resume' | 'cancel' | 'collapse' | 'dismiss') => Promise<void>;
}) {
  const [scroll, setScroll] = useState(0);
  useEffect(() => setScroll(0), [job?.id]);
  if (!job)
    return (
      <section className="upload-panel" aria-label="Uploads">
        <p className="error-text" role="alert">
          {fatal}
        </p>
      </section>
    );
  const done = job.items.filter((item) => item.state === 'done').length;
  const errors = job.items.filter((item) => item.state === 'error').length;
  const total = job.items.reduce((sum, item) => sum + item.size, 0);
  const bytes = job.items.reduce((sum, item) => sum + item.offset, 0) + (live?.bytes || 0);
  const complete = done === job.items.length;
  const percent = preparing
    ? preparing
    : complete
      ? 100
      : Math.min(
          99,
          Math.floor(
            total ? (Math.min(bytes, total) / total) * 100 : (done / job.items.length) * 100,
          ),
        );
  const active = job.items.find((item) => item.state === 'uploading' || item.state === 'finishing');
  const title = preparing
    ? 'Preparing uploads'
    : complete
      ? 'Upload complete'
      : job.cancelled
        ? 'Cancelling uploads'
        : job.paused
          ? 'Uploads paused'
          : errors && done + errors === job.items.length
            ? 'Some uploads need attention'
            : 'Uploading files';
  const start = Math.max(0, Math.floor(scroll / 48) - 1);
  const rows = job.items.slice(start, start + 8);
  return (
    <section
      className={`upload-panel ${job.collapsed ? 'collapsed' : ''}`}
      aria-label="Upload progress"
    >
      <div className="upload-panel-head">
        <span className="upload-panel-icon">
          {complete ? (
            <Check size={18} />
          ) : job.paused ? (
            <Pause size={17} />
          ) : (
            <CloudUpload size={18} />
          )}
        </span>
        <div>
          <strong>{title}</strong>
          <span>
            {preparing
              ? 'Saving on this device · keep this tab open'
              : `${done} of ${job.items.length} files · ${percent}%`}
          </span>
        </div>
        <button
          className="icon-button"
          aria-label={job.collapsed ? 'Expand uploads' : 'Collapse uploads'}
          aria-expanded={!job.collapsed}
          onClick={() => action('collapse')}
          disabled={!!preparing}
        >
          {job.collapsed ? <ChevronUp size={18} /> : <ChevronDown size={18} />}
        </button>
      </div>
      <div
        className="upload-overall progress-track"
        role="progressbar"
        aria-label="Overall upload progress"
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div style={{ width: `${percent}%` }} />
      </div>
      {!job.collapsed && (
        <>
          <div className="upload-panel-summary">
            <span>
              {formatBytes(Math.min(bytes, total))} / {formatBytes(total)}
            </span>
            <span>
              {preparing
                ? 'Keep this tab open'
                : errors
                  ? `${errors} need attention`
                  : 'Resumes after refresh'}
            </span>
          </div>
          {complete ? (
            <p role="status" className="upload-complete-message">
              {done} {done === 1 ? 'file' : 'files'} uploaded successfully.
            </p>
          ) : (
            <>
              <p className="upload-current truncate">
                {job.message ||
                  phase ||
                  (active ? active.relativePath || active.name : 'Ready to continue.')}
              </p>
              {active && (
                <div className="upload-current-file">
                  <span className="truncate">{active.relativePath || active.name}</span>
                  <span>
                    {active.state === 'finishing'
                      ? 'Saving…'
                      : `${Math.min(99, Math.floor(((active.offset + (live?.id === active.id ? live.bytes : 0)) / Math.max(1, active.size)) * 100))}%`}
                  </span>
                </div>
              )}
              <div
                className="upload-file-list"
                role="list"
                aria-label="Files in this upload"
                onScroll={(event) => setScroll(event.currentTarget.scrollTop)}
              >
                <div style={{ height: job.items.length * 48, position: 'relative' }}>
                  {rows.map((item, index) => (
                    <div
                      className={`upload-file-row ${item.state}`}
                      key={item.id}
                      role="listitem"
                      aria-posinset={start + index + 1}
                      aria-setsize={job.items.length}
                      style={{ position: 'absolute', top: (start + index) * 48, left: 0, right: 0 }}
                    >
                      <span>
                        {item.state === 'done' ? (
                          <Check size={15} />
                        ) : item.state === 'error' ? (
                          <CircleAlert size={15} />
                        ) : item.state === 'uploading' || item.state === 'finishing' ? (
                          <LoaderCircle className="spin" size={15} />
                        ) : (
                          <span className="upload-wait-dot" />
                        )}
                      </span>
                      <div>
                        <span className="truncate" title={item.relativePath || item.name}>
                          {item.relativePath || item.name}
                        </span>
                        <small className="truncate">
                          {item.message ||
                            (item.state === 'done'
                              ? 'Uploaded'
                              : item.state === 'error'
                                ? 'Needs attention'
                                : item.state === 'finishing'
                                  ? 'Saving…'
                                  : item.state === 'uploading'
                                    ? 'Uploading…'
                                    : 'Waiting')}
                        </small>
                      </div>
                      <span>{formatBytes(item.size)}</span>
                    </div>
                  ))}
                </div>
              </div>
            </>
          )}
          {fatal && (
            <p className="error-text" role="alert">
              {fatal}
            </p>
          )}
          <div className="upload-panel-actions">
            {complete ? (
              <button className="text-button" onClick={() => action('dismiss')}>
                Dismiss
              </button>
            ) : (
              <>
                {job.message?.includes('Sign in') ? (
                  <Link className="text-button" href="/login">
                    Sign in again
                  </Link>
                ) : (
                  <button
                    className="text-button"
                    disabled={!!preparing || job.cancelled}
                    onClick={() => action(job.paused || (errors && !active) ? 'resume' : 'pause')}
                  >
                    {job.paused || (errors && !active) ? (
                      <>
                        <Play size={14} />
                        Resume
                      </>
                    ) : (
                      <>
                        <Pause size={14} />
                        Pause
                      </>
                    )}
                  </button>
                )}
                <button
                  className="text-button"
                  disabled={!!preparing || job.cancelled}
                  onClick={() => action('cancel')}
                >
                  Cancel uploads
                </button>
              </>
            )}
          </div>
        </>
      )}
      {job.collapsed && complete && (
        <>
          <span className="sr-only" role="status">
            {done} {done === 1 ? 'file' : 'files'} uploaded successfully.
          </span>
          <button
            className="upload-dismiss icon-button"
            aria-label="Dismiss completed uploads"
            onClick={() => action('dismiss')}
          >
            <X size={15} />
          </button>
        </>
      )}
    </section>
  );
}
