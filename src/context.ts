/** `skill-probe context` — activation-rate-BY-CONTEXT. The audit measures every skill co-loaded
 * (the real, hard condition). This command additionally measures each skill in ISOLATION (only that
 * skill present) and compares the two: it catches the "fires fine alone, fails under load" case that
 * a single aggregate rate hides. The drop is tested with Fisher's exact test, so interference is
 * reported as a real effect (p-value), not eyeballed.
 *
 * Every condition (isolation, co-loaded, each leave-one-out ablation) runs in a sandbox built the
 * same way — see sandbox.ts — so the ONLY difference between conditions is which skills are
 * present. When the runtime reports what it loaded, each condition is checked against what it was
 * meant to contain; a mismatch makes the comparison untrustworthy instead of silently wrong. */
import { type Config, probeSettings } from "./types.ts";
import { reliability, fisherExact2x2, bhAdjust } from "./stats.ts";
import {
  measure, mapPool, infraUntrustworthy, loadProblems, extraSkills, builtinClashes,
  type Budget, type MeasureOpts, type RunStats,
} from "./orchestrator.ts";
import { getAdapter } from "./adapters/index.ts";
import { listSkills, type SkillInfo } from "./skills.ts";
import { buildSandbox, withSandbox } from "./sandbox.ts";
import { ConfigError } from "./config.ts";
import { buildManifest, buildEnvironment, capabilityWarnings, type RunManifest } from "./manifest.ts";

/** Kept for compatibility: a sandbox holding only the named skills (plus instruction files). */
export const buildContextDir = buildSandbox;

type Rel = ReturnType<typeof reliability>;
interface Condition { stats: RunStats; rel: Rel }

/** One leave-one-out run: the flagged case re-measured with ONE suspect sibling removed from the
 * library. A significant recovery (BH-corrected Fisher vs the co-loaded run) names that sibling
 * as the thief — evidence, not the trigger-theft heuristic. */
export interface AblationResult {
  removed: string;             // the sibling taken out of the library for this run
  stolen: number;              // probes this sibling stole in the co-loaded run (the ranking signal)
  stats: RunStats;
  rel: Rel;
  deltaVsCoLoaded: number;     // rel.pHat - coLoaded.pHat (positive = activation recovered)
  fisherP: number;             // raw p that the recovery is real (ablated vs co-loaded)
  fisherPAdj: number;          // BH-adjusted across ALL ablation runs in this audit (own family)
  untrustworthy: boolean;      // infra failures dominated this run, or it loaded the wrong skills
  /** why the run isn't a valid comparison, when the runtime loaded the wrong skill set */
  loadIssue?: string;
  culprit: boolean;            // recovery is significant → removing this skill restores activation
}

export interface ContextCaseResult {
  prompt: string;
  expected: string;            // null-expected (decoy) cases are skipped — nothing to isolate
  isolation: Condition;        // only the expected skill loaded
  coLoaded: Condition;         // the whole library loaded
  deltaP: number;              // coLoaded.pHat - isolation.pHat (negative = suppressed under load)
  fisherP: number;             // raw p that the isolation-vs-co-loaded difference is real
  /** Benjamini-Hochberg adjusted p across all trustworthy comparisons in this run — one Fisher
   * test per case is a FAMILY, and raw p<0.05 over a 40-case library expects ~2 false flags by
   * chance alone. Interference is decided on THIS value. (1 for untrustworthy cases.) */
  fisherPAdj: number;
  /** infra failures dominated one side, or a condition loaded the wrong skills — the comparison is
   * not trustworthy (NOT a behavioral result) */
  untrustworthy: boolean;
  /** why a condition isn't valid, when the runtime loaded the wrong skill set */
  loadIssue?: string;
  /** skills OUTSIDE the library (e.g. runtime built-ins) that fired in the co-loaded run — they
   * can't be ablated, only avoided (narrow or rename the expected skill) */
  externalThieves?: string[];
  /** fires reliably alone but drops significantly (BH-corrected) when the library is co-loaded */
  interference: boolean;
  /** leave-one-out runs (only with { ablate: true }, only for interference cases). Empty array =
   * ablation requested but no named suspect stole probes (suppressed to None — dilution, not theft). */
  ablation?: AblationResult[];
}

