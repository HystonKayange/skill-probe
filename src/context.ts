/** `skill-probe context` — activation-rate-BY-CONTEXT. The audit measures every skill co-loaded
 * (the real, hard condition). This command additionally measures each skill in ISOLATION (only that
 * skill present) and compares the two: it catches the "fires fine alone, fails under load" case that
 * a single aggregate rate hides. The drop is tested with Fisher's exact test, so interference is
 * reported as a real effect (p-value), not eyeballed. */
import { mkdtempSync, mkdirSync, cpSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "./types.ts";
import { reliability, fisherExact2x2 } from "./stats.ts";
import { measure, type RunStats } from "./orchestrator.ts";
import { getAdapter } from "./adapters/index.ts";
import { listSkills } from "./gen.ts";

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

export interface ContextCaseResult {
  prompt: string;
  expected: string;            // null-expected (decoy) cases are skipped — nothing to isolate
  isolation: Condition;        // only the expected skill loaded
  coLoaded: Condition;         // the whole library loaded (the real condition the audit uses)
  deltaP: number;              // coLoaded.pHat - isolation.pHat (negative = suppressed under load)
  fisherP: number;             // p that the isolation-vs-co-loaded difference is real
  /** fires reliably alone but drops significantly when the full library is co-loaded */
  interference: boolean;
}

export interface ContextAuditResult {
  runtime: string;
  model: string;
  threshold: number;
  conf: number;
  librarySize: number;         // skills present in the full (co-loaded) library
  cases: ContextCaseResult[];
  skipped: string[];           // prompts skipped (null expected)
  totalCost: number;
  /** 0 = no interference detected; 1 = at least one skill is suppressed under load */
  exitCode: 0 | 1;
}

export interface ContextProgress {
  caseIndex: number; caseTotal: number; prompt: string;
  condition: "isolation" | "co-loaded"; validN: number; maxK: number;
}

export async function runContextAudit(
  cfg: Config,
  onProgress?: (e: ContextProgress) => void,
): Promise<ContextAuditResult> {
  const adapter = getAdapter(cfg.runtime);
  const library = listSkills(cfg.cwd);
  const present = new Set(library.map((s) => s.name));

  const measured: ContextCaseResult[] = [];
  const skipped: string[] = [];
  let totalCost = 0;

  // only cases with a concrete expected skill that actually exists can be isolated
  const eligible = cfg.cases.filter((c) => c.expected !== null && present.has(c.expected));
  for (const c of cfg.cases) {
    if (c.expected === null || !present.has(c.expected)) skipped.push(c.prompt);
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
    const interference =
      iso.n > 0 && co.n > 0 &&
      isoRel.pHat >= cfg.threshold &&  // fires reliably alone
      deltaP < 0 &&                    // and drops when co-loaded
      fisherP < 0.05;                  // and the drop is statistically real

    measured.push({
      prompt: c.prompt, expected,
      isolation: { stats: iso, rel: isoRel },
      coLoaded: { stats: co, rel: coRel },
      deltaP, fisherP, interference,
    });
  }

  return {
    runtime: cfg.runtime, model: cfg.model ?? "(runtime default)",
    threshold: cfg.threshold, conf: cfg.conf, librarySize: library.length,
    cases: measured, skipped, totalCost,
    exitCode: measured.some((m) => m.interference) ? 1 : 0,
  };
}
