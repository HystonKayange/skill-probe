import test from "node:test";
import assert from "node:assert/strict";
import { measure } from "../src/orchestrator.ts";
import { runAudit } from "../src/eval.ts";
import { ADAPTERS } from "../src/adapters/index.ts";
import type { ProbeResult, RuntimeAdapter } from "../src/types.ts";

function mockAdapter(name: string, seq: ProbeResult[]): RuntimeAdapter {
  let i = 0;
  return { name, probe: async () => seq[Math.min(i++, seq.length - 1)]! };
}
const ok = (skill: string | null): ProbeResult => ({ status: "ok", skillFired: skill, trajectory: [], cost: 0 });
const err = (msg: string): ProbeResult => ({ status: "error", skillFired: null, trajectory: [], cost: 0, error: msg });

test("infra errors are NOT counted as behavioral outcomes (#1)", async () => {
  const ad = mockAdapter("m", [err("auth"), ok("x"), err("rate"), ok("x"), ok("x")]);
  const s = await measure(ad, "p", "x", { cwd: ".", maxK: 3, threshold: 0.5, conf: 0.95 });
  assert.equal(s.n, 3);              // 3 valid probes only
  assert.ok(s.errors >= 2);          // errors tracked separately
  assert.equal(s.dist["x"], 3);      // None of the errors leaked into the distribution
});

test("a decoy whose probes ALL error does NOT falsely pass (#1)", async () => {
  ADAPTERS["mock-allerr"] = mockAdapter("mock-allerr", [err("unauthenticated")]);
  const a = await runAudit({
    runtime: "mock-allerr", cwd: ".", k: 5, threshold: 0.9, conf: 0.95,
    cases: [{ prompt: "what's the weather?", expected: null }],
  });
  assert.equal(a.cases[0]!.verdict, "error");   // critically NOT "pass"
  assert.equal(a.counts.error, 1);
  assert.equal(a.exitCode, 2);
});

test("a skill that reliably fires passes", async () => {
  ADAPTERS["mock-good"] = mockAdapter("mock-good", [ok("x")]);
  const a = await runAudit({
    runtime: "mock-good", cwd: ".", k: 6, threshold: 0.5, conf: 0.95,
    cases: [{ prompt: "do x", expected: "x" }],
  });
  assert.equal(a.cases[0]!.verdict, "pass");
  assert.equal(a.exitCode, 0);
});

test("small k with all-valid probes is INCONCLUSIVE, not error (review-2 #1)", async () => {
  ADAPTERS["mock-smallk"] = mockAdapter("mock-smallk", [ok("x")]);
  const a = await runAudit({
    runtime: "mock-smallk", cwd: ".", k: 2, threshold: 0.9, conf: 0.95,
    cases: [{ prompt: "do x", expected: "x" }],
  });
  assert.equal(a.cases[0]!.verdict, "inconclusive"); // small k != infra error
});

test("model identity is recorded in the audit (cross-runtime fairness)", async () => {
  ADAPTERS["mock-m"] = mockAdapter("mock-m", [ok("x")]);
  const a = await runAudit({
    runtime: "mock-m", model: "anthropic/claude-haiku-4-5", cwd: ".", k: 4, threshold: 0.5, conf: 0.95,
    cases: [{ prompt: "do x", expected: "x" }],
  });
  assert.equal(a.model, "anthropic/claude-haiku-4-5");
});

test("a skill that never fires is a behavioral FAIL, not an error", async () => {
  ADAPTERS["mock-bad"] = mockAdapter("mock-bad", [ok(null)]);
  const a = await runAudit({
    runtime: "mock-bad", cwd: ".", k: 8, threshold: 0.5, conf: 0.95,
    cases: [{ prompt: "do x", expected: "x" }],
  });
  assert.equal(a.cases[0]!.verdict, "fail");
  assert.equal(a.exitCode, 1);
});
