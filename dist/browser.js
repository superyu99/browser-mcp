import { CDP_HTTP_URL, DEFAULT_RESULT_LIMIT, MAX_CONSOLE_ENTRIES, MAX_EVALUATE_CHARS, MAX_HTML_CHARS, MAX_NETWORK_ENTRIES, PICK_ELEMENT_TIMEOUT_MS, } from "./config.js";
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { CdpError, CdpSession } from "./cdp.js";
import { inspectElementScript, inspectPageScript, pickElementScript } from "./page-scripts.js";
import { clip, initiatorPreview, jsonText, pickHeaders, valuePreview } from "./utils.js";
const text = (value) => typeof value === "string" ? value : undefined;
const number = (value) => typeof value === "number" ? value : undefined;
const object = (value) => value && typeof value === "object" ? value : undefined;
export class BrowserRuntime {
    cdpHttpUrl;
    contexts = new Map();
    captures = new Map();
    captureSecret = randomBytes(32);
    selectedPageId;
    constructor(cdpHttpUrl = CDP_HTTP_URL) {
        this.cdpHttpUrl = cdpHttpUrl;
    }
    async getPages() {
        const targets = await this.fetchTargets();
        const pages = targets.filter(target => target.type === "page" && target.webSocketDebuggerUrl);
        if (!pages.length)
            throw new Error(`Chrome is reachable at ${this.cdpHttpUrl}, but it exposes no debuggable page tabs`);
        await Promise.allSettled(pages.map(page => this.contextFor(page.id)));
        this.selectedPageId = await this.focusedPageId(pages) ?? pages[0].id;
        return pages.map(page => ({
            id: page.id,
            selected: page.id === this.selectedPageId,
            title: page.title,
            url: page.url,
            attached: this.contexts.get(page.id)?.session.connected ?? false,
        }));
    }
    async inspectPage(pageId, maxDepth, maxNodes, includeHidden) {
        return this.evaluateValue(pageId, inspectPageScript(maxDepth, maxNodes, includeHidden));
    }
    async inspectElement(pageId, selector) {
        return this.evaluateValue(pageId, inspectElementScript(selector, MAX_HTML_CHARS));
    }
    async pickElement(pageId, interactionPrompt) {
        return this.evaluateValue(pageId, pickElementScript(interactionPrompt), PICK_ELEMENT_TIMEOUT_MS + 5_000);
    }
    async evaluate(pageId, expression, awaitPromise) {
        const response = await this.evaluateRaw(pageId, expression, awaitPromise);
        const remote = response.result ?? {};
        return {
            type: remote.type ?? "undefined",
            subtype: remote.subtype,
            value: "value" in remote ? remote.value : undefined,
            preview: clip(valuePreview(remote), MAX_EVALUATE_CHARS),
        };
    }
    async screenshot(pageId, fullPage, format, quality) {
        const context = await this.contextFor(pageId);
        const params = { format, fromSurface: true, captureBeyondViewport: fullPage };
        if (format === "jpeg")
            params.quality = quality;
        if (fullPage) {
            const metrics = await context.session.send("Page.getLayoutMetrics");
            const size = object(metrics.cssContentSize) ?? object(metrics.contentSize);
            if (size)
                params.clip = { x: 0, y: 0, width: Math.min(number(size.width) ?? 0, 16_384), height: Math.min(number(size.height) ?? 0, 16_384), scale: 1 };
        }
        const result = await context.session.send("Page.captureScreenshot", params);
        if (typeof result.data !== "string")
            throw new Error("Chrome returned no screenshot data");
        return { data: result.data, mimeType: `image/${format}`, page: context.target.id };
    }
    async getConsole(pageId, options = {}) {
        const context = await this.contextFor(pageId);
        const cleared = options.clear ? context.console.length : 0;
        if (options.clear)
            context.console.length = 0;
        const startIndex = context.console.length;
        const matches = (entry) => (!options.level || entry.type === options.level) && (!options.textContains || entry.text.includes(options.textContains));
        if (options.waitForNext) {
            const timeoutMs = options.timeoutMs ?? 30_000;
            await this.showReadyBanner(context, "browser-mcp is listening for console output — perform the action now", timeoutMs);
            try {
                const matched = await this.waitUntil(() => context.console.slice(startIndex).find(matches), timeoutMs, `console event${options.textContains ? ` containing "${options.textContains}"` : ""}`);
                return { pageId: context.target.id, waited: true, cleared, matched, entries: [matched] };
            }
            finally {
                await this.hideReadyBanner(context);
            }
        }
        if (options.clear)
            return { pageId: context.target.id, cleared, entries: [] };
        const entries = context.console.filter(matches).slice(-(options.limit ?? DEFAULT_RESULT_LIMIT));
        return { pageId: context.target.id, buffered: context.console.length, returned: entries.length, entries };
    }
    async getNetwork(pageId, options) {
        const context = await this.contextFor(pageId);
        const cleared = options.clear ? context.network.size : 0;
        if (options.clear) {
            context.network.clear();
            context.requestTimestamps.clear();
        }
        const previousIds = new Set(context.network.keys());
        const matches = (entry) => (!options.urlContains || entry.url.includes(options.urlContains)) &&
            (!options.method || entry.method === options.method.toUpperCase()) &&
            (!options.resourceType || entry.resourceType?.toLowerCase() === options.resourceType.toLowerCase()) &&
            (options.statusMin === undefined || (entry.status ?? 0) >= options.statusMin) &&
            (options.statusMax === undefined || (entry.status ?? 999) <= options.statusMax);
        if (options.waitForNext) {
            const waitUntil = options.waitUntil ?? "finished";
            const reached = (entry) => waitUntil === "request" ||
                (waitUntil === "response" ? entry.status !== undefined || entry.failed !== undefined : entry.durationMs !== undefined || entry.failed !== undefined);
            const timeoutMs = options.timeoutMs ?? 30_000;
            await this.showReadyBanner(context, "browser-mcp is listening for network activity — perform the action now", timeoutMs);
            try {
                const matched = await this.waitUntil(() => [...context.network.values()].find(entry => !previousIds.has(entry.requestId) && matches(entry) && reached(entry)), timeoutMs, `network ${waitUntil}${options.urlContains ? ` matching "${options.urlContains}"` : ""}`);
                return { pageId: context.target.id, waited: true, waitUntil, cleared, matched, entries: [matched] };
            }
            finally {
                await this.hideReadyBanner(context);
            }
        }
        if (options.clear)
            return { pageId: context.target.id, cleared, entries: [] };
        const entries = [...context.network.values()].filter(matches).slice(-(options.limit ?? DEFAULT_RESULT_LIMIT));
        return { pageId: context.target.id, buffered: context.network.size, returned: entries.length, entries };
    }
    async beginCapture(pageId, kind) {
        const context = await this.contextFor(pageId);
        const capture = {
            id: randomUUID(), kind, pageId: context.target.id, afterSequence: context.nextEventSequence,
            startedAt: Date.now(), expiresAt: Date.now() + 10 * 60_000,
        };
        this.captures.set(capture.id, capture);
        await this.showReadyBanner(context, `browser-mcp ${kind} capture is active — perform the action, then confirm completion`, 10 * 60_000);
        return { captureId: this.mintCaptureState(capture.id), kind, pageId: capture.pageId, startedAt: capture.startedAt, afterSequence: capture.afterSequence, expiresAt: capture.expiresAt };
    }
    async finishConsoleCapture(captureRef, options = {}) {
        const capture = this.resolveCapture(captureRef, "console"), context = await this.contextFor(capture.pageId);
        try {
            const entries = context.console.filter(entry => entry.sequence > capture.afterSequence && this.consoleMatches(entry, options)).slice(-(options.limit ?? DEFAULT_RESULT_LIMIT));
            return { captureId: capture.id, kind: capture.kind, pageId: capture.pageId, startedAt: capture.startedAt, finishedAt: Date.now(), returned: entries.length, entries };
        }
        finally {
            this.captures.delete(capture.id);
            await this.hideReadyBanner(context);
        }
    }
    async finishNetworkCapture(captureRef, options) {
        const capture = this.resolveCapture(captureRef, "network"), context = await this.contextFor(capture.pageId);
        try {
            const entries = [...context.network.values()].filter(entry => entry.sequence > capture.afterSequence && this.networkMatches(entry, options)).slice(-(options.limit ?? DEFAULT_RESULT_LIMIT));
            return { captureId: capture.id, kind: capture.kind, pageId: capture.pageId, startedAt: capture.startedAt, finishedAt: Date.now(), returned: entries.length, entries };
        }
        finally {
            this.captures.delete(capture.id);
            await this.hideReadyBanner(context);
        }
    }
    verifyCaptureState(state) {
        const [payload, signature, extra] = state.split(".");
        if (!payload || !signature || extra)
            throw new Error("Invalid capture state");
        const expected = createHmac("sha256", this.captureSecret).update(payload).digest();
        const actual = Buffer.from(signature, "base64url");
        if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
            throw new Error("Invalid capture state");
        const id = Buffer.from(payload, "base64url").toString("utf8"), capture = this.captures.get(id);
        if (!capture || capture.expiresAt < Date.now()) {
            this.captures.delete(id);
            throw new Error("Expired capture state");
        }
        return id;
    }
    close() {
        for (const context of this.contexts.values())
            context.session.close();
        this.contexts.clear();
        this.captures.clear();
    }
    async fetchTargets() {
        let response;
        try {
            response = await fetch(`${this.cdpHttpUrl.replace(/\/$/, "")}/json/list`);
        }
        catch (error) {
            throw new Error(`Cannot reach Chrome at ${this.cdpHttpUrl}. Start Chrome with remote debugging enabled. ${error instanceof Error ? error.message : ""}`.trim());
        }
        if (!response.ok)
            throw new Error(`Chrome target list failed: HTTP ${response.status}`);
        return await response.json();
    }
    async resolveTarget(pageId) {
        const pages = (await this.fetchTargets()).filter(target => target.type === "page" && target.webSocketDebuggerUrl);
        const id = pageId ?? this.selectedPageId;
        const target = id ? pages.find(page => page.id === id) : pages[0];
        if (!target)
            throw new Error(id ? `Page not found: ${id}. Call get_pages again.` : "Chrome has no debuggable page tab");
        return target;
    }
    async focusedPageId(pages) {
        const focused = await Promise.all(pages.map(async (page) => {
            const context = this.contexts.get(page.id);
            if (!context?.session.connected)
                return undefined;
            try {
                const response = await context.session.send("Runtime.evaluate", {
                    expression: "document.visibilityState === 'visible' && document.hasFocus()", returnByValue: true,
                });
                return response.result?.value === true ? page.id : undefined;
            }
            catch {
                return undefined;
            }
        }));
        return focused.find((id) => id !== undefined);
    }
    async contextFor(pageId) {
        const target = await this.resolveTarget(pageId);
        const cached = this.contexts.get(target.id);
        if (cached?.session.connected) {
            cached.target = target;
            return cached;
        }
        cached?.session.close();
        const session = new CdpSession(target.webSocketDebuggerUrl);
        const context = {
            target, session, console: cached?.console ?? [], network: cached?.network ?? new Map(),
            requestTimestamps: cached?.requestTimestamps ?? new Map(), nextEventSequence: cached?.nextEventSequence ?? 0,
        };
        this.contexts.set(target.id, context);
        this.bindEvents(context);
        await session.connect();
        await Promise.all([session.send("Page.enable"), session.send("Runtime.enable"), session.send("Network.enable", { maxTotalBufferSize: 10_000_000, maxResourceBufferSize: 2_000_000 })]);
        return context;
    }
    bindEvents(context) {
        context.session.on("Runtime.consoleAPICalled", params => {
            const args = Array.isArray(params.args) ? params.args : [];
            const stack = object(params.stackTrace);
            const frames = Array.isArray(stack?.callFrames) ? stack.callFrames : [];
            const frame = frames[0];
            const entry = { sequence: ++context.nextEventSequence, timestamp: number(params.timestamp) ?? Date.now(), type: text(params.type) ?? "log", text: clip(args.map(valuePreview).join(" "), 4_000) };
            if (frame && text(frame.url))
                entry.url = text(frame.url);
            if (frame && number(frame.lineNumber) !== undefined)
                entry.line = number(frame.lineNumber) + 1;
            if (frame && number(frame.columnNumber) !== undefined)
                entry.column = number(frame.columnNumber) + 1;
            context.console.push(entry);
            if (context.console.length > MAX_CONSOLE_ENTRIES)
                context.console.shift();
        });
        context.session.on("Runtime.exceptionThrown", params => {
            const details = object(params.exceptionDetails) ?? {};
            const exception = object(details.exception);
            const entry = { sequence: ++context.nextEventSequence, timestamp: number(params.timestamp) ?? Date.now(), type: "exception", text: clip(text(details.text) ?? (exception ? valuePreview(exception) : "Uncaught exception"), 4_000) };
            if (text(details.url))
                entry.url = text(details.url);
            if (number(details.lineNumber) !== undefined)
                entry.line = number(details.lineNumber) + 1;
            if (number(details.columnNumber) !== undefined)
                entry.column = number(details.columnNumber) + 1;
            context.console.push(entry);
            if (context.console.length > MAX_CONSOLE_ENTRIES)
                context.console.shift();
        });
        context.session.on("Network.requestWillBeSent", params => {
            const requestId = text(params.requestId);
            const request = object(params.request);
            if (!requestId || !request)
                return;
            const timestamp = number(params.timestamp) ?? 0;
            context.requestTimestamps.set(requestId, timestamp);
            const entry = {
                sequence: ++context.nextEventSequence, requestId, startedAt: (number(params.wallTime) ?? Date.now() / 1000) * 1000,
                method: text(request.method) ?? "GET", url: text(request.url) ?? "",
            };
            const initiator = initiatorPreview(params.initiator);
            if (initiator)
                entry.initiator = initiator;
            const headers = pickHeaders(request.headers);
            if (headers)
                entry.requestHeaders = headers;
            context.network.set(requestId, entry);
            this.trimNetwork(context);
        });
        context.session.on("Network.responseReceived", params => {
            const requestId = text(params.requestId);
            const response = object(params.response);
            if (!requestId || !response)
                return;
            const entry = context.network.get(requestId);
            if (!entry)
                return;
            const resourceType = text(params.type), status = number(response.status), statusText = text(response.statusText), mimeType = text(response.mimeType);
            if (resourceType)
                entry.resourceType = resourceType;
            if (status !== undefined)
                entry.status = status;
            if (statusText)
                entry.statusText = statusText;
            if (mimeType)
                entry.mimeType = mimeType;
            const headers = pickHeaders(response.headers);
            if (headers)
                entry.responseHeaders = headers;
        });
        context.session.on("Network.loadingFinished", params => {
            const requestId = text(params.requestId);
            if (!requestId)
                return;
            const entry = context.network.get(requestId);
            if (!entry)
                return;
            const encodedDataLength = number(params.encodedDataLength);
            if (encodedDataLength !== undefined)
                entry.encodedDataLength = encodedDataLength;
            const start = context.requestTimestamps.get(requestId), end = number(params.timestamp);
            if (start !== undefined && end !== undefined)
                entry.durationMs = Math.round((end - start) * 1000);
        });
        context.session.on("Network.loadingFailed", params => {
            const requestId = text(params.requestId);
            if (!requestId)
                return;
            const entry = context.network.get(requestId);
            if (!entry)
                return;
            entry.failed = text(params.errorText) ?? "request failed";
            const resourceType = text(params.type);
            if (resourceType)
                entry.resourceType = resourceType;
        });
    }
    trimNetwork(context) {
        while (context.network.size > MAX_NETWORK_ENTRIES) {
            const oldest = context.network.keys().next().value;
            if (!oldest)
                break;
            context.network.delete(oldest);
            context.requestTimestamps.delete(oldest);
        }
    }
    async waitUntil(probe, timeoutMs, label) {
        const immediate = probe();
        if (immediate !== undefined)
            return immediate;
        return await new Promise((resolve, reject) => {
            const startedAt = Date.now();
            const timer = setInterval(() => {
                const value = probe();
                if (value !== undefined) {
                    clearInterval(timer);
                    resolve(value);
                    return;
                }
                if (Date.now() - startedAt >= timeoutMs) {
                    clearInterval(timer);
                    reject(new Error(`Timed out after ${timeoutMs} ms waiting for ${label}`));
                }
            }, 50);
        });
    }
    consoleMatches(entry, options) {
        return (!options.level || entry.type === options.level) && (!options.textContains || entry.text.includes(options.textContains));
    }
    networkMatches(entry, options) {
        return (!options.urlContains || entry.url.includes(options.urlContains)) &&
            (!options.method || entry.method === options.method.toUpperCase()) &&
            (!options.resourceType || entry.resourceType?.toLowerCase() === options.resourceType.toLowerCase()) &&
            (options.statusMin === undefined || (entry.status ?? 0) >= options.statusMin) &&
            (options.statusMax === undefined || (entry.status ?? 999) <= options.statusMax);
    }
    mintCaptureState(id) {
        const payload = Buffer.from(id).toString("base64url"), signature = createHmac("sha256", this.captureSecret).update(payload).digest("base64url");
        return `${payload}.${signature}`;
    }
    resolveCapture(ref, expectedKind) {
        const id = this.captures.has(ref) ? ref : this.verifyCaptureState(ref), capture = this.captures.get(id);
        if (!capture || capture.expiresAt < Date.now())
            throw new Error("Capture is missing or expired");
        if (expectedKind && capture.kind !== expectedKind)
            throw new Error(`Capture kind is ${capture.kind}, expected ${expectedKind}`);
        return capture;
    }
    async showReadyBanner(context, message, timeoutMs) {
        const expression = `(() => {
      document.getElementById('__browser_mcp_wait_banner')?.remove();
      const banner = document.createElement('div'); banner.id = '__browser_mcp_wait_banner';
      Object.assign(banner.style, { position: 'fixed', pointerEvents: 'none', zIndex: '2147483647', top: '16px', left: '50%', transform: 'translateX(-50%)', padding: '9px 14px', borderRadius: '8px', background: '#065f46', color: '#fff', font: '13px/1.4 system-ui,sans-serif', boxShadow: '0 4px 16px rgba(0,0,0,.3)' });
      banner.textContent = ${JSON.stringify(message)}; document.documentElement.appendChild(banner);
      setTimeout(() => banner.remove(), ${timeoutMs + 1_000}); return true;
    })()`;
        await context.session.send("Runtime.evaluate", { expression, returnByValue: true });
    }
    async hideReadyBanner(context) {
        try {
            await context.session.send("Runtime.evaluate", { expression: "document.getElementById('__browser_mcp_wait_banner')?.remove()", returnByValue: true });
        }
        catch { /* Navigation can destroy the old execution context after the captured action. */ }
    }
    async evaluateValue(pageId, expression, timeoutMs) {
        const response = await this.evaluateRaw(pageId, expression, true, timeoutMs);
        const remote = response.result ?? {};
        if (!("value" in remote))
            throw new Error(`Result is not serializable: ${valuePreview(remote)}`);
        return remote.value;
    }
    async evaluateRaw(pageId, expression, awaitPromise = true, timeoutMs) {
        const context = await this.contextFor(pageId);
        const params = { expression, awaitPromise, returnByValue: true, generatePreview: true, userGesture: true };
        if (timeoutMs)
            params.timeout = timeoutMs;
        const response = await context.session.send("Runtime.evaluate", params, timeoutMs ?? undefined);
        if (response.exceptionDetails) {
            const details = response.exceptionDetails, exception = object(details.exception);
            throw new CdpError(text(details.text) ?? (exception ? valuePreview(exception) : jsonText(details, 4_000)));
        }
        return response;
    }
}
//# sourceMappingURL=browser.js.map