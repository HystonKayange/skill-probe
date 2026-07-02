/** `skill-probe context` — activation-rate-BY-CONTEXT. The audit measures every skill co-loaded
 * (the real, hard condition). This command additionally measures each skill in ISOLATION (only that
 * skill present) and compares the two: it catches the "fires fine alone, fails under load" case that
 * a single aggregate rate hides. The drop is tested with Fisher's exact test, so interference is
 * reported as a real effect (p-value), not eyeballed. */
import { mkdtempSync, mkdirSync, cpSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "./types.ts";
import { reliability, fisherExact2x2, bhAdjust } from "./stats.ts";
import { measure, infraUntrustworthy, type RunStats } from "./orchestrator.ts";
import { getAdapter } from "./adapters/index.ts";
import { listSkills } from "./gen.ts";
import { ConfigError } from "./config.ts";

/** Build a throwaway project dir whose .claude/skills/ holds ONLY the named skills (copied from
 * srcCwd). Returns its path plus a cleanup(). The probe runs against this dir to load a subset. */
export function buildContextDir(
  srcCwd: string,
  skillNames: string[],
): { cwd: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "skill-probe-ctx-"));
  const destSkills = join(root, ".claude", "skills");
  mkdirSync(destSkills, { recursive: true });
  for (const name of skillNames) {
    const src = join(srcCwd, ".claude", "skills", name);
    if (!existsSync(src)) throw new Error(`skill not found in ${srcCwd}: ${name}`);
    cpSync(src, join(destSkills, name), { recursive: true });
  }
  return { cwd: root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

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
  untrustworthy: boolean;      // infra failures dominated this run
  culprit: boolean;            // recovery is significant → removing this skill restores activation
}

export interface ContextCaseResult {
  prompt: string;
  expected: string;            // null-expected (decoy) cases are skipped — nothing to isolate
  isolation: Condition;        // only the expected skill loaded
  coLoaded: Condition;         // the whole library loaded (the real condition the audit uses)
  deltaP: number;              // coLoaded.pHat - isolation.pHat (negative = suppressed under load)
  fisherP: number;             // raw p that the isolation-vs-co-loaded difference is real
  /** Benjamini-Hochberg adjusted p across all trustworthy comparisons in this run — one Fisher
   * test per case is a FAMILY, and raw p<0.05 over a 40-case library expects ~2 false flags by
   * chance alone. Interference is decided on THIS value. (1 for untrustworthy cases.) */
  fisherPAdj: number;
  /** infra failures dominated one side — the comparison is not trustworthy (NOT a behavioral result) */
  untrustworthy: boolean;
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
}

