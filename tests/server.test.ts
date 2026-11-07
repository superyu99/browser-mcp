import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { createServer } from "../src/server.js";

test("MCP catalog exposes only the intended eight tools", async () => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer();
  const client = new Client({ name: "browser-test", version: "1.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map(tool => tool.name).sort(), [
    "evaluate", "get_console", "get_network", "get_pages", "inspect_element", "inspect_page", "pick_element", "screenshot",
  ]);
  assert.equal(tools.length, 8);
  assert.ok(tools.every(tool => tool.description));
  const picker = tools.find(tool => tool.name === "pick_element");
  assert.ok(picker?.description?.includes("page-runtime picker"));
  assert.ok(JSON.stringify(picker?.inputSchema).includes("interaction_prompt"));
  assert.ok(!JSON.stringify(tools.find(tool => tool.name === "get_console")?.inputSchema).includes("interaction_prompt"));
  assert.ok(!JSON.stringify(tools.find(tool => tool.name === "get_network")?.inputSchema).includes("interaction_prompt"));
  assert.ok(!tools.some(tool => tool.description?.toLowerCase().includes("elicitation")));
  await client.close();
  await server.close();
});
