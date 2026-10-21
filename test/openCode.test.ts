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

test("REAL captured error event (opencode 1.17.9) is an infra error — never a behavioral None", async () => {
  // regression: this single {"type":"error"} event used to parse as a valid run where no skill
  // fired, so a decoy case PASSED while the runtime was completely broken
  const { readFileSync } = await import("node:fs");
  const { interpretOpenCode } = await import("../src/adapters/openCode.ts");
  const raw = readFileSync(new URL("./fixtures/opencode-1.17.9-error.jsonl", import.meta.url), "utf8");
  const r = interpretOpenCode(raw, "");
  assert.equal(r.status, "error");
  assert.match(r.error!, /1\.18\.0 or newer is required/);
});

test("output without any model step is an infra error", async () => {
  const { interpretOpenCode } = await import("../src/adapters/openCode.ts");
  const r = interpretOpenCode(JSON.stringify({ type: "session.created", id: "x" }) + "\n", "");
  assert.equal(r.status, "error");
  assert.match(r.error!, /did not actually run/);
});

test("a real step with no skill is a valid behavioral None", async () => {
  const { interpretOpenCode } = await import("../src/adapters/openCode.ts");
  const events = [
    { type: "step_start", part: { type: "step-start" } },
    { type: "text", part: { type: "text", text: "Paris" } },
    { type: "step_finish", part: { type: "step-finish", cost: 0.001 } },
  ].map((e) => JSON.stringify(e)).join("\n");
  const r = interpretOpenCode(events, "");
  assert.equal(r.status, "ok");
  assert.equal(r.skillFired, null);
});

test("a failed tool part (state.status error) is NOT mistaken for a run error", async () => {
  const { interpretOpenCode } = await import("../src/adapters/openCode.ts");
  const events = [
    { type: "step_start", part: { type: "step-start" } },
    { type: "tool_use", part: { type: "tool", tool: "skill", state: { status: "error", input: { name: "x" } } } },
  ].map((e) => JSON.stringify(e)).join("\n");
  const r = interpretOpenCode(events, "");
  assert.equal(r.status, "ok");
  assert.equal(r.skillFired, "x");
});
