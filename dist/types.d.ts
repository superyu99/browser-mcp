export type JsonObject = Record<string, unknown>;
export interface CdpTarget {
    id: string;
    type: string;
    title: string;
    url: string;
    webSocketDebuggerUrl?: string;
    devtoolsFrontendUrl?: string;
}
export interface CdpMessage {
    id?: number;
    method?: string;
    params?: JsonObject;
    result?: JsonObject;
    error?: {
        code: number;
        message: string;
        data?: unknown;
    };
}
export interface ConsoleEntry {
    sequence: number;
    timestamp: number;
    type: string;
    text: string;
    url?: string;
    line?: number;
    column?: number;
}
export interface NetworkEntry {
    sequence: number;
    requestId: string;
    startedAt: number;
    method: string;
    url: string;
    resourceType?: string;
    status?: number;
    statusText?: string;
    mimeType?: string;
    durationMs?: number;
    encodedDataLength?: number;
    failed?: string;
    initiator?: string;
    requestHeaders?: Record<string, string>;
    responseHeaders?: Record<string, string>;
}
