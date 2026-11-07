interface ConsoleOptions {
    limit?: number;
    clear?: boolean;
    level?: string;
    textContains?: string;
    waitForNext?: boolean;
    timeoutMs?: number;
}
interface NetworkOptions {
    limit?: number;
    clear?: boolean;
    urlContains?: string;
    method?: string;
    resourceType?: string;
    statusMin?: number;
    statusMax?: number;
    waitForNext?: boolean;
    waitUntil?: "request" | "response" | "finished";
    timeoutMs?: number;
}
export declare class BrowserRuntime {
    private readonly cdpHttpUrl;
    private readonly contexts;
    private readonly captures;
    private readonly captureSecret;
    private selectedPageId?;
    constructor(cdpHttpUrl?: string);
    getPages(): Promise<Array<Record<string, unknown>>>;
    inspectPage(pageId: string | undefined, maxDepth: number, maxNodes: number, includeHidden: boolean): Promise<unknown>;
    inspectElement(pageId: string | undefined, selector: string): Promise<unknown>;
    pickElement(pageId?: string, interactionPrompt?: string): Promise<unknown>;
    evaluate(pageId: string | undefined, expression: string, awaitPromise: boolean): Promise<unknown>;
    screenshot(pageId: string | undefined, fullPage: boolean, format: "png" | "jpeg", quality: number): Promise<{
        data: string;
        mimeType: string;
        page: string;
    }>;
    getConsole(pageId: string | undefined, options?: ConsoleOptions): Promise<unknown>;
    getNetwork(pageId: string | undefined, options: NetworkOptions): Promise<unknown>;
    beginCapture(pageId: string | undefined, kind: "console" | "network"): Promise<{
        captureId: string;
        kind: "console" | "network";
        pageId: string;
        startedAt: number;
        afterSequence: number;
        expiresAt: number;
    }>;
    finishConsoleCapture(captureRef: string, options?: ConsoleOptions): Promise<unknown>;
    finishNetworkCapture(captureRef: string, options: NetworkOptions): Promise<unknown>;
    verifyCaptureState(state: string): string;
    close(): void;
    private fetchTargets;
    private resolveTarget;
    private focusedPageId;
    private contextFor;
    private bindEvents;
    private trimNetwork;
    private waitUntil;
    private consoleMatches;
    private networkMatches;
    private mintCaptureState;
    private resolveCapture;
    private showReadyBanner;
    private hideReadyBanner;
    private evaluateValue;
    private evaluateRaw;
}
export {};
