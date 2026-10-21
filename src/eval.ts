/** The audit: run every case co-loaded, compute reliability (with CI), detect trigger-theft,
 * and keep infrastructure failure distinct from behavioral failure (finding #1). */
import { type Config, probeSettings } from "./types.ts";
import { reliability, planDecision, sequentialPlan } from "./stats.ts";
import {
  measure, mapPool, infraUntrustworthy, loadProblems, extraSkills, type Budget, type RunStats,
} from "./orchestrator.ts";
import { getAdapter } from "./adapters/index.ts";
import { buildManifest, buildEnvironment, capabilityWarnings, type RunManifest } from "./manifest.ts";
import { listSkills, type SkillInfo } from "./skills.ts";

/** Four honest states. `error` = the runtime failed enough that the measurement is untrustworthy. */
export type Verdict = "pass" | "fail" | "inconclusive" | "error";

export interface CaseResult {
  prompt: string;
  expected: string | null;
  stats: RunStats;
  reliability: ReturnType<typeof reliability>;
  /** non-expected, non-None skills that fired = interference / trigger-theft. A warning unless
   * failOnTheft is set: one stray firing out of k is not statistical evidence of a problem. */
  theft: string[];
  decision: "above" | "below" | "undecided";
  verdict: Verdict;
  /** the runtime reported its loaded skills and the expected skill wasn't among them — it can
   * never fire (usually a SKILL.md the runtime rejected) */
  notLoaded?: boolean;
}

export interface AuditResult {
  runtime: string;
  model: string;
  threshold: number;
  cases: CaseResult[];
  totalCost: number;
  counts: { pass: number; fail: number; inconclusive: number; error: number };
  /** 0 = all pass; 1 = a behavioral failure; 2 = inconclusive or infrastructure error */
  exitCode: 0 | 1 | 2;
  /** who/what/when of this run — makes reports citable and baselines comparable */
  manifest: RunManifest;
  /** run-level problems worth reading before the verdicts (unloaded skills, personal config…) */
  warnings: string[];
}

function verdictFor(stats: RunStats, decision: CaseResult["decision"], theft: string[], failOnTheft: boolean): Verdict {
  // `error` means INFRASTRUCTURE failures dominate — untrustworthy. It is NOT about small k:
  // a small-but-all-valid run is `inconclusive` (wide CI), which the report explains.
  if (infraUntrustworthy(stats)) return "error";
  if (failOnTheft && theft.length > 0) return "fail";
  if (decision === "above") return "pass";
  if (decision === "below") return "fail";
  return "inconclusive"; // includes "k too small to decide" — report says how many runs are needed
}

export interface ProgressEvent {
  caseIndex: number;   // 1-based
  caseTotal: number;
  prompt: string;
  validN: number;
  maxK: number;
}

export interface RunOpts {
  onProgress?: (e: ProgressEvent) => void;
  /** cases probed in parallel (default 1) */
  concurrency?: number;
  budget?: Budget;
}

/** The library at cfg.cwd, or null when there's no readable skills dir (load checks are skipped). */
function tryListSkills(cwd: string): SkillInfo[] | null {
  try { return listSkills(cwd); } catch { return null; }
}

export async function runAudit(
  cfg: Config,
  optsOrProgress: RunOpts | ((e: ProgressEvent) => void) = {},
): Promise<AuditResult> {
  const opts: RunOpts = typeof optsOrProgress === "function" ? { onProgress: optsOrProgress } : optsOrProgress;
  const adapter = getAdapter(cfg.runtime);
  const library = tryListSkills(cfg.cwd);
  const plan = sequentialPlan(cfg.k, cfg.threshold, cfg.conf);
  const settings = probeSettings(cfg);
  const onProgress = opts.onProgress;

  const cases = await mapPool(cfg.cases, opts.concurrency ?? 1, async (c, ci): Promise<CaseResult> => {
    const stats = await measure(adapter, c.prompt, c.expected, {
      cwd: cfg.cwd, maxK: cfg.k, threshold: cfg.threshold, conf: cfg.conf, ...settings,
      ...(opts.budget ? { budget: opts.budget } : {}),
      ...(onProgress ? {
        onProbe: (validN: number, maxK: number) => onProgress({
          caseIndex: ci + 1, caseTotal: cfg.cases.length, prompt: c.prompt, validN, maxK,
        }),
      } : {}),
    });
    const rel = reliability(stats.hits, stats.n, cfg.conf);
    const want = c.expected ?? "None";
    const theft = Object.keys(stats.dist).filter((s) => s !== want && s !== "None");
    const decision = planDecision(plan, stats.hits, stats.n);
    const notLoaded = library !== null && c.expected !== null &&
      loadProblems(stats.env, [c.expected], library.filter((s) => s.name === c.expected)).missing.length > 0;
    return {
      prompt: c.prompt, expected: c.expected, stats, reliability: rel,
      theft, decision, verdict: verdictFor(stats, decision, theft, Boolean(cfg.failOnTheft)),
      ...(notLoaded ? { notLoaded } : {}),
    };
  });
  // NOTE: per-case verdicts here are sequential tests vs the threshold, each with its own exact
  // error bound — not a family of p-values to BH-correct. Where families of Fisher tests exist
  // (context, ablation, baseline comparison) the correction is applied.

  const totalCost = cases.reduce((s, c) => s + c.stats.totalCost, 0);
  const counts = {
    pass: cases.filter((c) => c.verdict === "pass").length,
    fail: cases.filter((c) => c.verdict === "fail").length,
    inconclusive: cases.filter((c) => c.verdict === "inconclusive").length,
    error: cases.filter((c) => c.verdict === "error").length,
  };
  const exitCode: 0 | 1 | 2 =
    counts.fail > 0 ? 1 : (counts.error > 0 || counts.inconclusive > 0) ? 2 : 0;

  const env = cases.find((c) => c.stats.env)?.stats.env;
  const warnings: string[] = capabilityWarnings(cfg, adapter);
  const unloaded = [...new Set(cases.filter((c) => c.notLoaded).map((c) => c.expected!))];
  if (unloaded.length) {
    warnings.push(`the runtime did not load: ${unloaded.join(", ")} — these can never fire ` +
      `(check each SKILL.md's frontmatter; run \`skill-probe doctor\`)`);
  }
  if (cfg.userConfig) {
    warnings.push(`probes loaded your personal runtime config (--user-config): results reflect this ` +
      `machine and won't reproduce in CI`);
  }
  if (cases.some((c) => c.stats.budgetExhausted)) {
    warnings.push(`--max-cost budget reached — cases cut short are inconclusive (error if they never started), never a pass`);
  }

  return {
    runtime: cfg.runtime, model: cfg.model ?? "(runtime default)",
    threshold: cfg.threshold, cases, totalCost, counts, exitCode,
    manifest: buildManifest("audit", cfg, buildEnvironment(cfg, env, library ? extraSkills(env, library) : undefined, adapter)),
    warnings,
  };
}
