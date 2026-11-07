import assert from "node:assert/strict";
import { createServer as createHttpServer, type Server } from "node:http";
import test from "node:test";
import { WebSocketServer } from "ws";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { BrowserRuntime } from "../src/browser.js";
import { createServer as createMcpServer } from "../src/server.js";

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+Xw4hAAAAAElFTkSuQmCC";

async function fakeChrome(): Promise<{
  http: Server; endpoint: string;
  addPage: (id: string, title: string, url: string) => void;
  focusPage: (id: string) => void;
  emitInteraction: (id: string, consoleText: string, url: string) => void;
}> {
  let port = 0;
  let focusedPageId = "page-1";
  const pages = [{ id: "page-1", type: "page", title: "Fixture", url: "https://fixture.test/" }];
  const addPage = (id: string, title: string, url: string): void => { pages.unshift({ id, type: "page", title, url }); };
  const focusPage = (id: string): void => { focusedPageId = id; };
  const http = createHttpServer((request, response) => {
    if (request.url !== "/json/list") { response.writeHead(404).end(); return; }
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(pages.map(page => ({ ...page, webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/${page.id}` }))));
  });
  const webSockets = new WebSocketServer({ noServer: true });
  const pageIds = new WeakMap<object, string>();
  const emitInteraction = (id: string, consoleText: string, url: string): void => {
    for (const ws of webSockets.clients) {
      ws.send(JSON.stringify({ method: "Runtime.consoleAPICalled", params: { timestamp: 1, type: "log", args: [{ type: "string", value: consoleText }] } }));
      ws.send(JSON.stringify({ method: "Network.requestWillBeSent", params: { requestId: id, timestamp: 10, wallTime: 100, request: { method: "GET", url, headers: { Accept: "image/*", Authorization: "hidden" } }, initiator: { type: "parser" } } }));
      ws.send(JSON.stringify({ method: "Network.responseReceived", params: { requestId: id, type: "Image", response: { status: 200, statusText: "OK", mimeType: "image/svg+xml", headers: { "Content-Type": "image/svg+xml" } } } }));
      ws.send(JSON.stringify({ method: "Network.loadingFinished", params: { requestId: id, timestamp: 10.025, encodedDataLength: 42 } }));
    }
  };
  http.on("upgrade", (request, socket, head) => webSockets.handleUpgrade(request, socket, head, ws => {
    pageIds.set(ws, request.url?.split("/").at(-1) ?? "page-1"); webSockets.emit("connection", ws, request);
  }));
  webSockets.on("connection", ws => ws.on("message", raw => {
    const request = JSON.parse(String(raw)) as { id: number; method: string; params?: Record<string, unknown> };
    let result: Record<string, unknown> = {};
    if (request.method === "Runtime.evaluate") {
      const expression = String(request.params?.expression ?? "");
      const pageId = pageIds.get(ws) ?? "page-1";
      const value = expression.includes("document.hasFocus()") ? pageId === focusedPageId
        : expression === "location.href" ? pages.find(page => page.id === pageId)?.url
        : expression.includes("maxDepth =") ? { title: "Fixture", nodes: 3, clipped: false }
        : expression.includes("No element matches") ? { tag: "img", selector: "#logo" }
        : expression.startsWith("new Promise") ? { cancelled: false, selector: "#logo", tag: "img" } : 2;
      result = { result: { type: typeof value === "number" ? "number" : "object", value } };
    }
    if (request.method === "Page.getLayoutMetrics") result = { cssContentSize: { width: 800, height: 1200 } };
    if (request.method === "Page.captureScreenshot") result = { data: png };
    ws.send(JSON.stringify({ id: request.id, result }));
    if (request.method === "Network.enable") setImmediate(() => emitInteraction("r1", "ready", "https://fixture.test/logo.svg"));
  }));
  await new Promise<void>(resolve => http.listen(0, "127.0.0.1", resolve));
  port = (http.address() as { port: number }).port;
  return { http, endpoint: `http://127.0.0.1:${port}`, addPage, focusPage, emitInteraction };
}

test("BrowserRuntime completes the eight-tool CDP flow", async () => {
  const fixture = await fakeChrome();
  const runtime = new BrowserRuntime(fixture.endpoint);
  try {
    const pages = await runtime.getPages();
    assert.equal(pages.length, 1);
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.deepEqual(await runtime.inspectPage(undefined, 5, 200, false), { title: "Fixture", nodes: 3, clipped: false });
    assert.deepEqual(await runtime.inspectElement(undefined, "#logo"), { tag: "img", selector: "#logo" });
    assert.deepEqual(await runtime.pickElement(), { cancelled: false, selector: "#logo", tag: "img" });
    assert.equal((await runtime.evaluate(undefined, "1 + 1", true) as { value: number }).value, 2);
    assert.equal((await runtime.getConsole(undefined) as { entries: unknown[] }).entries.length, 1);
    const network = await runtime.getNetwork(undefined, {}) as { entries: Array<{ status: number; durationMs: number; requestHeaders: Record<string, string> }> };
    assert.equal(network.entries[0]?.status, 200);
    assert.equal(network.entries[0]?.durationMs, 25);
    assert.deepEqual(network.entries[0]?.requestHeaders, { Accept: "image/*" });
    const consoleWait = runtime.getConsole(undefined, { clear: true, waitForNext: true, textContains: "clicked", timeoutMs: 1_000 });
    setTimeout(() => fixture.emitInteraction("r2", "button clicked", "https://fixture.test/ignored"), 20);
    assert.equal((await consoleWait as { matched: { text: string } }).matched.text, "button clicked");
    const networkWait = runtime.getNetwork(undefined, { clear: true, waitForNext: true, urlContains: "/api/action", waitUntil: "finished", timeoutMs: 1_000 });
    setTimeout(() => fixture.emitInteraction("r3", "request sent", "https://fixture.test/api/action"), 20);
    const matchedNetwork = (await networkWait as { matched: { url: string; durationMs: number } }).matched;
    assert.equal(matchedNetwork.url, "https://fixture.test/api/action");
    assert.equal(matchedNetwork.durationMs, 25);
    const screenshot = await runtime.screenshot(undefined, true, "png", 85);
    assert.equal(screenshot.data, png);

    const manualCapture = await runtime.beginCapture(undefined, "network");
    assert.throws(() => runtime.verifyCaptureState(`${manualCapture.captureId}tampered`), /Invalid capture state/);
    fixture.emitInteraction("r-manual", "manual flow", "https://fixture.test/api/manual-capture");
    await new Promise(resolve => setTimeout(resolve, 10));
    const manualResult = await runtime.finishNetworkCapture(manualCapture.captureId, { urlContains: "/manual-capture" }) as { entries: Array<{ sequence: number; url: string }> };
    assert.equal(manualResult.entries[0]?.url, "https://fixture.test/api/manual-capture");
    assert.ok((manualResult.entries[0]?.sequence ?? 0) > manualCapture.afterSequence);

    fixture.addPage("page-2", "Google", "https://google.test/"); fixture.focusPage("none");
    const refreshedPages = await runtime.getPages();
    assert.equal(refreshedPages.find(page => page.selected)?.id, "page-2");
    assert.equal((await runtime.evaluate(undefined, "location.href", true) as { value: string }).value, "https://google.test/");
    assert.equal((await runtime.evaluate("page-1", "location.href", true) as { value: string }).value, "https://fixture.test/");
    assert.equal((await runtime.evaluate(undefined, "location.href", true) as { value: string }).value, "https://google.test/");
    fixture.focusPage("page-1");
    assert.equal((await runtime.getPages()).find(page => page.selected)?.id, "page-1");

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createMcpServer(runtime);
    const client = new Client({ name: "interaction-test", version: "1.0.0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const picked = await client.callTool({ name: "pick_element", arguments: { interaction_prompt: "Click the logo you mean · Esc to cancel" } });
    const pickedText = picked.content.find(item => item.type === "text");
    assert.ok(pickedText?.type === "text" && pickedText.text.includes("#logo"));

    const networkStart = await client.callTool({ name: "get_network", arguments: { capture_action: "start" } });
    const networkStartText = networkStart.content.find(item => item.type === "text");
    assert.ok(networkStartText?.type === "text");
    const networkCaptureId = JSON.parse(networkStartText.text).captureId as string;
    fixture.emitInteraction("r4", "user action", "https://fixture.test/api/two-phase");
    await new Promise(resolve => setTimeout(resolve, 10));
    const networkFinish = await client.callTool({ name: "get_network", arguments: { capture_action: "finish", capture_id: networkCaptureId, url_contains: "/two-phase" } });
    const networkFinishText = networkFinish.content.find(item => item.type === "text");
    assert.ok(networkFinishText?.type === "text" && networkFinishText.text.includes("/api/two-phase"));

    const consoleStart = await client.callTool({ name: "get_console", arguments: { capture_action: "start" } });
    const consoleStartText = consoleStart.content.find(item => item.type === "text");
    assert.ok(consoleStartText?.type === "text");
    const consoleCaptureId = JSON.parse(consoleStartText.text).captureId as string;
    fixture.emitInteraction("r5", "two-phase console", "https://fixture.test/ignored");
    await new Promise(resolve => setTimeout(resolve, 10));
    const consoleFinish = await client.callTool({ name: "get_console", arguments: { capture_action: "finish", capture_id: consoleCaptureId, text_contains: "two-phase console" } });
    const consoleFinishText = consoleFinish.content.find(item => item.type === "text");
    assert.ok(consoleFinishText?.type === "text" && consoleFinishText.text.includes("two-phase console"));
    await client.close(); await server.close();
  } finally {
    runtime.close();
    await new Promise<void>((resolve, reject) => fixture.http.close(error => error ? reject(error) : resolve()));
  }
});
