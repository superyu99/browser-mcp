import { CDP_COMMAND_TIMEOUT_MS } from "./config.js";
export class CdpError extends Error {
    code;
    data;
    constructor(message, code, data) {
        super(message);
        this.code = code;
        this.data = data;
        this.name = "CdpError";
    }
}
export class CdpSession {
    url;
    socket;
    nextId = 1;
    pending = new Map();
    handlers = new Map();
    constructor(url) {
        this.url = url;
    }
    get connected() {
        return this.socket?.readyState === WebSocket.OPEN;
    }
    async connect() {
        if (this.connected)
            return;
        const socket = new WebSocket(this.url);
        this.socket = socket;
        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new CdpError("Timed out connecting to Chrome")), CDP_COMMAND_TIMEOUT_MS);
            socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
            socket.addEventListener("error", () => { clearTimeout(timer); reject(new CdpError("Could not open the Chrome CDP WebSocket")); }, { once: true });
        });
        socket.addEventListener("message", event => this.handleMessage(String(event.data)));
        socket.addEventListener("close", () => this.rejectPending(new CdpError("Chrome closed the CDP connection")));
        socket.addEventListener("error", () => this.rejectPending(new CdpError("Chrome CDP WebSocket error")));
    }
    on(method, handler) {
        const set = this.handlers.get(method) ?? new Set();
        set.add(handler);
        this.handlers.set(method, set);
        return () => set.delete(handler);
    }
    async send(method, params = {}, timeoutMs = CDP_COMMAND_TIMEOUT_MS) {
        await this.connect();
        const id = this.nextId++;
        const response = new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new CdpError(`CDP command timed out: ${method}`));
            }, timeoutMs);
            this.pending.set(id, { resolve, reject, timer });
        });
        this.socket.send(JSON.stringify({ id, method, params }));
        return await response;
    }
    close() {
        this.socket?.close();
        this.socket = undefined;
    }
    handleMessage(raw) {
        let message;
        try {
            message = JSON.parse(raw);
        }
        catch {
            return;
        }
        if (message.id !== undefined) {
            const pending = this.pending.get(message.id);
            if (!pending)
                return;
            clearTimeout(pending.timer);
            this.pending.delete(message.id);
            if (message.error)
                pending.reject(new CdpError(message.error.message, message.error.code, message.error.data));
            else
                pending.resolve(message.result ?? {});
            return;
        }
        if (!message.method)
            return;
        for (const handler of this.handlers.get(message.method) ?? []) {
            try {
                handler(message.params ?? {});
            }
            catch { /* A malformed event must not kill the MCP server. */ }
        }
    }
    rejectPending(error) {
        for (const { reject, timer } of this.pending.values()) {
            clearTimeout(timer);
            reject(error);
        }
        this.pending.clear();
    }
}
//# sourceMappingURL=cdp.js.map