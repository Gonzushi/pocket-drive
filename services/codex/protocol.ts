import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdir } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import path from 'node:path';

export const POCKET_DRIVE_NAMESPACE = 'pocket_drive';

export interface RpcMessage {
  jsonrpc?: string;
  id?: string | number;
  method?: string;
  params?: Record<string, any>;
  result?: any;
  error?: { code?: number; message: string };
}
export interface CodexClient {
  start(): Promise<unknown>;
  call(method: string, params?: Record<string, unknown>): Promise<any>;
  send(message: RpcMessage): void;
  reply(id: string | number, result: unknown): void;
  stop(): void;
  on(event: string, listener: (...args: any[]) => void): unknown;
}
type CodexEnvironment = NodeJS.ProcessEnv & { HOME: string; CODEX_HOME: string };

export class Codex extends EventEmitter {
  command: string;
  args: string[];
  environment: CodexEnvironment;
  child?: ChildProcessWithoutNullStreams;
  ready: Promise<void> | null = null;
  pending = new Map<number, { resolve: (value: any) => void; reject: (reason: Error) => void; timer: NodeJS.Timeout }>();
  sequence = 0;
  constructor(command: string, args: string[], environment: CodexEnvironment) { super(); this.command = command; this.args = args; this.environment = environment; }
  async start() {
    if (this.ready) return this.ready;
    this.ready = this.initialize().catch(error => { this.ready = null; throw error; });
    return this.ready;
  }
  async initialize() {
    await mkdir(this.environment.CODEX_HOME, { recursive: true, mode: 0o700 });
    await mkdir(this.environment.HOME + '/workspace', { recursive: true, mode: 0o700 });
    const child = this.child = spawn(this.command, this.args, { env: this.environment, cwd: this.environment.HOME + '/workspace', stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdin.on('error', () => {});
    child.stderr.on('data', () => {}); // Authentication logs must never reach the chat or server logs.
    const failed = () => {
      for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(new Error('Codex stopped. Try again.')); }
      this.pending.clear(); this.ready = null; this.emit('stopped');
    };
    child.once('error', failed); child.once('exit', failed);
    createInterface({ input: child.stdout }).on('line', line => {
      if (line.length > 2 * 1024 * 1024) return;
      let message: RpcMessage; try { message = JSON.parse(line); } catch { return; }
      if (message.method && message.id !== undefined) this.emit('request', message);
      else if (message.method) this.emit('notification', message);
      else {
        if (typeof message.id !== 'number') return;
        const entry = this.pending.get(message.id); if (!entry) return;
        clearTimeout(entry.timer); this.pending.delete(message.id);
        if (message.error) entry.reject(new Error(String(message.error.message || 'Codex request failed.').slice(0, 500)));
        else entry.resolve(message.result);
      }
    });
    await this.call('initialize', { clientInfo: { name: 'pocket_drive', title: 'Pocket Drive', version: '1.0.0' }, capabilities: { experimentalApi: true } });
    this.send({ method: 'initialized' });
  }
  send(message: RpcMessage) { if (!this.child || this.child.exitCode !== null) throw new Error('Codex is unavailable.'); this.child.stdin.write(JSON.stringify(message) + '\n'); }
  call(method: string, params: Record<string, unknown> = {}): Promise<any> {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('Codex did not respond in time.')); }, 45000);
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ jsonrpc: '2.0', id, method, params }); } catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  reply(id: string | number, result: unknown) { this.send({ jsonrpc: '2.0', id, result }); }
  stop() { this.child?.kill('SIGTERM'); }
}

export function productionCodex(environment = process.env) {
  const home = environment.CODEX_STATE_PATH || '/state';
  // Preserve HTTPS routing and trust settings without giving Codex app secrets.
  const network = Object.fromEntries([
    'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
    'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
    'CODEX_CA_CERTIFICATE', 'SSL_CERT_FILE', 'SSL_CERT_DIR'
  ].filter(name => environment[name]).map(name => [name, environment[name]]));
  const flags = ['shell_tool', 'unified_exec', 'apps', 'plugins', 'browser_use', 'computer_use', 'code_mode_host', 'remote_plugin', 'hooks', 'multi_agent', 'view_image'];
  // GPT-6.1 can route third-party tools through code mode. Keep Pocket Drive's
  // document namespace direct so it remains available while the code-mode
  // host itself stays disabled and the worker keeps its fail-closed tool boundary.
  return new Codex(path.resolve('node_modules/.bin/codex'), ['app-server', ...flags.flatMap(name => ['--disable', name]), '-c', `features.code_mode.direct_only_tool_namespaces=["${POCKET_DRIVE_NAMESPACE}"]`, '-c', 'web_search="disabled"', '-c', 'cli_auth_credentials_store="file"'], {
    ...network, PATH: environment.PATH, HOME: home, CODEX_HOME: home + '/codex', LANG: 'C.UTF-8', NODE_ENV: 'production'
  });
}
