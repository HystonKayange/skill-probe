/**
 * Statistical core (TS port of stats_ref/stats.py — the validated reference impl).
 * Skill activation is Bernoulli with unknown p; we estimate from k runs and never
 * report a bare point. See ../../STATS.md.
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

/** Sequential stop rule: is p reliably above/below threshold yet, or keep sampling? */
export function sequentialDecision(
  x: number, n: number, threshold: number, conf = 0.95,
): Decision {
  const { lo, hi } = wilsonInterval(x, n, conf);
  if (lo > threshold) return "above";
  if (hi < threshold) return "below";
  return "undecided";
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
