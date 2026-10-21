/**
 * Statistical core (TS port of the validated Python reference implementation from the research
 * phase). Skill activation is Bernoulli with unknown p; we estimate from k runs and never report a
 * bare point. The README's "How verdicts are decided" section explains the sequential verdicts.
 */

const Z: Record<string, number> = {
  "0.9": 1.6448536269514722,
  "0.95": 1.959963984540054,
  "0.99": 2.5758293035489004,
};

export interface Interval { lo: number; hi: number; center: number; }
export type Decision = "above" | "below" | "undecided";

/** Wilson score interval — well-behaved at p≈0/1 and small n (unlike Wald). */
export function wilsonInterval(x: number, n: number, conf = 0.95): Interval {
  if (n === 0) return { lo: 0, hi: 1, center: 0.5 };
  const z = Z[String(conf)];
  if (z === undefined) {
    throw new Error(`unsupported confidence ${conf}; use 0.9, 0.95, or 0.99`);
  }
  const p = x / n;
  const denom = 1 + (z * z) / n;
  const center = (p + (z * z) / (2 * n)) / denom;
  const half = (z / denom) * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return { lo: Math.max(0, center - half), hi: Math.min(1, center + half), center };
}

export interface Reliability {
  pHat: number; ciLow: number; ciHigh: number; k: number; conf: number;
}
export function reliability(x: number, n: number, conf = 0.95): Reliability {
  const { lo, hi } = wilsonInterval(x, n, conf);
  return { pHat: n ? x / n : 0, ciLow: lo, ciHigh: hi, k: n, conf };
}

// --- exact group-sequential verdicts ---
// Checking a CI after every probe and stopping as soon as it clears the threshold ("peeking")
// inflates the error rate far past the nominal level: measured on the old Wilson rule at k=35, a
// skill sitting exactly at the threshold was wrongly passed 9% and wrongly failed 18% of the time
// at a nominal 2.5% per side. A verdict here comes from a plan whose boundaries are calibrated by
// exact dynamic programming over every probe path, so the guarantee holds no matter when it stops:
//
//   P(verdict "above" | true reliability <= threshold) <= 1 - conf
//   P(verdict "below" | true reliability >= threshold) <= 1 - conf
//
// (one-sided per direction; the worst case is p == threshold because the boundaries are monotone).
// Design is Haybittle-Peto style: interim looks use a strict nominal level so only clear-cut cases
// stop early, and the final look spends whatever error budget is left.

/** interim looks never decide on fewer valid probes than this */
const MIN_LOOK = 3;

export interface SequentialPlan {
  k: number;
  threshold: number;
  /** per-direction error bound (1 - conf) */
  alpha: number;
  /** nominal one-sided level used at interim looks */
  interimAlpha: number;
  /** declare "above" at n valid probes when hits >= upper[n] (n+1 = can't) */
  upper: number[];
  /** declare "below" at n valid probes when hits <= lower[n] (-1 = can't) */
  lower: number[];
  /** exact P(declare above | p = threshold) and P(declare below | p = threshold); both <= alpha */
  errAbove: number;
  errBelow: number;
}

function binomPmfRow(n: number, p: number): number[] {
  const row = new Array<number>(n + 1).fill(0);
  if (p <= 0) { row[0] = 1; return row; }
  if (p >= 1) { row[n] = 1; return row; }
  const lp = Math.log(p), lq = Math.log(1 - p), ln = lgamma(n + 1);
  for (let x = 0; x <= n; x++) {
    row[x] = Math.exp(ln - lgamma(x + 1) - lgamma(n - x + 1) + x * lp + (n - x) * lq);
  }
  return row;
}

