import assert from "node:assert/strict";
import test from "node:test";
import { inspectElementScript, inspectPageScript, pickElementScript } from "../src/page-scripts.js";
import { clip, pickHeaders } from "../src/utils.js";

test("selector interpolation is JSON-safe", () => {
  const selector = `img[data-name="x']; throw new Error('bad")`;
  const script = inspectElementScript(selector, 8000);
  assert.ok(script.includes(JSON.stringify(selector)));
});

test("page and picker scripts keep explicit bounds and cancellation", () => {
  assert.match(inspectPageScript(4, 123, false), /maxDepth = 4, maxNodes = 123/);
  assert.match(pickElementScript(), /Escape/);
  assert.match(pickElementScript(), /stopImmediatePropagation/);
  assert.match(pickElementScript("Click the requested logo"), /Click the requested logo/);
});

test("output clipping and header allowlist are bounded", () => {
  assert.match(clip("abcdefgh", 4), /^abcd/);
  assert.deepEqual(pickHeaders({ Authorization: "secret", "Content-Type": "text/html", ETag: "x" }), { "Content-Type": "text/html", ETag: "x" });
});
