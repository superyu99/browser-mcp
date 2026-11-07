import { CDP_COMMAND_TIMEOUT_MS } from "./config.js";
import type { CdpMessage, JsonObject } from "./types.js";

type EventHandler = (params: JsonObject) => void;

export class CdpError extends Error {
  constructor(message: string, readonly code?: number, readonly data?: unknown) {
    super(message);
    this.name = "CdpError";
  }
}

export class CdpSession {
  private socket: WebSocket | undefined;
  private nextId = 1;
  private readonly pending = new Map<number, {
    resolve: (value: JsonObject) => void;
    reject: (reason: unknown) => void;
    timer: NodeJS.Timeout;
  }>();
  private readonly handlers = new Map<string, Set<EventHandler>>();

  constructor(readonly url: string) {}

  get connected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    const socket = new WebSocket(this.url);
    this.socket = socket;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new CdpError("Timed out connecting to Chrome")), CDP_COMMAND_TIMEOUT_MS);
      socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener("error", () => { clearTimeout(timer); reject(new CdpError("Could not open the Chrome CDP WebSocket")); }, { once: true });
    });
    socket.addEventListener("message", event => this.handleMessage(String(event.data)));
    socket.addEventListener("close", () => this.rejectPending(new CdpError("Chrome closed the CDP connection")));
    socket.addEventListener("error", () => this.rejectPending(new CdpError("Chrome CDP WebSocket error")));
  }

  on(method: string, handler: EventHandler): () => void {
    const set = this.handlers.get(method) ?? new Set<EventHandler>();
    set.add(handler);
    this.handlers.set(method, set);
    return () => set.delete(handler);
  }

  async send<T extends JsonObject = JsonObject>(method: string, params: JsonObject = {}, timeoutMs = CDP_COMMAND_TIMEOUT_MS): Promise<T> {
    await this.connect();
    const id = this.nextId++;
    const response = new Promise<JsonObject>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CdpError(`CDP command timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
    this.socket!.send(JSON.stringify({ id, method, params }));
    return await response as T;
  }

  close(): void {
    this.socket?.close();
    this.socket = undefined;
  }

  private handleMessage(raw: string): void {
    let message: CdpMessage;
    try { message = JSON.parse(raw) as CdpMessage; }
    catch { return; }
    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) pending.reject(new CdpError(message.error.message, message.error.code, message.error.data));
      else pending.resolve(message.result ?? {});
      return;
    }
    if (!message.method) return;
    for (const handler of this.handlers.get(message.method) ?? []) {
      try { handler(message.params ?? {}); }
      catch { /* A malformed event must not kill the MCP server. */ }
    }
  }

  private rejectPending(error: Error): void {
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(error);
    }
    this.pending.clear();
  }
}
