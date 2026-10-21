/** Runs one prompt up to k VALID times with sequential early-stopping vs the threshold.
 * Infra errors (status="error") are retried up to a budget and never counted as a behavioral
 * outcome (finding #1) — they're tracked separately so the audit can flag untrustworthy cases.
 * Early stopping follows an exact group-sequential plan (stats.ts), so peeking after every probe
 * doesn't inflate the verdict error rate. */
import type { ProbeEnv, ProbeOpts, RuntimeAdapter } from "./types.ts";
import { planDecision, sequentialPlan } from "./stats.ts";

export interface RunStats {
  /** valid probes whose outcome matched the expected behavior */
  hits: number;
  /** number of VALID probes (excludes infra errors) */
  n: number;
  /** infrastructure failures (timeout/auth/crash/empty) */
  errors: number;
  /** last infra-error reason (for the report) */
  lastError?: string;
  /** distribution of outcomes over valid probes: skill name (or "None") -> count */
  dist: Record<string, number>;
  totalCost: number;
  /** valid probes where the model called some other tool and no skill fired — with a low
   * --max-turns the skill may have been about to load, so activation can be under-counted */
  preempted: number;
  /** what the runtime reported loading (first probe that reported it) */
  env?: ProbeEnv;
  /** stopped because the shared --max-cost budget ran out (the measurement is incomplete) */
  budgetExhausted?: boolean;
}

/** A shared spend cap across every probe of a run (`--max-cost`). Checked before each probe, so a
 * run can overshoot by at most the probes already in flight. */
export class Budget {
  spent = 0;
  readonly maxUsd: number;
  constructor(maxUsd: number) { this.maxUsd = maxUsd; }
  get exhausted(): boolean { return this.spent >= this.maxUsd; }
  add(usd: number): void { this.spent += usd; }
}

/** A measurement is untrustworthy when infrastructure failures dominate — no valid probes, or
 * errors at least equal the valid count. Such a run must NOT read as a behavioral result (a runtime
 * outage is not a clean pass). Shared by the audit, context, and diagnose paths. */
export function infraUntrustworthy(s: RunStats): boolean {
  return s.n === 0 || (s.errors > 0 && s.errors >= s.n);
}

export interface MeasureOpts extends Omit<ProbeOpts, "cwd"> {
  cwd: string;
  maxK: number;
  threshold: number;
  conf: number;
  budget?: Budget;
  onProbe?: (validN: number, maxK: number) => void;
}

export async function measure(
  adapter: RuntimeAdapter,
  prompt: string,
  expected: string | null,
  opts: MeasureOpts,
): Promise<RunStats> {
  const { maxK, threshold, conf, budget, onProbe, ...probeOpts } = opts;
  const want = expected ?? "None";
  const plan = sequentialPlan(maxK, threshold, conf);
  const dist: Record<string, number> = {};
  let hits = 0, n = 0, errors = 0, totalCost = 0, preempted = 0;
  let lastError: string | undefined;
  let env: ProbeEnv | undefined;
  let budgetExhausted = false;
  // allow up to 50% extra attempts to absorb transient infra errors without inflating k
  const maxAttempts = maxK + Math.ceil(maxK / 2);

  for (let attempt = 0; attempt < maxAttempts && n < maxK; attempt++) {
    if (budget?.exhausted) { budgetExhausted = true; lastError = `--max-cost budget ($${budget.maxUsd}) reached`; break; }
    const r = await adapter.probe(prompt, probeOpts);
    totalCost += r.cost;
    budget?.add(r.cost);
    if (!env && r.env?.loadedSkills) env = r.env;
    if (r.status === "error") {
      errors++;
      lastError = r.error;
      onProbe?.(n, maxK);
      continue; // do NOT record as a behavioral outcome
    }
    const key = r.skillFired ?? "None";
    dist[key] = (dist[key] ?? 0) + 1;
    if (key === want) hits++;
    if (r.skillFired === null && r.trajectory.length > 0) preempted++;
    n++;
    onProbe?.(n, maxK);
    if (planDecision(plan, hits, n) !== "undecided") break;
  }
  return {
    hits, n, errors, dist, totalCost, preempted,
    ...(lastError ? { lastError } : {}),
    ...(env ? { env } : {}),
    ...(budgetExhausted ? { budgetExhausted } : {}),
  };
}

/** Bounded-concurrency map preserving input order. concurrency 1 = strictly sequential. */
export async function mapPool<T, R>(
  items: readonly T[], concurrency: number, fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!, i);
    }
  };
  const width = Math.max(1, Math.min(Math.floor(concurrency) || 1, items.length));
  await Promise.all(Array.from({ length: width }, worker));
  return out;
}

/** Problems with what the runtime actually loaded for a condition that was meant to contain
 * exactly `intended` out of `library`. Matches either folder names or frontmatter names. Skills in
 * `ambiguous` (library skills sharing a name with a runtime built-in, which is "loaded" whether or
 * not the library copy is) can't be judged from names alone and are skipped. */
export function loadProblems(
  env: ProbeEnv | undefined,
  intended: readonly string[],
  library: ReadonlyArray<{ name: string; frontmatterName?: string }>,
  ambiguous: ReadonlySet<string> = new Set(),
): { missing: string[]; unexpected: string[] } {
  if (!env?.loadedSkills) return { missing: [], unexpected: [] };
  const loaded = new Set(env.loadedSkills);
  const isLoaded = (s: { name: string; frontmatterName?: string }): boolean =>
    loaded.has(s.name) || (s.frontmatterName !== undefined && loaded.has(s.frontmatterName));
  const want = new Set(intended);
  const judged = library.filter((s) => !ambiguous.has(s.name));
  return {
    missing: judged.filter((s) => want.has(s.name) && !isLoaded(s)).map((s) => s.name),
    unexpected: judged.filter((s) => !want.has(s.name) && isLoaded(s)).map((s) => s.name),
  };
}

/** Library skills whose name (folder or frontmatter) is also a runtime built-in's name. */
export function builtinClashes(
  builtins: readonly string[],
  library: ReadonlyArray<{ name: string; frontmatterName?: string }>,
): string[] {
  const b = new Set(builtins);
  return library
    .filter((s) => b.has(s.name) || (s.frontmatterName !== undefined && b.has(s.frontmatterName)))
    .map((s) => s.name);
}

/** Skills the runtime loaded that are NOT part of the library (runtime built-ins, user config…). */
export function extraSkills(
  env: ProbeEnv | undefined,
  library: ReadonlyArray<{ name: string; frontmatterName?: string }>,
): string[] | undefined {
  if (!env?.loadedSkills) return undefined;
  const mine = new Set(library.flatMap((s) => [s.name, ...(s.frontmatterName ? [s.frontmatterName] : [])]));
  return env.loadedSkills.filter((s) => !mine.has(s)).sort();
}