export interface ContextAuditResult {
  runtime: string;
  model: string;
  threshold: number;
  conf: number;
  librarySize: number;         // skills present in the full (co-loaded) library
  cases: ContextCaseResult[];
  skipped: string[];           // decoy prompts skipped (null expected — nothing to isolate)
  totalCost: number;
  /** 0 = no interference; 1 = a skill is suppressed under load; 2 = an untrustworthy (infra) case */
  exitCode: 0 | 1 | 2;
  /** who/what/when of this run — makes reports citable and comparable */
  manifest: RunManifest;
  /** run-level caveats (built-in name clashes, budget cut-offs) */
  warnings: string[];
}

export interface ContextProgress {
  caseIndex: number; caseTotal: number; prompt: string;
  condition: "isolation" | "co-loaded" | "ablation"; validN: number; maxK: number;
  /** the sibling removed for this run (condition === "ablation" only) */
  removed?: string;
}

export interface ContextOpts {
  /** leave-one-out: for each interference case, re-measure with each suspect sibling removed and
   * name the thief when activation recovers significantly. */
  ablate?: boolean;
  /** max suspect siblings to ablate per flagged case, ranked by probes stolen (default 3) */
  suspects?: number;
  onProgress?: (e: ContextProgress) => void;
  /** cases (and ablation runs) probed in parallel (default 1) */
  concurrency?: number;
  budget?: Budget;
}

/** "" when the condition loaded exactly what it should have; otherwise a human-readable reason. */
function describeLoadIssue(
  label: string, stats: RunStats, intended: string[], library: SkillInfo[], ambiguous: ReadonlySet<string>,
): string {
  const { missing, unexpected } = loadProblems(stats.env, intended, library, ambiguous);
  const parts: string[] = [];
  if (missing.length) parts.push(`did not load ${missing.join(", ")}`);
  if (unexpected.length) parts.push(`also loaded ${unexpected.join(", ")}`);
  return parts.length ? `${label}: the runtime ${parts.join(" and ")}` : "";
}

const fisherVs = (a: RunStats, b: RunStats): number =>
  (a.n > 0 && b.n > 0) ? fisherExact2x2(a.hits, a.n - a.hits, b.hits, b.n - b.hits) : 1;

