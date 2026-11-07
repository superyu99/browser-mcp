import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

test("built stdio entrypoint starts and completes an MCP handshake", async () => {
  const transport = new StdioClientTransport({ command: process.execPath, args: [resolve("dist/server.js")], stderr: "pipe" });
  const client = new Client({ name: "entrypoint-test", version: "1.0.0" });
  await client.connect(transport);
  const { tools } = await client.listTools();
  assert.equal(tools.length, 8);
  await client.close();
});
