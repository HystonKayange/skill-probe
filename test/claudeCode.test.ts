import test from "node:test";
import assert from "node:assert/strict";
import { parseStream, interpretProbe } from "../src/adapters/claudeCode.ts";

const line = (o: unknown): string => JSON.stringify(o) + "\n";

const initEvent = line({ type: "system", subtype: "init" });
const assistantSkill = (skill: string): string =>
  line({ type: "assistant", message: { content: [{ type: "tool_use", name: "Skill", input: { skill } }] } });
const assistantText = (text: string): string =>
  line({ type: "assistant", message: { content: [{ type: "text", text }] } });
const resultEvent = (cost: number): string =>
  line({ type: "result", subtype: "error_max_turns", total_cost_usd: cost });

test("parseStream: skill fired with real cost", () => {
  const info = parseStream(initEvent + assistantSkill("greeter") + resultEvent(0.05));
  assert.equal(info.skillFired, "greeter");
  assert.equal(info.cost, 0.05);
  assert.equal(info.sawAssistant, true);
});

test("interpretProbe: normal fire is a valid outcome", () => {
  const r = interpretProbe(parseStream(initEvent + assistantSkill("greeter") + resultEvent(0.05)), "");
  assert.equal(r.status, "ok");
  assert.equal(r.skillFired, "greeter");
});

test("interpretProbe: 'no skill fired' WITH real cost is a valid behavioral None", () => {
  const r = interpretProbe(parseStream(initEvent + assistantText("4") + resultEvent(0.03)), "");
  assert.equal(r.status, "ok");
  assert.equal(r.skillFired, null);
});

test("interpretProbe: ZERO-COST response is an infra error, never a behavioral None", () => {
  // regression: observed live 2026-07-02 — a usage-limit window returned assistant text with
  // total_cost_usd=0 and no tool_use; three of these read as "None x3" and faked a suppression
  const r = interpretProbe(parseStream(initEvent + assistantText("You have reached your limit") + resultEvent(0)), "");
  assert.equal(r.status, "error");
  assert.equal(r.skillFired, null);
  assert.match(r.error!, /zero-cost/);
});

test("interpretProbe: missing result event (no cost at all) is also an infra error", () => {
  const r = interpretProbe(parseStream(initEvent + assistantText("partial stream")), "");
  assert.equal(r.status, "error");
  assert.match(r.error!, /zero-cost/);
});

test("interpretProbe: no assistant output is an infra error with stderr context", () => {
  const r = interpretProbe(parseStream(initEvent), "auth expired");
  assert.equal(r.status, "error");
  assert.match(r.error!, /auth expired/);
});
