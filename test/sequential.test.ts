import test from "node:test";
import assert from "node:assert/strict";
import { sequentialPlan, planDecision, kToCertify, wilsonInterval, type Decision } from "../src/stats.ts";
import { measure } from "../src/orchestrator.ts";
import type { RuntimeAdapter } from "../src/types.ts";

/** Exact P(verdict = above) and P(verdict = below) when probes succeed with probability p and the
 * run stops at the first decided look — enumerated over every path, using ONLY the public decision
 * function (independent of the plan builder's own bookkeeping). */
function exactErrorRates(decide: (x: number, n: number) => Decision, k: number, p: number) {
  let dist = [1];
  let above = 0, below = 0;
  for (let n = 1; n <= k; n++) {
    const next = new Array<number>(n + 1).fill(0);
    for (let x = 0; x < n; x++) { next[x]! += dist[x]! * (1 - p); next[x + 1]! += dist[x]! * p; }
    for (let x = 0; x <= n; x++) {
      const d = decide(x, n);
      if (d === "above") { above += next[x]!; next[x] = 0; }
      else if (d === "below") { below += next[x]!; next[x] = 0; }
    }
    dist = next;
  }
  return { above, below };
}

const KS = [1, 2, 3, 5, 10, 20, 35, 60];
const THETAS = [0.3, 0.5, 0.7, 0.9, 0.95];
const CONFS = [0.9, 0.95, 0.99];

test("verdict error is bounded by 1-conf in each direction, however early the run stops", () => {
  for (const k of KS) for (const theta of THETAS) for (const conf of CONFS) {
    const plan = sequentialPlan(k, theta, conf);
    const alpha = 1 - conf;
    const decide = (x: number, n: number) => planDecision(plan, x, n);
    const tag = `k=${k} θ=${theta} conf=${conf}`;
    // worst case is p == threshold (boundaries are monotone)
    const at = exactErrorRates(decide, k, theta);
    assert.ok(at.above <= alpha + 1e-12, `${tag}: P(pass | p=θ)=${at.above}`);
    assert.ok(at.below <= alpha + 1e-12, `${tag}: P(fail | p=θ)=${at.below}`);
    // and the builder's own accounting agrees with independent enumeration
    assert.ok(Math.abs(at.above - plan.errAbove) < 1e-9, `${tag}: errAbove bookkeeping`);
    assert.ok(Math.abs(at.below - plan.errBelow) < 1e-9, `${tag}: errBelow bookkeeping`);
    // monotonicity: strictly-wrong-side truths are even less likely to get the wrong verdict
    for (const d of [0.05, 0.15]) {
      if (theta - d > 0) assert.ok(exactErrorRates(decide, k, theta - d).above <= at.above + 1e-12, `${tag}: monotone above`);
      if (theta + d < 1) assert.ok(exactErrorRates(decide, k, theta + d).below <= at.below + 1e-12, `${tag}: monotone below`);
    }
  }
});

test("the old Wilson-peeking rule broke this bound (the check above would have caught it)", () => {
  // stop at the first n >= 3 whose 95% Wilson CI clears the threshold — the pre-fix behavior
  const oldRule = (x: number, n: number): Decision => {
    if (n < 3) return "undecided";
    const { lo, hi } = wilsonInterval(x, n, 0.95);
    return lo > 0.7 ? "above" : hi < 0.7 ? "below" : "undecided";
  };
  const { above, below } = exactErrorRates(oldRule, 35, 0.7);
  // nominal 2.5% per side; the real rates are several times that
  assert.ok(above > 0.05, `old false-pass rate ${above}`);
  assert.ok(below > 0.1, `old false-fail rate ${below}`);
});

test("smoke defaults still work: a clean 10/10 certifies 70%", () => {
  const plan = sequentialPlan(10, 0.7, 0.95);
  assert.equal(planDecision(plan, 10, 10), "above");
  assert.equal(planDecision(plan, 9, 10), "undecided");
  assert.equal(kToCertify(0.7, 0.95), 9);
  // certifying a strict bar needs more runs — and the helper says exactly how many
  const k90 = kToCertify(0.9, 0.95);
  assert.equal(planDecision(sequentialPlan(k90, 0.9, 0.95), k90, k90), "above");
  assert.equal(planDecision(sequentialPlan(k90 - 1, 0.9, 0.95), k90 - 1, k90 - 1), "undecided");
});

test("clear-cut failures stop early instead of burning all k probes", async () => {
  let calls = 0;
  const never: RuntimeAdapter = { name: "never", probe: async () => { calls++; return { status: "ok", skillFired: null, trajectory: [], cost: 0 }; } };
  const s = await measure(never, "p", "x", { cwd: ".", maxK: 35, threshold: 0.7, conf: 0.95 });
  assert.ok(s.n < 10, `stopped after ${s.n} probes`);
  assert.equal(calls, s.n);
  assert.equal(planDecision(sequentialPlan(35, 0.7, 0.95), s.hits, s.n), "below");
});

test("measure() honours the plan: Monte Carlo false-pass rate at p = threshold stays within bound", async () => {
  // seeded LCG so the test is deterministic
  let seed = 42;
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const adapter: RuntimeAdapter = {
    name: "bernoulli",
    probe: async () => ({ status: "ok", skillFired: rand() < 0.7 ? "x" : null, trajectory: [], cost: 0 }),
  };
  const plan = sequentialPlan(20, 0.7, 0.95);
  const N = 3000;
  let passes = 0, fails = 0;
  for (let i = 0; i < N; i++) {
    const s = await measure(adapter, "p", "x", { cwd: ".", maxK: 20, threshold: 0.7, conf: 0.95 });
    const d = planDecision(plan, s.hits, s.n);
    if (d === "above") passes++;
    if (d === "below") fails++;
  }
  const sd = Math.sqrt(0.05 * 0.95 / N);
  assert.ok(passes / N <= 0.05 + 4 * sd, `false-pass rate ${passes / N}`);
  assert.ok(fails / N <= 0.05 + 4 * sd, `false-fail rate ${fails / N}`);
});

test("plans are cheap enough for large k", () => {
  const t0 = performance.now();
  sequentialPlan(400, 0.93, 0.99);
  assert.ok(performance.now() - t0 < 2000);
});
