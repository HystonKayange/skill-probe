import test from "node:test";
import assert from "node:assert/strict";
import { llmBackend } from "../src/llm.ts";

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
