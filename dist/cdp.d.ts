import type { JsonObject } from "./types.js";
type EventHandler = (params: JsonObject) => void;
export declare class CdpError extends Error {
    readonly code?: number | undefined;
    readonly data?: unknown | undefined;
    constructor(message: string, code?: number | undefined, data?: unknown | undefined);
}
export declare class CdpSession {
    readonly url: string;
    private socket;
    private nextId;
    private readonly pending;
    private readonly handlers;
    constructor(url: string);
    get connected(): boolean;
    connect(): Promise<void>;
    on(method: string, handler: EventHandler): () => void;
    send<T extends JsonObject = JsonObject>(method: string, params?: JsonObject, timeoutMs?: number): Promise<T>;
    close(): void;
    private handleMessage;
    private rejectPending;
}
export {};
