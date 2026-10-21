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

test("REAL captured stream (Claude Code 2.1.305): skill, cost and loaded-skill env all parse", async () => {
  const { readFileSync } = await import("node:fs");
  const raw = readFileSync(new URL("./fixtures/claude-code-2.1.305-skill-fired.jsonl", import.meta.url), "utf8");
  const r = interpretProbe(parseStream(raw), "");
  assert.equal(r.status, "ok");
  assert.equal(r.skillFired, "commit-writer");
  assert.ok(r.cost > 0);
  assert.equal(r.env?.runtimeVersion, "2.1.305");
  assert.equal(r.env?.model, "claude-opus-5-5");
  assert.ok(r.env?.loadedSkills?.includes("commit-writer"));
  assert.ok(r.env?.loadedSkills?.includes("pr-describer"));
  // hermetic run: no user plugins (namespaced "plugin:skill") made it in
  assert.ok(!r.env?.loadedSkills?.some((s) => s.includes(":")), r.env?.loadedSkills?.join(","));
});

test("buildArgs: hermetic + no session transcripts by default; --user-config opts back in", async () => {
  const { buildArgs } = await import("../src/adapters/claudeCode.ts");
  const a = buildArgs("hi", {});
  assert.deepEqual(a.slice(0, 2), ["-p", "hi"]);
  for (const f of ["--no-session-persistence", "--strict-mcp-config"]) assert.ok(a.includes(f), f);
  assert.equal(a[a.indexOf("--setting-sources") + 1], "project");
  assert.equal(a[a.indexOf("--max-turns") + 1], "1");
  const u = buildArgs("hi", { userConfig: true, maxTurns: 3, model: "m" });
  assert.ok(!u.includes("--setting-sources") && !u.includes("--strict-mcp-config"));
  assert.ok(u.includes("--no-session-persistence"), "never write session files");
  assert.equal(u[u.indexOf("--max-turns") + 1], "3");
  assert.equal(u[u.indexOf("--model") + 1], "m");
});

test("interpretProbe: an unsupported-flag failure tells the user to upgrade Claude Code", () => {
  const r = interpretProbe(parseStream(""), "error: unknown option '--setting-sources'");
  assert.equal(r.status, "error");
  assert.match(r.error!, /upgrade/);
});