export async function runContextAudit(
  cfg: Config,
  optsOrProgress: ContextOpts | ((e: ContextProgress) => void) = {},
): Promise<ContextAuditResult> {
  const opts: ContextOpts =
    typeof optsOrProgress === "function" ? { onProgress: optsOrProgress } : optsOrProgress;
  const onProgress = opts.onProgress;
  const adapter = getAdapter(cfg.runtime);
  const library = listSkills(cfg.cwd);
  const libraryNames = library.map((s) => s.name);
  const present = new Set(libraryNames);

  const skipped: string[] = [];

  // decoys (null expected) have nothing to isolate → skipped. An expected skill that ISN'T in the
  // library is almost always a config typo: fail loud BEFORE spending probes, never silently skip.
  const eligible: Array<{ prompt: string; expected: string }> = [];
  const unknown: string[] = [];
  for (const c of cfg.cases) {
    if (c.expected === null) skipped.push(c.prompt);
    else if (!present.has(c.expected)) unknown.push(c.expected);
    else eligible.push({ prompt: c.prompt, expected: c.expected });
  }
  if (unknown.length) {
    throw new ConfigError([
      `expected skill(s) not in ${cfg.cwd}/.claude/skills/: ${[...new Set(unknown)].join(", ")} ` +
      `(typo?). Available: ${libraryNames.join(", ") || "(none)"}.`,
    ]);
  }

  const common = {
    maxK: cfg.k, threshold: cfg.threshold, conf: cfg.conf, ...probeSettings(cfg),
    ...(opts.budget ? { budget: opts.budget } : {}),
  };
  const progress = (caseIndex: number, caseTotal: number, prompt: string,
    condition: ContextProgress["condition"], removed?: string): Pick<MeasureOpts, "onProbe"> =>
    onProgress
      ? { onProbe: (validN, maxK) => onProgress({ caseIndex, caseTotal, prompt, condition, validN, maxK, ...(removed ? { removed } : {}) }) }
      : {};

  // the full library, shared read-only by every co-loaded run
  const measured = await withSandbox(cfg.cwd, libraryNames, (full) =>
    mapPool(eligible, opts.concurrency ?? 1, async (c, i): Promise<ContextCaseResult> => {
      const iso = await withSandbox(cfg.cwd, [c.expected], (sb) =>
        measure(adapter, c.prompt, c.expected, {
          cwd: sb.cwd, ...common, ...progress(i + 1, eligible.length, c.prompt, "isolation"),
        }));
      const co = await measure(adapter, c.prompt, c.expected, {
        cwd: full.cwd, ...common, ...progress(i + 1, eligible.length, c.prompt, "co-loaded"),
      });
      const isoRel = reliability(iso.hits, iso.n, cfg.conf);
      const coRel = reliability(co.hits, co.n, cfg.conf);
      // load-set integrity is judged after all cases (it may need the runtime's built-in names)
      const untrustworthy = infraUntrustworthy(iso) || infraUntrustworthy(co);
      const externalThieves = Object.keys(co.dist).filter((s) => s !== c.expected && s !== "None" && !present.has(s));
      // interference is decided AFTER all cases, once the whole family is known (BH) — placeholders
      return {
        prompt: c.prompt, expected: c.expected,
        isolation: { stats: iso, rel: isoRel },
        coLoaded: { stats: co, rel: coRel },
        deltaP: coRel.pHat - isoRel.pHat, fisherP: fisherVs(iso, co), fisherPAdj: 1,
        untrustworthy, interference: false,
        ...(externalThieves.length ? { externalThieves } : {}),
      };
    }));

  // Did each condition load exactly the skills it should? A library skill that shares a name with a
  // runtime built-in looks "loaded" everywhere, so when anything looks wrong, learn the built-in
  // names once (an empty sandbox) and leave those ambiguous names out of the check.
  let ambiguous: ReadonlySet<string> = new Set();
  let extraCost = 0;
  let builtinsProbe: Promise<void> | undefined;
  // memoized promise (not a flag): concurrent ablation runs must all wait for the same answer
  const learnBuiltins = (): Promise<void> => (builtinsProbe ??= (async () => {
    const r = await withSandbox(cfg.cwd, [], (sb) =>
      adapter.probe("Reply with exactly: ok", { cwd: sb.cwd, ...probeSettings(cfg) }));
    extraCost += r.cost;
    opts.budget?.add(r.cost);
    if (r.status === "ok" && r.env?.loadedSkills) ambiguous = new Set(builtinClashes(r.env.loadedSkills, library));
  })());
  const looksWrong = (st: RunStats, intended: string[]): boolean =>
    loadProblems(st.env, intended, library).unexpected.length > 0;
  if (measured.some((m) => looksWrong(m.isolation.stats, [m.expected]) || looksWrong(m.coLoaded.stats, libraryNames))) {
    await learnBuiltins();
  }
  for (const m of measured) {
    const loadIssue = [
      describeLoadIssue("isolation", m.isolation.stats, [m.expected], library, ambiguous),
      describeLoadIssue("co-loaded", m.coLoaded.stats, libraryNames, library, ambiguous),
    ].filter(Boolean).join("; ");
    // a condition that didn't contain what it should isn't a behavioral result — it must never
    // read as "no interference / pass".
    if (loadIssue) { m.loadIssue = loadIssue; m.untrustworthy = true; }
  }

  // One Fisher test per case = a family of comparisons: correct across the trustworthy ones so a
  // big library doesn't buy false interference flags by chance (raw p<0.05 × 40 cases ≈ 2 flukes).
  const trustworthy = measured.filter((m) => !m.untrustworthy);
  const adj = bhAdjust(trustworthy.map((m) => m.fisherP));
  trustworthy.forEach((m, j) => { m.fisherPAdj = adj[j]!; });
  for (const m of measured) {
    m.interference =
      !m.untrustworthy &&
      m.isolation.rel.pHat >= cfg.threshold &&  // fires reliably alone
      m.deltaP < 0 &&                           // and drops when co-loaded
      m.fisherPAdj < 0.05;                      // and the drop survives BH correction
  }

  // leave-one-out ablation: for each flagged case, re-measure with each suspect sibling removed.
  // Suspects are ranked by the probes they actually stole in the co-loaded run — evidence-guided,
  // not a sweep of the whole library. Recovery is Fisher-tested against the co-loaded run and
  // BH-corrected across all ablation runs (their own family). A significant recovery NAMES the
  // thief; no suspects in the outcome distribution means the drop was dilution, not theft.
  if (opts.ablate) {
    const flagged = measured.filter((m) => m.interference);
    const cap = opts.suspects ?? 3;
    const jobs: Array<{ m: ContextCaseResult; fi: number; suspect: string; stolen: number }> = [];
    flagged.forEach((m, fi) => {
      m.ablation = [];
      Object.entries(m.coLoaded.stats.dist)
        .filter(([name]) => name !== m.expected && name !== "None" && present.has(name))
        .sort((x, y) => y[1] - x[1])
        .slice(0, cap)
        .forEach(([suspect, stolen]) => jobs.push({ m, fi, suspect, stolen }));
    });
    const runs = await mapPool(jobs, opts.concurrency ?? 1, async ({ m, fi, suspect, stolen }) => {
      const kept = libraryNames.filter((n) => n !== suspect);
      const st = await withSandbox(cfg.cwd, kept, (sb) =>
        measure(adapter, m.prompt, m.expected, {
          cwd: sb.cwd, ...common, ...progress(fi + 1, flagged.length, m.prompt, "ablation", suspect),
        }));
      const rel = reliability(st.hits, st.n, cfg.conf);
      if (looksWrong(st, kept)) await learnBuiltins();
      const loadIssue = describeLoadIssue(`without ${suspect}`, st, kept, library, ambiguous);
      const abl: AblationResult = {
        removed: suspect, stolen, stats: st, rel,
        deltaVsCoLoaded: rel.pHat - m.coLoaded.rel.pHat,
        fisherP: fisherVs(st, m.coLoaded.stats), fisherPAdj: 1,
        untrustworthy: infraUntrustworthy(st) || Boolean(loadIssue),
        ...(loadIssue ? { loadIssue } : {}),
        culprit: false,
      };
      return { m, abl };
    });
    for (const { m, abl } of runs) m.ablation!.push(abl);
    const allRuns = runs.map((r) => r.abl);
    const ablFamily = allRuns.filter((r) => !r.untrustworthy);
    const ablAdj = bhAdjust(ablFamily.map((r) => r.fisherP));
    ablFamily.forEach((r, j) => { r.fisherPAdj = ablAdj[j]!; });
    for (const r of allRuns) {
      r.culprit = !r.untrustworthy && r.deltaVsCoLoaded > 0 && r.fisherPAdj < 0.05;
    }
  }

  // precedence mirrors the audit: a real behavioral signal (interference, exit 1) outranks an
  // untrustworthy/infra case (exit 2), which outranks a clean run (exit 0).
  const exitCode: 0 | 1 | 2 =
    measured.some((m) => m.interference) ? 1
    : measured.some((m) => m.untrustworthy) ? 2
    : 0;

  const totalCost = extraCost + measured.reduce((s, m) =>
    s + m.isolation.stats.totalCost + m.coLoaded.stats.totalCost +
    (m.ablation ?? []).reduce((t, a) => t + a.stats.totalCost, 0), 0);
  const env = measured.find((m) => m.coLoaded.stats.env)?.coLoaded.stats.env;

  const warnings: string[] = capabilityWarnings(cfg, adapter);
  if (ambiguous.size) {
    warnings.push(`${[...ambiguous].join(", ")} share${ambiguous.size === 1 ? "s" : ""} a name with a ${cfg.runtime} ` +
      `built-in skill — the two compete for the same trigger, and load checks can't tell them apart (rename recommended)`);
  }
  const allStats = measured.flatMap((m) => [m.isolation.stats, m.coLoaded.stats, ...(m.ablation ?? []).map((a) => a.stats)]);
  if (allStats.some((st) => st.budgetExhausted)) {
    warnings.push(`--max-cost budget reached — some conditions were cut short (inconclusive or error, never a clean result)`);
  }

  return {
    runtime: cfg.runtime, model: cfg.model ?? "(runtime default)",
    threshold: cfg.threshold, conf: cfg.conf, librarySize: library.length,
    cases: measured, skipped, totalCost, exitCode,
    manifest: buildManifest("context", cfg, buildEnvironment(cfg, env, extraSkills(env, library), adapter)),
    warnings,
  };
}
