/** The audit: run every case co-loaded, compute reliability (with CI), detect trigger-theft,
 * and keep infrastructure failure distinct from behavioral failure (finding #1). */
import type { Config } from "./types.ts";
import { reliability, sequentialDecision } from "./stats.ts";
import { measure, type RunStats } from "./orchestrator.ts";
import { getAdapter } from "./adapters/index.ts";

/** Four honest states. `error` = the runtime failed enough that the measurement is untrustworthy. */
export type Verdict = "pass" | "fail" | "inconclusive" | "error";

export interface CaseResult {
  prompt: string;
  expected: string | null;
  stats: RunStats;
  reliability: ReturnType<typeof reliability>;
  /** non-expected, non-None skills that fired = interference / trigger-theft */
  theft: string[];
  decision: "above" | "below" | "undecided";
  verdict: Verdict;
}

export interface AuditResult {
  runtime: string;
  model: string;
  threshold: number;
  cases: CaseResult[];
  totalCost: number;
  counts: { pass: number; fail: number; inconclusive: number; error: number };
  /** 0 = all pass; 1 = a behavioral failure/theft; 2 = inconclusive or infrastructure error */
  exitCode: 0 | 1 | 2;
}

function verdictFor(stats: RunStats, decision: CaseResult["decision"], theft: string[]): Verdict {
  // `error` means INFRASTRUCTURE failures dominate — untrustworthy. It is NOT about small k:
  // a small-but-all-valid run is `inconclusive` (wide CI), which the report explains.
  if (stats.n === 0 || (stats.errors > 0 && stats.errors >= stats.n)) return "error";
  if (theft.length > 0) return "fail";
  if (decision === "above") return "pass";
  if (decision === "below") return "fail";
  return "inconclusive"; // includes "k too small to decide" — report says how many runs are needed
}

export async function runAudit(cfg: Config): Promise<AuditResult> {
  const adapter = getAdapter(cfg.runtime);

  const cases: CaseResult[] = [];
  let totalCost = 0;
  for (const c of cfg.cases) {
    const stats = await measure(adapter, c.prompt, c.expected, {
      cwd: cfg.cwd, maxK: cfg.k, threshold: cfg.threshold, conf: cfg.conf,
      ...(cfg.model ? { model: cfg.model } : {}),
    });
    totalCost += stats.totalCost;
    const rel = reliability(stats.hits, stats.n, cfg.conf);
    const want = c.expected ?? "None";
    const theft = Object.keys(stats.dist).filter((s) => s !== want && s !== "None");
    const decision = sequentialDecision(stats.hits, stats.n, cfg.threshold, cfg.conf);
    cases.push({
      prompt: c.prompt, expected: c.expected, stats, reliability: rel,
      theft, decision, verdict: verdictFor(stats, decision, theft),
    });
  }
  // NOTE: Benjamini-Hochberg multiplicity control over per-case exact-test p-values lands in M2,
  // once each case carries a real p-value rather than a CI decision. The functions are tested
  // in stats.ts but are NOT yet wired into this audit path.

  const counts = {
    pass: cases.filter((c) => c.verdict === "pass").length,
    fail: cases.filter((c) => c.verdict === "fail").length,
    inconclusive: cases.filter((c) => c.verdict === "inconclusive").length,
    error: cases.filter((c) => c.verdict === "error").length,
  };
  const exitCode: 0 | 1 | 2 =
    counts.fail > 0 ? 1 : (counts.error > 0 || counts.inconclusive > 0) ? 2 : 0;

  return {
    runtime: cfg.runtime, model: cfg.model ?? "(runtime default)",
    threshold: cfg.threshold, cases, totalCost, counts, exitCode,
  };
}
