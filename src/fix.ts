/** `skill-probe fix` — rewrite a failing skill's description, then PROVE the lift is real with
 * the Bayesian Beta-Binomial (not "it looks better"). Upgrades on the Python prototype:
 *  - PAIRED before/after: two identical sandboxes of the library, one with the old description and
 *    one with the new; each pair of probes runs at the same moment, so session/model drift hits
 *    both arms equally.
 *  - COLLISION-AWARE rewrite: the LLM is told sibling descriptions so it won't steal triggers.
 *  - The real SKILL.md is never touched during the experiment (an interrupted run can't leave it
 *    half-edited). The new description is written once, at the end, only if P(improvement) >= bar
 *    AND the effect is positive AND the file hasn't changed on disk since the run started — with
 *    the exact original snapshotted to a timestamped backup first. */
import { readFileSync, writeFileSync, existsSync, copyFileSync, rmSync } from "node:fs";
import { type Config, probeSettings } from "./types.ts";
import { getAdapter } from "./adapters/index.ts";
import { probImprovement, reliability } from "./stats.ts";
import { complete } from "./llm.ts";
import { mapPool, type Budget } from "./orchestrator.ts";
import { listSkills, parseFrontmatter, replaceDescription, normalizeDescription, skillFile } from "./skills.ts";
import { buildSandbox } from "./sandbox.ts";

/** Unique per-run snapshot path, never clobbering a prior run's backup. */
function backupPathFor(file: string): string {
  const base = `${file}.bak.${Date.now()}`;
  let p = base, i = 1;
  while (existsSync(p)) p = `${base}-${i++}`;
  return p;
}

export interface Sibling { name: string; desc: string; }

