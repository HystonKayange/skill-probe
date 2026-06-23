import test from "node:test";
import assert from "node:assert/strict";
import { extractFromOpenCode } from "../src/adapters/openCode.ts";

test("extracts fired skill from documented tool-part shape", () => {
  // message.part.updated -> part.type=="tool", tool=="skill", state.input.name
  const events = [
    { type: "message", properties: { info: { role: "assistant" } } },
    {
      type: "message.part.updated",
      properties: {
        part: { type: "tool", tool: "skill", state: { input: { name: "commit-writer" } } },
      },
    },
    { type: "result", cost: 0.0031 },
  ];
  const r = extractFromOpenCode(events);
  assert.equal(r.skillFired, "commit-writer");
  assert.ok(r.trajectory.includes("skill"));
  assert.equal(r.cost, 0.0031);
});

test("handles alternate input.skill subfield", () => {
  const r = extractFromOpenCode({
    part: { type: "tool", tool: "skill", state: { input: { skill: "pr-describer" } } },
  });
  assert.equal(r.skillFired, "pr-describer");
});

test("extracts from REAL `opencode run --format json` shape (captured live)", () => {
  // exact shape captured from opencode v1.17.9: top-level type "tool_use", nested part
  const events = [
    { type: "step_start", part: { type: "step-start" } },
    {
      type: "tool_use",
      part: {
        type: "tool", tool: "skill", callID: "toolu_x",
        state: { status: "completed", input: { name: "commit-writer" },
                 metadata: { name: "commit-writer" } },
      },
    },
    { type: "step_finish", part: { type: "step-finish" } },
  ];
  const r = extractFromOpenCode(events);
  assert.equal(r.skillFired, "commit-writer");
  assert.ok(r.trajectory.includes("skill"));
});

test("no skill fired -> null", () => {
  const r = extractFromOpenCode([
    { part: { type: "tool", tool: "read", state: { input: { path: "x" } } } },
  ]);
  assert.equal(r.skillFired, null);
  assert.deepEqual(r.trajectory, ["read"]);
});
