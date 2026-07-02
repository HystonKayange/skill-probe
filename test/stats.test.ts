import test from "node:test";
import assert from "node:assert/strict";
import {
  wilsonInterval, sequentialDecision, fisherExact2x2,
  probImprovement, benjaminiHochberg, bhAdjust,
} from "../src/stats.ts";

const approx = (a: number, b: number, tol = 1e-3) => Math.abs(a - b) < tol;

test("wilson matches textbook values", () => {
  let { lo, hi } = wilsonInterval(7, 10);            // ~ [0.3968, 0.8922]
  assert.ok(approx(lo, 0.3968, 2e-3), `lo=${lo}`);
  assert.ok(approx(hi, 0.8922, 2e-3), `hi=${hi}`);
  ({ lo, hi } = wilsonInterval(0, 10));               // lo=0, hi~0.2775
  assert.equal(lo, 0);
  assert.ok(approx(hi, 0.2775, 2e-3), `hi=${hi}`);
  ({ lo, hi } = wilsonInterval(10, 10));              // hi~1, lo~0.7225
  assert.ok(approx(hi, 1.0, 1e-9) && approx(lo, 0.7225, 2e-3), `lo=${lo} hi=${hi}`);
  assert.deepEqual(wilsonInterval(0, 0), { lo: 0, hi: 1, center: 0.5 });
});

test("sequential decision thresholds", () => {
  assert.equal(sequentialDecision(9, 10, 0.5), "above");
  assert.equal(sequentialDecision(1, 10, 0.5), "below");
  assert.equal(sequentialDecision(5, 10, 0.5), "undecided");
  assert.equal(sequentialDecision(50, 100, 0.5), "undecided");
});

test("fisher exact matches known p-values", () => {
  assert.ok(fisherExact2x2(10, 0, 0, 10) < 1e-4);
  assert.ok(approx(fisherExact2x2(5, 5, 5, 5), 1.0, 1e-9));
  assert.ok(approx(fisherExact2x2(8, 2, 1, 5), 0.03497, 5e-3),
    `p=${fisherExact2x2(8, 2, 1, 5)}`);
});

test("bayesian prob improvement behaves", () => {
  let r = probImprovement(2, 10, 9, 10);
  assert.ok(r.pImprove > 0.95, JSON.stringify(r));
  assert.ok(r.deltaMean > 0.3);
  r = probImprovement(5, 10, 5, 10);
  assert.ok(r.pImprove > 0.4 && r.pImprove < 0.6, JSON.stringify(r));
  assert.ok(r.deltaCi[0] < 0 && r.deltaCi[1] > 0);
});

test("bhAdjust: adjusted p agrees with BH decisions and never shrinks p", () => {
  // m=1: adjustment is the identity
  assert.deepEqual(bhAdjust([0.03]), [0.03]);
  assert.deepEqual(bhAdjust([]), []);
  // textbook: [0.001, 0.6, 0.7, 0.8, 0.9] -> adj[0] = 0.001*5/1 = 0.005
  const adj = bhAdjust([0.001, 0.6, 0.7, 0.8, 0.9]);
  assert.ok(approx(adj[0]!, 0.005, 1e-9), `adj[0]=${adj[0]}`);
  // consistency: adj <= q  ⟺  benjaminiHochberg rejects at q, on a mixed family
  for (const pvals of [
    [0.01, 0.02, 0.03, 0.04, 0.05],
    [0.04, 0.7, 0.8, 0.9, 0.95],
    [0.001, 0.03, 0.04, 0.6, 0.9],
  ]) {
    const rejected = benjaminiHochberg(pvals, 0.05);
    const a = bhAdjust(pvals);
    pvals.forEach((p, i) => {
      assert.equal(a[i]! <= 0.05, rejected[i],
        `mismatch at i=${i}: p=${p} adj=${a[i]} rejected=${rejected[i]}`);
      assert.ok(a[i]! >= p - 1e-12, "adjusted p never below raw p");
      assert.ok(a[i]! <= 1, "adjusted p capped at 1");
    });
  }
});

test("benjamini-hochberg FDR", () => {
  assert.deepEqual(benjaminiHochberg([0.01, 0.02, 0.03, 0.04, 0.05], 0.05),
    [true, true, true, true, true]);
  assert.deepEqual(benjaminiHochberg([0.04, 0.7, 0.8, 0.9, 0.95], 0.05),
    [false, false, false, false, false]);
  const res = benjaminiHochberg([0.001, 0.6, 0.7, 0.8, 0.9], 0.05);
  assert.ok(res[0] === true && res.slice(1).every((x) => !x));
});
