import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { Wire } from '../report.js';
import { deferred, until } from './deadline.js';

/** JSONL control port. No shell and no SDK state access. */
export class ProcessDriver {
  readonly child: ChildProcessWithoutNullStreams;
  readonly #pending = new Map<string, ReturnType<typeof deferred<Wire>>>();
  readonly #exit = deferred<void>();
  #failure: Error | undefined;
  #serial = 0;
  #buffer = '';
  #stderr = '';
  #stopping: Promise<void> | undefined;
  constructor(command: string, args: string[], url?: string) {
    this.child = spawn(command, args, { shell: false, env: { ...process.env, ...(url ? { VRT_CONFORMANCE_URL: url } : {}) } });
    this.child.stdout.setEncoding('utf8');
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', text => { this.#stderr = (this.#stderr + text).slice(-8192); });
    this.child.stdout.on('data', (text: string) => {
      this.#buffer += text;
      if (this.#buffer.length > 65536) return this.#fail(new Error('Driver stdout limit exceeded'));
      let newline: number;
      while ((newline = this.#buffer.indexOf('\n')) >= 0) {
        const line = this.#buffer.slice(0, newline); this.#buffer = this.#buffer.slice(newline + 1);
        try {
          const reply: unknown = JSON.parse(line);
          if (!reply || typeof reply !== 'object') throw new Error('Invalid driver reply');
          const value = reply as Wire;
          if (typeof value.requestId !== 'string' || typeof value.ok !== 'boolean') throw new Error('Invalid driver envelope');
          const pending = this.#pending.get(value.requestId);
          if (!pending) throw new Error(`Unmatched driver reply ${value.requestId}`);
          if (value.ok) pending.resolve(value.data ?? {});
          else pending.reject(new Error(`Driver: ${String(value.error)}`));
          this.#pending.delete(value.requestId);
        } catch (error) { this.#fail(error as Error); }
      }
    });
    this.child.on('error', error => this.#fail(error));
    this.child.stdin.on('error', error => this.#fail(error));
    this.child.on('close', (code, signal) => {
      this.#fail(new Error(`Driver exited (${code ?? signal}): ${this.#stderr}`)); this.#exit.resolve();
    });
  }
  #fail(error: Error): void {
    this.#failure ??= error;
    for (const pending of this.#pending.values()) pending.reject(this.#failure);
    this.#pending.clear();
  }
  async request(command: string, data: Wire, end: number): Promise<Wire> {
    if (this.#failure) throw this.#failure;
    const requestId = String(++this.#serial);
    const pending = deferred<Wire>(); this.#pending.set(requestId, pending);
    this.child.stdin.write(JSON.stringify({ requestId, command, data }) + '\n');
    try { return await until(pending.promise, end, `driver ${command}`); }
    finally { this.#pending.delete(requestId); }
  }
  stop(): Promise<void> { return this.#stopping ??= this.#stop(); }
  async #stop(): Promise<void> {
    try { await this.request('close', {}, performance.now() + 500); } catch { /* force cleanup below */ }
    this.child.stdin.end();
    try { await until(this.#exit.promise, performance.now() + 500, 'driver exit'); return; } catch { /* uncooperative driver */ }
    this.child.kill('SIGTERM');
    try { await until(this.#exit.promise, performance.now() + 500, 'driver termination'); return; } catch { /* final escalation */ }
    this.child.kill('SIGKILL');
    await until(this.#exit.promise, performance.now() + 1000, 'driver kill');
  }
}
