import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildManifest, configHash, toolVersion } from "../src/manifest.ts";
import { saveBaseline, loadBaseline, compareToBaseline, toBaseline } from "../src/baseline.ts";
import type { AuditResult } from "../src/eval.ts";
import type { Config } from "../src/types.ts";

const cfg = (over: Partial<Config> = {}): Config => ({
  runtime: "claude-code", cwd: "/tmp/a", k: 10, threshold: 0.7, conf: 0.95,
  cases: [{ prompt: "say hello", expected: "greeter" }],
  ...over,
});

/** Minimal AuditResult with given per-case counts. */
function auditResult(counts: Array<{ prompt: string; expected: string | null; hits: number; n: number }>, c: Config): AuditResult {
  return {
    runtime: c.runtime, model: c.model ?? "(runtime default)", threshold: c.threshold,
    cases: counts.map((x) => ({
      prompt: x.prompt, expected: x.expected,
      stats: { hits: x.hits, n: x.n, errors: 0, dist: {}, totalCost: 0 },
      reliability: { pHat: x.n ? x.hits / x.n : 0, ciLow: 0, ciHigh: 1, k: x.n, conf: c.conf },
      theft: [], decision: "undecided", verdict: "inconclusive",
    })),
    totalCost: 0, counts: { pass: 0, fail: 0, inconclusive: counts.length, error: 0 },
    exitCode: 0, manifest: buildManifest("audit", c),
  };
}

test("configHash: stable across cwd, sensitive to cases and settings", () => {
  const a = configHash(cfg({ cwd: "/laptop/checkout" }));
  const b = configHash(cfg({ cwd: "/ci/runner/checkout" }));
  assert.equal(a, b, "cwd must NOT change the hash — same experiment, different path");
  assert.notEqual(a, configHash(cfg({ k: 20 })));
  assert.notEqual(a, configHash(cfg({ cases: [{ prompt: "say hi", expected: "greeter" }] })));
});

test("manifest carries tool version, command, and settings", () => {
  const m = buildManifest("audit", cfg());
  assert.equal(m.tool, "skill-probe");
  assert.equal(m.command, "audit");
  assert.equal(m.k, 10);
  assert.match(m.date, /^\d{4}-\d{2}-\d{2}T/);
  assert.notEqual(toolVersion(), "unknown");
});

test("baseline round-trips through save/load", () => {
  const dir = mkdtempSync(join(tmpdir(), "skill-probe-baseline-"));
  const path = join(dir, "baseline.json");
  const r = auditResult([{ prompt: "say hello", expected: "greeter", hits: 9, n: 10 }], cfg());
  saveBaseline(r, path);
  const loaded = loadBaseline(path);
  assert.deepEqual(loaded, toBaseline(r));
});

test("loadBaseline rejects junk with a helpful error", () => {
  const dir = mkdtempSync(join(tmpdir(), "skill-probe-baseline-"));
  const path = join(dir, "junk.json");
  assert.throws(() => loadBaseline(path), /cannot read/);
  writeFileSync(path, "{not json");
  assert.throws(() => loadBaseline(path), /not valid JSON/);
  writeFileSync(path, JSON.stringify({ hello: 1 }));
  assert.throws(() => loadBaseline(path), /--save-baseline/);
});

test("significant drop regresses; noise does not", () => {
  const c = cfg({
    cases: [
      { prompt: "collapsed", expected: "greeter" },
      { prompt: "wobbled", expected: "welcomer" },
    ],
  });
  const base = toBaseline(auditResult([
    { prompt: "collapsed", expected: "greeter", hits: 10, n: 10 },
    { prompt: "wobbled", expected: "welcomer", hits: 9, n: 10 },
  ], c));
  const current = auditResult([
    { prompt: "collapsed", expected: "greeter", hits: 1, n: 10 },  // 100% -> 10%: real
    { prompt: "wobbled", expected: "welcomer", hits: 8, n: 10 },   // 90% -> 80%: noise
  ], c);
  const cmp = compareToBaseline(current, base);
  const collapsed = cmp.cases.find((r) => r.prompt === "collapsed")!;
  const wobbled = cmp.cases.find((r) => r.prompt === "wobbled")!;
  assert.equal(collapsed.regressed, true);
  assert.ok(collapsed.fisherPAdj < 0.05);
  assert.ok(collapsed.fisherPAdj >= collapsed.fisherP - 1e-12, "family is BH-corrected");
  assert.equal(wobbled.regressed, false, "a 1-hit wobble must not fail CI");
  assert.equal(cmp.regressions, 1);
  assert.equal(cmp.exitCode, 1);
  assert.equal(cmp.mismatches.length, 0, "same config: no mismatch warnings");
});

test("significant improvement is informational, not a failure", () => {
  const c = cfg();
  const base = toBaseline(auditResult([{ prompt: "say hello", expected: "greeter", hits: 1, n: 10 }], c));
  const cmp = compareToBaseline(
    auditResult([{ prompt: "say hello", expected: "greeter", hits: 10, n: 10 }], c), base);
  assert.equal(cmp.cases[0]!.improved, true);
  assert.equal(cmp.cases[0]!.regressed, false);
  assert.equal(cmp.exitCode, 0);
});

test("config drift warns; new and missing cases are reported, not gated", () => {
  const cBase = cfg({ cases: [
    { prompt: "kept", expected: "greeter" },
    { prompt: "removed later", expected: "greeter" },
  ] });
  const base = toBaseline(auditResult([
    { prompt: "kept", expected: "greeter", hits: 9, n: 10 },
    { prompt: "removed later", expected: "greeter", hits: 9, n: 10 },
  ], cBase));
  const cNew = cfg({ cases: [
    { prompt: "kept", expected: "greeter" },
    { prompt: "brand new", expected: "greeter" },
  ] });
  const cmp = compareToBaseline(auditResult([
    { prompt: "kept", expected: "greeter", hits: 9, n: 10 },
    { prompt: "brand new", expected: "greeter", hits: 2, n: 10 },
  ], cNew), base);
  assert.ok(cmp.mismatches.some((m) => m.includes("config changed")));
  assert.deepEqual(cmp.newCases, ["brand new"]);
  assert.deepEqual(cmp.missingCases, ["removed later"]);
  assert.equal(cmp.cases.length, 1, "only the matched case is gated");
  assert.equal(cmp.exitCode, 0, "a low-rate NEW case is the audit's job, not the gate's");
});

test("a side with no valid probes is NOT comparable — never a silent no-regression", () => {
  const c = cfg();
  const base = toBaseline(auditResult([{ prompt: "say hello", expected: "greeter", hits: 8, n: 10 }], c));
  const cmp = compareToBaseline(
    auditResult([{ prompt: "say hello", expected: "greeter", hits: 0, n: 0 }], c), base);
  assert.equal(cmp.cases[0]!.untrustworthy, true);
  assert.equal(cmp.cases[0]!.regressed, false);
});