function buildPlan(k: number, theta: number, alpha: number, interim: number): SequentialPlan | null {
  const upper = Array.from({ length: k + 1 }, (_, n) => n + 1);
  const lower = new Array<number>(k + 1).fill(-1);
  if (interim > 0) {
    for (let n = MIN_LOOK; n < k; n++) {
      const pmf = binomPmfRow(n, theta);
      let acc = 0;
      for (let x = n; x >= 0 && acc + pmf[x]! <= interim; x--) { acc += pmf[x]!; upper[n] = x; }
      acc = 0;
      for (let x = 0; x <= n && acc + pmf[x]! <= interim; x++) { acc += pmf[x]!; lower[n] = x; }
    }
  }
  // dist[x] = P(X_n = x AND no boundary crossed yet | p = theta)
  let dist = [1];
  let errAbove = 0, errBelow = 0;
  for (let n = 1; n <= k; n++) {
    const next = new Array<number>(n + 1).fill(0);
    for (let x = 0; x < n; x++) {
      next[x]! += dist[x]! * (1 - theta);
      next[x + 1]! += dist[x]! * theta;
    }
    if (n < k) {
      for (let x = 0; x <= n; x++) {
        if (x >= upper[n]!) { errAbove += next[x]!; next[x] = 0; }
        else if (x <= lower[n]!) { errBelow += next[x]!; next[x] = 0; }
      }
    }
    dist = next;
  }
  // interim looks may use at most half the budget; the final look must keep real power
  if (interim > 0 && (errAbove > alpha / 2 || errBelow > alpha / 2)) return null;
  const tol = alpha * 1e-12;
  for (let x = k; x >= 0 && errAbove + dist[x]! <= alpha + tol; x--) { errAbove += dist[x]!; upper[k] = x; }
  for (let x = 0; x < upper[k]! && errBelow + dist[x]! <= alpha + tol; x++) { errBelow += dist[x]!; lower[k] = x; }
  return { k, threshold: theta, alpha, interimAlpha: interim, upper, lower, errAbove, errBelow };
}

const planCache = new Map<string, SequentialPlan>();

/** The verdict plan for up to k valid probes against `threshold` at confidence `conf`. Memoized. */
export function sequentialPlan(k: number, threshold: number, conf = 0.95): SequentialPlan {
  if (!Number.isInteger(k) || k < 1) throw new Error(`k must be a positive integer (got ${k})`);
  if (!(threshold > 0 && threshold < 1)) throw new Error(`threshold must be in (0,1) (got ${threshold})`);
  if (!(conf > 0.5 && conf < 1)) throw new Error(`conf must be in (0.5,1) (got ${conf})`);
  const key = `${k}|${threshold}|${conf}`;
  const hit = planCache.get(key);
  if (hit) return hit;
  const alpha = 1 - conf;
  let plan: SequentialPlan | null = null;
  for (let interim = alpha / 10; !plan && interim > 1e-9; interim /= 2) {
    plan = buildPlan(k, threshold, alpha, interim);
  }
  plan ??= buildPlan(k, threshold, alpha, 0)!; // no early stopping at all
  planCache.set(key, plan);
  return plan;
}

/** Verdict after n valid probes with x hits. Valid at ANY n <= k: stopping early (decided) or
 * because infra errors exhausted the attempt budget both keep the error guarantee. */
export function planDecision(plan: SequentialPlan, x: number, n: number): Decision {
  if (n < 1) return "undecided";
  const i = Math.min(n, plan.k);
  if (x >= plan.upper[i]!) return "above";
  if (x <= plan.lower[i]!) return "below";
  return "undecided";
}

/** Convenience: the verdict for x/n under the plan for max k (defaults to k = n, a fixed-n test). */
export function sequentialDecision(
  x: number, n: number, threshold: number, conf = 0.95, k = n,
): Decision {
  return planDecision(sequentialPlan(Math.max(k, 1), threshold, conf), x, n);
}

/** Smallest k at which an all-success run can certify reliability > threshold. */
export function kToCertify(threshold: number, conf = 0.95): number {
  const est = Math.ceil(Math.log(1 - conf) / Math.log(threshold));
  for (let k = Math.max(1, est - 3); k <= Math.max(est + 50, 10); k++) {
    if (sequentialPlan(k, threshold, conf).upper[k]! <= k) return k;
  }
  return est;
}

// --- lgamma (Lanczos) ---
const LANCZOS = [
  0.99999999999980993, 676.5203681218851, -1259.1392167224028,
  771.32342877765313, -176.61502916214059, 12.507343278686905,
  -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
];
function lgamma(z: number): number {
  if (z < 0.5) {
    return Math.log(Math.PI / Math.sin(Math.PI * z)) - lgamma(1 - z);
  }
  z -= 1;
  let a = LANCZOS[0]!;
  const t = z + 7.5;
  for (let i = 1; i < 9; i++) a += LANCZOS[i]! / (z + i);
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(a);
}

