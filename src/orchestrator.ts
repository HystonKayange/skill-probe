/** Runs one prompt up to k VALID times with sequential early-stopping vs the threshold.
 * Infra errors (status="error") are retried up to a budget and never counted as a behavioral
 * outcome (finding #1) — they're tracked separately so the audit can flag untrustworthy cases. */
import type { RuntimeAdapter } from "./types.ts";
import { sequentialDecision } from "./stats.ts";

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
}

/** A measurement is untrustworthy when infrastructure failures dominate — no valid probes, or
 * errors at least equal the valid count. Such a run must NOT read as a behavioral result (a runtime
 * outage is not a clean pass). Shared by the audit, context, and diagnose paths. */
export function infraUntrustworthy(s: RunStats): boolean {
  return s.n === 0 || (s.errors > 0 && s.errors >= s.n);
}

export async function measure(
  adapter: RuntimeAdapter,
  prompt: string,
  expected: string | null,
  opts: {
    cwd: string; maxK: number; threshold: number; conf: number; model?: string;
    onProbe?: (validN: number, maxK: number) => void;
  },
): Promise<RunStats> {
  const want = expected ?? "None";
  const dist: Record<string, number> = {};
  let hits = 0, n = 0, errors = 0, totalCost = 0;
  let lastError: string | undefined;
  // allow up to 50% extra attempts to absorb transient infra errors without inflating k
  const maxAttempts = opts.maxK + Math.ceil(opts.maxK / 2);

  for (let attempt = 0; attempt < maxAttempts && n < opts.maxK; attempt++) {
    const r = await adapter.probe(prompt, { cwd: opts.cwd, ...(opts.model ? { model: opts.model } : {}) });
    totalCost += r.cost;
    if (r.status === "error") {
      errors++;
      lastError = r.error;
      opts.onProbe?.(n, opts.maxK);
      continue; // do NOT record as a behavioral outcome
    }
    const key = r.skillFired ?? "None";
    dist[key] = (dist[key] ?? 0) + 1;
    if (key === want) hits++;
    n++;
    opts.onProbe?.(n, opts.maxK);
    if (n >= 3) {
      const d = sequentialDecision(hits, n, opts.threshold, opts.conf);
      if (d !== "undecided") break;
    }
  }
  return { hits, n, errors, dist, totalCost, ...(lastError ? { lastError } : {}) };
}
