import test from "node:test";
import assert from "node:assert/strict";
import { llmBackend, interpretClaudeJson } from "../src/llm.ts";

test("interpretClaudeJson: success returns the result text", () => {
  const r = interpretClaudeJson(0, JSON.stringify({ result: "hello world", is_error: false }), "", false);
  assert.equal(r.text, "hello world");
  assert.equal(r.error, undefined);
});

test("interpretClaudeJson: is_error payload is an ERROR, never text (#fix-safety)", () => {
  const r = interpretClaudeJson(0, JSON.stringify({ result: "rate limited, try later", is_error: true }), "", false);
  assert.equal(r.text, undefined);
  assert.match(r.error!, /claude CLI error/);
  assert.match(r.error!, /rate limited/);
});

test("interpretClaudeJson: non-zero exit is an error", () => {
  const r = interpretClaudeJson(1, "", "auth failed", false);
  assert.equal(r.text, undefined);
  assert.match(r.error!, /exit 1/);
  assert.match(r.error!, /auth failed/);
});

test("interpretClaudeJson: timeout and empty output are errors", () => {
  assert.match(interpretClaudeJson(null, "", "", true).error!, /timed out/);
  assert.match(interpretClaudeJson(0, "   ", "", false).error!, /no text/);
});

test("interpretClaudeJson: tolerates plain-text (non-JSON) success output", () => {
  assert.equal(interpretClaudeJson(0, "just plain text", "", false).text, "just plain text");
});

test("llmBackend: API when ANTHROPIC_API_KEY is set, CLI (subscription) otherwise", () => {
  const orig = process.env["ANTHROPIC_API_KEY"];
  try {
    process.env["ANTHROPIC_API_KEY"] = "sk-test";
    assert.equal(llmBackend(), "api");
    delete process.env["ANTHROPIC_API_KEY"];
    assert.equal(llmBackend(), "cli");
  } finally {
    if (orig === undefined) delete process.env["ANTHROPIC_API_KEY"];
    else process.env["ANTHROPIC_API_KEY"] = orig;
  }
});
