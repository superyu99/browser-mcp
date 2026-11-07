#!/usr/bin/env node
import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { pathToFileURL } from "node:url";
import * as z from "zod/v4";
import { BrowserRuntime } from "./browser.js";
import { DEFAULT_RESULT_LIMIT } from "./config.js";
import { jsonText } from "./utils.js";

const VERSION = "0.5.0";
const pageId = z.string().optional().describe("Target page id from get_pages; omit to use the selected page");

const result = (value: unknown): CallToolResult => ({ content: [{ type: "text", text: jsonText(value) }] });
const run = async (action: () => Promise<unknown>): Promise<CallToolResult> => {
  try { return result(await action()); }
  catch (error) { return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true }; }
};

export function createServer(runtime = new BrowserRuntime()): McpServer {
  const server = new McpServer(
    { name: "browser-mcp", version: VERSION },
    { instructions: `Treat the user as an active debugging partner, not as a passive source of prose. Prefer one precise, low-effort user action over guessing runtime state.
- For visually ambiguous references such as “this logo”, tell the user what to click, then call pick_element with the same instruction in interaction_prompt. The page shows that instruction and the tool blocks until the user clicks or presses Escape; no client form is involved.
- To capture an unknown user-triggered request, call get_network with capture_action=start, retain captureId, tell the user exactly what to do in chat, then call capture_action=finish with capture_id after the user reports completion. Repeat relevant filters on finish.
- Use the same start/chat/finish sequence with get_console when reproducing an error or console message.
- After the user opens or switches tabs, call get_pages again before omitting page_id; it refreshes the default to the focused page. An explicit page_id affects only that tool call.
- Use direct inspection when the target is already unambiguous. Do not request user work that the runtime tools can perform reliably themselves.`,
    },
  );

  server.registerTool("get_pages", {
    title: "Get browser pages",
    description: "List Chrome page tabs, refresh the default to the currently focused tab, and start console/network capture. Call again after the user switches or opens a tab.",
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true },
  }, async () => run(() => runtime.getPages()));

  server.registerTool("inspect_page", {
    title: "Inspect page structure",
    description: "Return a compact, visibility-aware DOM tree with useful attributes and short text. Prefer this over dumping document HTML. If the user's visual reference remains ambiguous, stop guessing and use pick_element with an interaction prompt.",
    inputSchema: z.object({
      page_id: pageId,
      max_depth: z.number().int().min(1).max(10).default(5).describe("DOM tree depth"),
      max_nodes: z.number().int().min(10).max(1000).default(200).describe("Hard node limit"),
      include_hidden: z.boolean().default(false),
    }),
    annotations: { readOnlyHint: true },
  }, async ({ page_id, max_depth, max_nodes, include_hidden }) => run(() => runtime.inspectPage(page_id, max_depth, max_nodes, include_hidden)));

  server.registerTool("inspect_element", {
    title: "Inspect one element",
    description: "Inspect the first element matching a CSS selector: stable selector, attributes, box, selected computed styles, relatives, text and clipped outer HTML.",
    inputSchema: z.object({ page_id: pageId, selector: z.string().min(1).describe("CSS selector understood by document.querySelector") }),
    annotations: { readOnlyHint: true },
  }, async ({ page_id, selector }) => run(() => runtime.inspectElement(page_id, selector)));

  server.registerTool("pick_element", {
    title: "Pick an element interactively",
    description: "Resolve visual phrases such as 'this logo' with the page-runtime picker. Tell the user what to click before calling. The call blocks while the page highlights hovered elements, then returns the clicked element; Escape cancels. interaction_prompt changes only the page banner and never opens a client form.",
    inputSchema: z.object({
      page_id: pageId,
      interaction_prompt: z.string().min(1).optional().describe("Concrete instruction shown in the browser page banner, e.g. 'Click the logo you mean · Esc to cancel'"),
    }),
    annotations: { readOnlyHint: false },
  }, async ({ page_id, interaction_prompt }) => run(() => runtime.pickElement(page_id, interaction_prompt)));

  server.registerTool("evaluate", {
    title: "Evaluate JavaScript",
    description: "Evaluate JavaScript in the selected page's main runtime. Supports promises and mutations, so an expression can install a one-shot DOM event listener and resolve after the user acts. Results must be serializable.",
    inputSchema: z.object({
      page_id: pageId,
      expression: z.string().min(1).describe("JavaScript expression or IIFE"),
      await_promise: z.boolean().default(true),
    }),
    annotations: { readOnlyHint: false, destructiveHint: true },
  }, async ({ page_id, expression, await_promise }) => run(() => runtime.evaluate(page_id, expression, await_promise)));

  server.registerTool("screenshot", {
    title: "Capture screenshot",
    description: "Capture the viewport or full page and return it as MCP image content for visual verification.",
    inputSchema: z.object({
      page_id: pageId,
      full_page: z.boolean().default(false),
      format: z.enum(["png", "jpeg"]).default("png"),
      quality: z.number().int().min(1).max(100).default(85).describe("JPEG quality; ignored for PNG"),
    }),
    annotations: { readOnlyHint: true },
  }, async ({ page_id, full_page, format, quality }) => {
    try {
      const image = await runtime.screenshot(page_id, full_page, format, quality);
      return { content: [{ type: "text", text: `Screenshot from page ${image.page}` }, { type: "image", data: image.data, mimeType: image.mimeType }] };
    } catch (error) { return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true }; }
  });

  server.registerTool("get_console", {
    title: "Get console events",
    description: "Read console events or coordinate a user action without client forms. For collaboration: call capture_action=start, retain captureId, ask the user to reproduce the event in chat, then call finish with capture_id and filters.",
    inputSchema: z.object({
      page_id: pageId,
      limit: z.number().int().min(1).max(200).default(DEFAULT_RESULT_LIMIT),
      level: z.enum(["log", "debug", "info", "error", "warning", "assert", "exception"]).optional(),
      text_contains: z.string().optional().describe("Only match messages containing this text"),
      clear: z.boolean().default(false).describe("Clear captured entries before reading or waiting"),
      wait_for_next: z.boolean().default(false).describe("Wait for a new matching event instead of returning buffered entries"),
      timeout_ms: z.number().int().min(1_000).max(60_000).default(30_000).describe("Interactive wait timeout"),
      capture_action: z.enum(["read", "start", "finish"]).default("read").describe("Use start then finish for a user-coordinated capture window"),
      capture_id: z.string().optional().describe("Capture id returned by capture_action=start; required for finish"),
    }),
    annotations: { readOnlyHint: false },
  }, async ({ page_id, limit, level, text_contains, clear, wait_for_next, timeout_ms, capture_action, capture_id }) => {
    const options = { limit, clear, waitForNext: wait_for_next, timeoutMs: timeout_ms, ...(level ? { level } : {}), ...(text_contains ? { textContains: text_contains } : {}) };
    if (capture_action === "start") return run(() => runtime.beginCapture(page_id, "console"));
    if (capture_action === "finish") return capture_id ? run(() => runtime.finishConsoleCapture(capture_id, options)) : result({ error: "capture_id is required for finish" });
    return run(() => runtime.getConsole(page_id, options));
  });

  server.registerTool("get_network", {
    title: "Get network requests",
    description: "Read requests or coordinate a user action without client forms. For collaboration: call capture_action=start, retain captureId, ask the user to perform the action in chat, then call finish with capture_id and filters.",
    inputSchema: z.object({
      page_id: pageId,
      limit: z.number().int().min(1).max(200).default(DEFAULT_RESULT_LIMIT),
      clear: z.boolean().default(false).describe("Clear captured requests before reading or waiting"),
      url_contains: z.string().optional(),
      method: z.string().optional(),
      resource_type: z.string().optional(),
      status_min: z.number().int().min(0).max(999).optional(),
      status_max: z.number().int().min(0).max(999).optional(),
      wait_for_next: z.boolean().default(false).describe("Wait for a new matching request instead of returning buffered entries"),
      wait_until: z.enum(["request", "response", "finished"]).default("finished").describe("Which request lifecycle phase completes the wait"),
      timeout_ms: z.number().int().min(1_000).max(60_000).default(30_000).describe("Interactive wait timeout"),
      capture_action: z.enum(["read", "start", "finish"]).default("read").describe("Use start then finish for a user-coordinated capture window"),
      capture_id: z.string().optional().describe("Capture id returned by capture_action=start; required for finish"),
    }),
    annotations: { readOnlyHint: false },
  }, async ({ page_id, limit, clear, url_contains, method, resource_type, status_min, status_max, wait_for_next, wait_until, timeout_ms, capture_action, capture_id }) => {
    const options = {
      limit, clear, waitForNext: wait_for_next, waitUntil: wait_until, timeoutMs: timeout_ms,
      ...(url_contains ? { urlContains: url_contains } : {}), ...(method ? { method } : {}),
      ...(resource_type ? { resourceType: resource_type } : {}), ...(status_min === undefined ? {} : { statusMin: status_min }),
      ...(status_max === undefined ? {} : { statusMax: status_max }),
    };
    if (capture_action === "start") return run(() => runtime.beginCapture(page_id, "network"));
    if (capture_action === "finish") return capture_id ? run(() => runtime.finishNetworkCapture(capture_id, options)) : result({ error: "capture_id is required for finish" });
    return run(() => runtime.getNetwork(page_id, options));
  });

  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const runtime = new BrowserRuntime();
  const handle = serveStdio(() => createServer(runtime), { onerror: error => console.error(error.message) });
  const shutdown = async () => { runtime.close(); await handle.close(); };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