function hypergeomLogP(a: number, r1: number, c1: number, n: number): number {
  const b = r1 - a, c = c1 - a, d = n - r1 - c1 + a;
  if (Math.min(a, b, c, d) < 0) return -Infinity;
  return (
    lgamma(r1 + 1) - lgamma(a + 1) - lgamma(b + 1) +
    lgamma(n - r1 + 1) - lgamma(c + 1) - lgamma(d + 1) -
    (lgamma(n + 1) - lgamma(c1 + 1) - lgamma(n - c1 + 1))
  );
}

/** Two-sided Fisher's exact test on [[a,b],[c,d]] — exact, for small samples. */
export function fisherExact2x2(a: number, b: number, c: number, d: number): number {
  const n = a + b + c + d, r1 = a + b, c1 = a + c;
  const pObs = Math.exp(hypergeomLogP(a, r1, c1, n));
  const aMin = Math.max(0, c1 - (n - r1)), aMax = Math.min(r1, c1);
  let total = 0;
  for (let ai = aMin; ai <= aMax; ai++) {
    const pa = Math.exp(hypergeomLogP(ai, r1, c1, n));
    if (pa <= pObs * (1 + 1e-9)) total += pa;
  }
  return Math.min(1, total);
}

// --- seeded RNG + Beta sampling for the Bayesian before/after ---
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function gaussian(rng: () => number): number {
  let u = 0, v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
function gammaSample(k: number, rng: () => number): number {
  if (k < 1) return gammaSample(1 + k, rng) * Math.pow(rng(), 1 / k);
  const d = k - 1 / 3, c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x: number, v: number;
    do { x = gaussian(rng); v = 1 + c * x; } while (v <= 0);
    v = v * v * v;
    const u = rng();
    if (u < 1 - 0.0331 * x * x * x * x) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}
function betaSample(a: number, b: number, rng: () => number): number {
  const ga = gammaSample(a, rng), gb = gammaSample(b, rng);
  return ga / (ga + gb);
}

export interface ImprovementResult {
  pImprove: number; deltaMean: number; deltaCi: [number, number];
}
/** Bayesian Beta-Binomial: P(p_after > p_before) + delta credible interval. */
export function probImprovement(
  xBefore: number, nBefore: number, xAfter: number, nAfter: number,
  prior = 0.5, samples = 40000, seed = 12345,
): ImprovementResult {
  const rng = mulberry32(seed);
  const ab = prior + xBefore, bb = prior + (nBefore - xBefore);
  const aa = prior + xAfter, ba = prior + (nAfter - xAfter);
  let wins = 0, sum = 0;
  const deltas = new Array<number>(samples);
  for (let i = 0; i < samples; i++) {
    const pa = betaSample(aa, ba, rng), pb = betaSample(ab, bb, rng);
    if (pa > pb) wins++;
    const d = pa - pb;
    deltas[i] = d; sum += d;
  }
  deltas.sort((p, q) => p - q);
  return {
    pImprove: wins / samples,
    deltaMean: sum / samples,
    deltaCi: [deltas[Math.floor(0.025 * samples)]!, deltas[Math.floor(0.975 * samples)]!],
  };
}

/** Benjamini-Hochberg step-up ADJUSTED p-values: adj[i] = min over ranks j>=rank(i) of m*p_(j)/j.
 * adj[i] <= q ⟺ benjaminiHochberg(pvals, q) rejects i, but the adjusted value is reportable
 * next to the raw p so the multiple-comparisons correction is visible, not silent. */
export function bhAdjust(pvals: number[]): number[] {
  const m = pvals.length;
  if (m === 0) return [];
  const order = [...pvals.keys()].sort((i, j) => pvals[i]! - pvals[j]!);
  const adj = new Array<number>(m).fill(1);
  let running = 1;
  for (let idx = m - 1; idx >= 0; idx--) {
    const i = order[idx]!;
    running = Math.min(running, (pvals[i]! * m) / (idx + 1));
    adj[i] = Math.min(1, running);
  }
  return adj;
}

/** Benjamini-Hochberg FDR. Returns booleans (true = flag as real). */
export function benjaminiHochberg(pvals: number[], q = 0.05): boolean[] {
  const m = pvals.length;
  if (m === 0) return [];
  const order = [...pvals.keys()].sort((i, j) => pvals[i]! - pvals[j]!);
  let maxRank = 0;
  order.forEach((i, idx) => {
    const rank = idx + 1;
    if (pvals[i]! <= (rank / m) * q) maxRank = rank;
  });
  const rejected = new Array<boolean>(m).fill(false);
  order.forEach((i, idx) => { if (idx + 1 <= maxRank) rejected[i] = true; });
  return rejected;
}