export async function defaultRewrite(
  skill: string, cur: string, prompts: string[], siblings: Sibling[], model?: string,
): Promise<string> {
  const sib = siblings.length ? siblings.map((s) => `- ${s.name}: "${s.desc}"`).join("\n") : "(none)";
  const sys = "You optimize Agent Skill trigger descriptions. The description is the routing signal a "
    + "model reads to decide whether to load the skill. Return ONLY the new one-line description — no "
    + "quotes, no preamble, no trailing notes.";
  const user = `Skill \`${skill}\` current description:\n${cur}\n\n`
    + `It FAILS to reliably trigger on these user phrasings:\n${prompts.map((p) => `- "${p}"`).join("\n")}\n\n`
    + `Rewrite the description so it reliably triggers on those AND similar phrasings, front-loading `
    + `trigger keywords. CRITICAL: do NOT overlap with these sibling skills — you must not start `
    + `stealing their triggers:\n${sib}\n\nKeep it ONE sentence.`;
  const out = await complete(sys, user, model ? { model, maxTokens: 300 } : { maxTokens: 300 });
  return out.replace(/^["']+|["']+$/g, "").trim();
}

export interface FixResult {
  skill: string;
  oldDesc: string;
  newDesc: string;
  before: ReturnType<typeof reliability>;
  after: ReturnType<typeof reliability>;
  pImprove: number;
  deltaMean: number;
  deltaCi: [number, number];
  n: number;       // completed (non-errored) paired runs
  errors: number;  // pairs dropped due to an infra error on either side
  applied: boolean;
  applyBar: number;
  /** path of the kept backup (only when applied); null when nothing was written */
  backupPath: string | null;
  /** why the rewrite wasn't tested or applied, beyond the statistics */
  note?: string;
  totalCost: number;
}

export interface FixOpts {
  skill: string; k: number; applyBar: number; model?: string;
  /** paired runs in flight at once (each pair is 2 probes; default 1) */
  concurrency?: number;
  budget?: Budget;
}
export interface FixDeps {
  rewrite?: (skill: string, cur: string, prompts: string[], siblings: Sibling[], model?: string) => Promise<string>;
}

export async function runFix(cfg: Config, opts: FixOpts, deps: FixDeps = {}): Promise<FixResult> {
  const adapter = getAdapter(cfg.runtime);
  const file = skillFile(cfg.cwd, opts.skill);
  if (!existsSync(file)) throw new Error(`skill not found: ${file}`);

  const library = listSkills(cfg.cwd);
  const siblings: Sibling[] = library
    .filter((s) => s.name !== opts.skill)
    .map((s) => ({ name: s.name, desc: s.description }));

  const prompts = cfg.cases.filter((c) => c.expected === opts.skill).map((c) => c.prompt);
  if (prompts.length === 0) throw new Error(`no cases in the config expect skill '${opts.skill}'`);

  const original = readFileSync(file, "utf8");
  const fm = parseFrontmatter(original);
  if (!fm.ok) throw new Error(`${file} has no \`---\` frontmatter block — can't rewrite its description`);
  const oldDesc = normalizeDescription(fm.fields["description"] ?? "");
  replaceDescription(original, oldDesc || "x"); // throws now (before paying for a rewrite) if it can't be rewritten
  const rewrite = deps.rewrite ?? defaultRewrite;
  const newDesc = normalizeDescription(await rewrite(opts.skill, oldDesc, prompts, siblings, opts.model));

  const base = {
    skill: opts.skill, oldDesc, newDesc, applyBar: opts.applyBar,
    before: reliability(0, 0), after: reliability(0, 0),
    pImprove: 0, deltaMean: 0, deltaCi: [0, 0] as [number, number],
    n: 0, errors: 0, applied: false, backupPath: null, totalCost: 0,
  };
  if (!newDesc) return { ...base, note: "the rewrite came back empty — nothing to test" };
  if (newDesc === oldDesc) return { ...base, note: "the rewrite is identical to the current description — nothing to test" };

  const names = library.map((s) => s.name);
  const beforeBox = buildSandbox(cfg.cwd, names); // holds the exact original SKILL.md
  const afterBox = buildSandbox(cfg.cwd, names);
  let beforeHits = 0, afterHits = 0, n = 0, errors = 0, totalCost = 0;
  try {
    const afterFile = skillFile(afterBox.cwd, opts.skill);
    rmSync(afterFile, { force: true }); // a fresh file — never write through a link into the real library
    writeFileSync(afterFile, replaceDescription(original, newDesc));
    const settings = probeSettings(cfg);
    const jobs = Array.from({ length: opts.k }, () => prompts).flat();
    await mapPool(jobs, opts.concurrency ?? 1, async (p) => {
      if (opts.budget?.exhausted) { errors++; return; }
      const [rb, ra] = await Promise.all([
        adapter.probe(p, { cwd: beforeBox.cwd, ...settings }),
        adapter.probe(p, { cwd: afterBox.cwd, ...settings }),
      ]);
      totalCost += rb.cost + ra.cost;
      opts.budget?.add(rb.cost + ra.cost);
      if (rb.status === "error" || ra.status === "error") { errors++; return; } // drop incomplete pair
      if (rb.skillFired === opts.skill) beforeHits++;
      if (ra.skillFired === opts.skill) afterHits++;
      n++;
    });
  } finally {
    beforeBox.cleanup();
    afterBox.cleanup();
  }

  const imp = probImprovement(beforeHits, n, afterHits, n);
  const result: FixResult = {
    ...base,
    before: reliability(beforeHits, n), after: reliability(afterHits, n),
    pImprove: imp.pImprove, deltaMean: imp.deltaMean, deltaCi: imp.deltaCi,
    n, errors, totalCost,
  };
  if (!(n > 0 && imp.pImprove >= opts.applyBar && imp.deltaMean > 0)) return result;

  // commit: only if the file is exactly what we measured against (someone may have edited it)
  if (readFileSync(file, "utf8") !== original) {
    return { ...result, note: `${file} changed on disk during the run — not overwriting it; re-run fix` };
  }
  const backupPath = backupPathFor(file);
  copyFileSync(file, backupPath);
  writeFileSync(file, replaceDescription(original, newDesc));
  return { ...result, applied: true, backupPath };
}
