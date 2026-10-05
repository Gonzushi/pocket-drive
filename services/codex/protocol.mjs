import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdir } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import path from 'node:path';

export class Codex extends EventEmitter {
  constructor(command, args, environment) { super(); this.command = command; this.args = args; this.environment = environment; this.pending = new Map(); this.sequence = 0; }
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
      let message; try { message = JSON.parse(line); } catch { return; }
      if (message.method && message.id !== undefined) this.emit('request', message);
      else if (message.method) this.emit('notification', message);
      else {
        const entry = this.pending.get(message.id); if (!entry) return;
        clearTimeout(entry.timer); this.pending.delete(message.id);
        if (message.error) entry.reject(new Error(String(message.error.message || 'Codex request failed.').slice(0, 500)));
        else entry.resolve(message.result);
      }
    });
    await this.call('initialize', { clientInfo: { name: 'pocket_drive', title: 'Pocket Drive', version: '1.0.0' }, capabilities: { experimentalApi: true } });
    this.send({ method: 'initialized' });
  }
  send(message) { if (!this.child || this.child.exitCode !== null) throw new Error('Codex is unavailable.'); this.child.stdin.write(JSON.stringify(message) + '\n'); }
  call(method, params = {}) {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('Codex did not respond in time.')); }, 45000);
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ jsonrpc: '2.0', id, method, params }); } catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  reply(id, result) { this.send({ jsonrpc: '2.0', id, result }); }
  stop() { this.child?.kill('SIGTERM'); }
}

export function productionCodex() {
  const home = process.env.CODEX_STATE_PATH || '/state';
  const flags = ['shell_tool', 'unified_exec', 'apps', 'browser_use', 'computer_use', 'code_mode_host', 'remote_plugin', 'hooks', 'multi_agent', 'view_image'];
  return new Codex(path.resolve('node_modules/.bin/codex'), ['app-server', ...flags.flatMap(name => ['--disable', name]), '-c', 'web_search="disabled"', '-c', 'cli_auth_credentials_store="file"'], {
    PATH: process.env.PATH, HOME: home, CODEX_HOME: home + '/codex', LANG: 'C.UTF-8', NODE_ENV: 'production'
  });
}
