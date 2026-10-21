import test from "node:test";
import assert from "node:assert/strict";
import { measure } from "../src/orchestrator.ts";
import { runAudit } from "../src/eval.ts";
import { ADAPTERS } from "../src/adapters/index.ts";
import type { ProbeResult, RuntimeAdapter } from "../src/types.ts";
import { tempDir } from "./helpers.ts";

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

const okEnv = (skill: string | null, loaded: string[]): ProbeResult =>
  ({ ...ok(skill), env: { loadedSkills: loaded, runtimeVersion: "9.9.9", model: "resolved-model" } });

test("one stray sibling firing is a WARNING by default, not a fail (regression: flaky CI)", async () => {
  // 19 hits + 1 theft at k=20: reliability clears 70% decisively. The old any-theft rule failed
  // a 95%-reliable skill ~38% of the time at k=10.
  ADAPTERS["mock-stray"] = mockAdapter("mock-stray", [...Array(10).fill(ok("x")), ok("y"), ...Array(9).fill(ok("x"))]);
  const a = await runAudit({
    runtime: "mock-stray", cwd: ".", k: 20, threshold: 0.7, conf: 0.95,
    cases: [{ prompt: "do x", expected: "x" }],
  });
  assert.deepEqual(a.cases[0]!.theft, ["y"]);
  assert.equal(a.cases[0]!.verdict, "pass");
  assert.equal(a.exitCode, 0);
  const { renderTable } = await import("../src/report.ts");
  assert.match(renderTable(a), /trigger-theft by: y 1\/20.*--fail-on-theft/);
});

test("failOnTheft restores zero tolerance", async () => {
  ADAPTERS["mock-stray2"] = mockAdapter("mock-stray2", [...Array(10).fill(ok("x")), ok("y"), ...Array(9).fill(ok("x"))]);
  const a = await runAudit({
    runtime: "mock-stray2", cwd: ".", k: 20, threshold: 0.7, conf: 0.95, failOnTheft: true,
    cases: [{ prompt: "do x", expected: "x" }],
  });
  assert.equal(a.cases[0]!.verdict, "fail");
  assert.equal(a.exitCode, 1);
});

test("the runtime's own report of what it loaded lands in the manifest", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = tempDir("skp-eval-");
  for (const s of ["x", "y"]) {
    mkdirSync(join(root, ".claude", "skills", s), { recursive: true });
    writeFileSync(join(root, ".claude", "skills", s, "SKILL.md"), `---\nname: ${s}\ndescription: ${s}\n---\n`);
  }
  ADAPTERS["mock-env"] = { ...mockAdapter("mock-env", [okEnv("x", ["x", "y", "debug", "verify"])]), isolatesUserConfig: true };
  const a = await runAudit({
    runtime: "mock-env", cwd: root, k: 10, threshold: 0.7, conf: 0.95,
    cases: [{ prompt: "do x", expected: "x" }],
  });
  assert.deepEqual(a.manifest.environment, {
    runtimeVersion: "9.9.9", resolvedModel: "resolved-model", extraSkills: ["debug", "verify"],
    userConfig: false, hermetic: true, maxTurns: 1,
  });
  // and a skill the runtime never loaded is called out — it can never fire
  ADAPTERS["mock-unloaded"] = mockAdapter("mock-unloaded", [okEnv(null, ["x", "debug"])]);
  const b = await runAudit({
    runtime: "mock-unloaded", cwd: root, k: 10, threshold: 0.7, conf: 0.95,
    cases: [{ prompt: "do y", expected: "y" }],
  });
  assert.equal(b.cases[0]!.notLoaded, true);
  assert.match(b.warnings.join("\n"), /did not load: y/);
});

test("--max-cost: an exhausted budget stops probing and never reads as a pass", async () => {
  const { Budget } = await import("../src/orchestrator.ts");
  let calls = 0;
  ADAPTERS["mock-cost"] = { name: "mock-cost", probe: async () => { calls++; return { ...ok(null), cost: 0.5 }; } };
  const a = await runAudit({
    runtime: "mock-cost", cwd: ".", k: 10, threshold: 0.7, conf: 0.95,
    cases: [{ prompt: "decoy", expected: null }, { prompt: "decoy 2", expected: null }],
  }, { budget: new Budget(1) });
  assert.equal(calls, 2, "stopped once $1 was spent");
  assert.ok(a.cases.every((c) => c.verdict !== "pass"));
  assert.equal(a.cases[1]!.verdict, "error");
  assert.match(a.cases[1]!.stats.lastError!, /max-cost/);
  assert.equal(a.exitCode, 2);
});

test("concurrency runs cases in parallel and preserves case order", async () => {
  let inFlight = 0, peak = 0;
  ADAPTERS["mock-par"] = {
    name: "mock-par",
    probe: async (prompt) => {
      inFlight++; peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 2));
      inFlight--;
      return ok(prompt === "none" ? null : prompt);
    },
  };
  const cases = ["a", "b", "none", "c"].map((p) => ({ prompt: p, expected: p === "none" ? null : p }));
  const a = await runAudit({ runtime: "mock-par", cwd: ".", k: 10, threshold: 0.7, conf: 0.95, cases }, { concurrency: 3 });
  assert.deepEqual(a.cases.map((c) => c.prompt), ["a", "b", "none", "c"]);
  assert.ok(a.cases.every((c) => c.verdict === "pass"));
  assert.equal(peak, 3);
});

test("a runtime that can't isolate personal config is never reported as hermetic", async () => {
  const { renderTable } = await import("../src/report.ts");
  ADAPTERS["mock-noiso"] = mockAdapter("mock-noiso", [ok("x")]); // like opencode: no isolation, no turn limit
  const a = await runAudit({
    runtime: "mock-noiso", cwd: ".", k: 10, threshold: 0.7, conf: 0.95, maxTurns: 3,
    cases: [{ prompt: "do x", expected: "x" }],
  });
  assert.equal(a.manifest.environment?.hermetic, false);
  const text = renderTable(a);
  assert.doesNotMatch(text, /hermetic \(/);
  assert.match(text, /NOT isolated/);
  assert.match(text, /can't exclude your personal\/global config/);
  assert.match(text, /maxTurns \(3\) is ignored/);
});
