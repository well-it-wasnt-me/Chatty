import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Logger } from '../../core/logger.js';
import { encodeCommand, parseEnvelope, type WireEnvelope } from './protocol.js';

/**
 * Minimal socket surface of the browser/Node WebSocket API we use.
 * Injectable for tests (FakeSocket) - the real default wraps globalThis.WebSocket.
 */
export interface SimplexSocket {
  send(data: string): void;
  close(): void;
}

export interface SocketHandlers {
  onMessage(raw: string): void;
  onOpen(): void;
  onClose(code: number, reason: string): void;
  onError(message: string): void;
}

export type SocketFactory = (url: string, handlers: SocketHandlers) => SimplexSocket;

/** Real WebSocket connection (Node >=22 built-in client). */
export const nativeSocketFactory: SocketFactory = (url, handlers) => {
  const ws = new WebSocket(url);
  ws.onopen = () => handlers.onOpen();
  ws.onmessage = (event) => {
    if (typeof event.data === 'string') handlers.onMessage(event.data);
  };
  ws.onclose = (event) => handlers.onClose(event.code, event.reason);
  ws.onerror = () => handlers.onError('websocket error');
  return {
    send: (data) => ws.send(data),
    close: () => ws.close(),
  };
};

export interface SpawnOptions {
  binary: string;
  args: string[];
  cwd?: string;
}

export type Spawner = (options: SpawnOptions) => ChildProcess;

export const defaultSpawner: Spawner = (options) =>
  spawn(options.binary, options.args, { stdio: 'ignore', cwd: options.cwd });

export interface SimplexTransportOptions {
  binary: string;
  dbPathPrefix: string;
  displayName: string;
  port: number;
  socketFactory?: SocketFactory;
  spawner?: Spawner;
  logger?: Logger;
  /** How long to wait for the chat server port to accept connections. */
  startupTimeoutMs?: number;
  /** How long SIGTERM may take before escalating to SIGKILL. */
  stopTimeoutMs?: number;
}

interface PendingCommand {
  resolve(resp: Record<string, unknown>): void;
  reject(err: Error): void;
}

const DEFAULT_STARTUP_TIMEOUT_MS = 15_000;
const DEFAULT_STOP_TIMEOUT_MS = 3_000;

/**
 * Owns the `simplex-chat` child process and the WebSocket RPC channel.
 * Commands resolve via correlation ids; unsolicited server messages are
 * forwarded as events. No command text or event payload is logged.
 */
export class SimplexTransport {
  private readonly options: Required<
    Pick<SimplexTransportOptions, 'binary' | 'dbPathPrefix' | 'displayName' | 'port'>
  > &
    SimplexTransportOptions;
  private readonly logger?: Logger;

  private process: ChildProcess | undefined;
  private socket: SimplexSocket | undefined;
  private corrSeq = 0;
  private readonly pending = new Map<string, PendingCommand>();
  private eventHandler: ((envelope: WireEnvelope) => void) | undefined;
  private running = false;

  constructor(options: SimplexTransportOptions) {
    this.options = options;
    this.logger = options.logger?.child('transport');
  }

  isRunning(): boolean {
    return this.running;
  }

  /** The command text used for spawning (never logged once running secrets matter). */
  buildArgs(): string[] {
    return [
      '-d',
      this.options.dbPathPrefix,
      '-p',
      String(this.options.port),
      '--user-display-name',
      this.options.displayName,
      '--yes-migrate',
    ];
  }

  onEvent(handler: (envelope: WireEnvelope) => void): void {
    this.eventHandler = handler;
  }

  async start(): Promise<void> {
    if (this.running) return;
    const factory = this.options.socketFactory ?? nativeSocketFactory;
    const spawner = this.options.spawner ?? defaultSpawner;

    // The CLI expects the directory of the -d prefix to exist.
    mkdirSync(dirname(this.options.dbPathPrefix), { recursive: true, mode: 0o700 });

    this.process = spawner({
      binary: this.options.binary,
      args: this.buildArgs(),
    });
    const proc = this.process;
    proc.on('exit', (code, signal) => {
      const unexpected = this.running;
      this.running = false;
      if (unexpected) this.logger?.warn('simplex-chat exited', { code, signal });
      this.socket?.close();
    });
    proc.on('error', (error) => {
      this.running = false;
      this.logger?.error('simplex-chat spawn error', { error: error.message });
    });

    const url = `ws://127.0.0.1:${this.options.port}`;
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => {
        settled = true;
        reject(new Error(`simplex-chat did not open ${url} in time`));
      }, this.options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS);
      // Retry briefly: the chat server takes a moment to bind.
      const attempt = (): void => {
        if (this.running || settled) return; // connected, or startup gave up
        this.socket = factory(url, {
          onOpen: () => {
            settled = true;
            clearTimeout(timeout);
            this.running = true;
            resolve();
          },
          onMessage: (raw) => this.handleIncoming(raw),
          onClose: (code, reason) => {
            this.running = false;
            this.failAllPending(new Error(`socket closed (${code} ${reason})`));
          },
          onError: (message) => {
            if (!this.running && !settled) {
              // Startup phase: retry until the server accepts connections.
              setTimeout(attempt, 250).unref?.();
              void message;
              return;
            }
            this.logger?.warn('socket error', { error: message });
          },
        });
      };
      attempt();
    });
    this.logger?.info('transport connected', { port: this.options.port });
  }

  /** Sends a command and resolves with the correlated response object. */
  async command(cmd: string): Promise<Record<string, unknown>> {
    const socket = this.socket;
    if (!this.running || !socket) throw new Error('simplex transport is not running');
    this.corrSeq += 1;
    const corrId = String(this.corrSeq);
    return new Promise((resolve, reject) => {
      this.pending.set(corrId, { resolve: (resp) => resolve(resp), reject });
      // Never log `cmd` - it may carry message text.
      socket.send(encodeCommand(corrId, cmd));
    });
  }

  /** Graceful shutdown: close the socket, SIGTERM, escalate on timeout. */
  async stop(): Promise<void> {
    this.running = false;
    this.eventHandler = undefined;
    this.socket?.close();
    this.socket = undefined;
    this.failAllPending(new Error('transport stopped'));
    const proc = this.process;
    if (!proc || proc.exitCode !== null) return;
    const stopped = new Promise<void>((resolve) => {
      proc.once('exit', () => resolve());
    });
    proc.kill('SIGTERM');
    const timeout = new Promise<void>((resolve) =>
      setTimeout(resolve, this.options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS),
    );
    await Promise.race([stopped, timeout]);
    if (proc.exitCode === null) {
      this.logger?.warn('escalating to SIGKILL');
      proc.kill('SIGKILL');
      await stopped.catch(() => undefined);
    }
    this.process = undefined;
  }

  private handleIncoming(raw: string): void {
    const envelope = parseEnvelope(raw);
    if (!envelope) return;
    if (envelope.corrId !== undefined) {
      const entry = this.pending.get(envelope.corrId);
      if (entry) {
        this.pending.delete(envelope.corrId);
        entry.resolve(envelope.resp);
      }
      return;
    }
    try {
      this.eventHandler?.(envelope);
    } catch (error) {
      this.logger?.warn('event handler failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private failAllPending(error: Error): void {
    const entries = [...this.pending.values()];
    this.pending.clear();
    for (const entry of entries) entry.reject(error);
  }
}