export async function runContextAudit(
  cfg: Config,
  optsOrProgress: ContextOpts | ((e: ContextProgress) => void) = {},
): Promise<ContextAuditResult> {
  const opts: ContextOpts =
    typeof optsOrProgress === "function" ? { onProgress: optsOrProgress } : optsOrProgress;
  const onProgress = opts.onProgress;
  const adapter = getAdapter(cfg.runtime);
  const library = listSkills(cfg.cwd);
  const present = new Set(library.map((s) => s.name));

  const measured: ContextCaseResult[] = [];
  const skipped: string[] = [];
  let totalCost = 0;

  // decoys (null expected) have nothing to isolate → skipped. An expected skill that ISN'T in the
  // library is almost always a config typo: fail loud BEFORE spending probes, never silently skip.
  const eligible: typeof cfg.cases = [];
  const unknown: string[] = [];
  for (const c of cfg.cases) {
    if (c.expected === null) skipped.push(c.prompt);
    else if (!present.has(c.expected)) unknown.push(c.expected);
    else eligible.push(c);
  }
  if (unknown.length) {
    throw new ConfigError([
      `expected skill(s) not in ${cfg.cwd}/.claude/skills/: ${[...new Set(unknown)].join(", ")} ` +
      `(typo?). Available: ${library.map((s) => s.name).join(", ") || "(none)"}.`,
    ]);
  }

  const common = { maxK: cfg.k, threshold: cfg.threshold, conf: cfg.conf, ...(cfg.model ? { model: cfg.model } : {}) };
  for (let i = 0; i < eligible.length; i++) {
    const c = eligible[i]!;
    const expected = c.expected!;

    // isolation: a temp project containing only this skill
    const ctx = buildContextDir(cfg.cwd, [expected]);
    let iso: RunStats;
    try {
      iso = await measure(adapter, c.prompt, expected, {
        cwd: ctx.cwd, ...common,
        ...(onProgress ? { onProbe: (validN, maxK) => onProgress({ caseIndex: i + 1, caseTotal: eligible.length, prompt: c.prompt, condition: "isolation", validN, maxK }) } : {}),
      });
    } finally {
      ctx.cleanup();
    }

    // co-loaded: the real library at cfg.cwd
    const co = await measure(adapter, c.prompt, expected, {
      cwd: cfg.cwd, ...common,
      ...(onProgress ? { onProbe: (validN, maxK) => onProgress({ caseIndex: i + 1, caseTotal: eligible.length, prompt: c.prompt, condition: "co-loaded", validN, maxK }) } : {}),
    });

    totalCost += iso.totalCost + co.totalCost;
    const isoRel = reliability(iso.hits, iso.n, cfg.conf);
    const coRel = reliability(co.hits, co.n, cfg.conf);
    // 2x2: rows = isolation/co-loaded, cols = hit/miss
    const fisherP = (iso.n > 0 && co.n > 0)
      ? fisherExact2x2(iso.hits, iso.n - iso.hits, co.hits, co.n - co.hits)
      : 1;
    const deltaP = coRel.pHat - isoRel.pHat;
    // if infra failures dominated either side, the comparison isn't a behavioral result at all —
    // it must never read as "no interference / pass" just because fisherP defaulted to 1.
    const untrustworthy = infraUntrustworthy(iso) || infraUntrustworthy(co);

    // interference is decided AFTER the loop, once the whole family of comparisons is known
    // (Benjamini-Hochberg) — placeholders here.
    measured.push({
      prompt: c.prompt, expected,
      isolation: { stats: iso, rel: isoRel },
      coLoaded: { stats: co, rel: coRel },
      deltaP, fisherP, fisherPAdj: 1, untrustworthy, interference: false,
    });
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
    const libraryNames = library.map((s) => s.name);
    const flagged = measured.filter((m) => m.interference);
    const cap = opts.suspects ?? 3;
    const allRuns: AblationResult[] = [];
    for (let fi = 0; fi < flagged.length; fi++) {
      const m = flagged[fi]!;
      const suspects = Object.entries(m.coLoaded.stats.dist)
        .filter(([name]) => name !== m.expected && name !== "None")
        .sort((x, y) => y[1] - x[1])
        .slice(0, cap);
      m.ablation = [];
      for (const [suspect, stolen] of suspects) {
        const ctx = buildContextDir(cfg.cwd, libraryNames.filter((n) => n !== suspect));
        let st: RunStats;
        try {
          st = await measure(adapter, m.prompt, m.expected, {
            cwd: ctx.cwd, ...common,
            ...(onProgress ? { onProbe: (validN, maxK) => onProgress({ caseIndex: fi + 1, caseTotal: flagged.length, prompt: m.prompt, condition: "ablation", removed: suspect, validN, maxK }) } : {}),
          });
        } finally {
          ctx.cleanup();
        }
        totalCost += st.totalCost;
        const rel = reliability(st.hits, st.n, cfg.conf);
        const co = m.coLoaded.stats;
        const fisherP = (st.n > 0 && co.n > 0)
          ? fisherExact2x2(st.hits, st.n - st.hits, co.hits, co.n - co.hits)
          : 1;
        const abl: AblationResult = {
          removed: suspect, stolen, stats: st, rel,
          deltaVsCoLoaded: rel.pHat - m.coLoaded.rel.pHat,
          fisherP, fisherPAdj: 1,
          untrustworthy: infraUntrustworthy(st),
          culprit: false,
        };
        m.ablation.push(abl);
        allRuns.push(abl);
      }
    }
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

  return {
    runtime: cfg.runtime, model: cfg.model ?? "(runtime default)",
    threshold: cfg.threshold, conf: cfg.conf, librarySize: library.length,
    cases: measured, skipped, totalCost, exitCode,
  };
}
