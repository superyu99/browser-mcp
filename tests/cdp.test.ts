import assert from "node:assert/strict";
import test from "node:test";
import { CdpSession } from "../src/cdp.js";

class FakeWebSocket extends EventTarget {
  static readonly OPEN = 1;
  readonly OPEN = 1;
  readyState = 0;
  constructor(readonly url: string) { super(); queueMicrotask(() => { this.readyState = 1; this.dispatchEvent(new Event("open")); }); }
  send(raw: string): void {
    const request = JSON.parse(raw) as { id: number; method: string };
    queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ id: request.id, result: { echoed: request.method } }) })));
  }
  close(): void { this.readyState = 3; this.dispatchEvent(new Event("close")); }
  emit(method: string, params: Record<string, unknown>): void {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ method, params }) }));
  }
}

test("CdpSession correlates commands and dispatches events", async () => {
  const original = globalThis.WebSocket;
  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
  try {
    const session = new CdpSession("ws://chrome/devtools/page/1");
    const response = await session.send("Runtime.enable");
    assert.deepEqual(response, { echoed: "Runtime.enable" });
    let event: Record<string, unknown> | undefined;
    session.on("Runtime.consoleAPICalled", params => { event = params; });
    (session as unknown as { socket: FakeWebSocket }).socket.emit("Runtime.consoleAPICalled", { type: "log" });
    assert.deepEqual(event, { type: "log" });
    session.close();
  } finally { globalThis.WebSocket = original; }
});
