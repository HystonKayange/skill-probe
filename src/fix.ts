/** `skill-probe fix` — rewrite a failing skill's description, then PROVE the lift is real with
 * the Bayesian Beta-Binomial (not "it looks better"). Upgrades on the Python prototype:
 *  - INTERLEAVED before/after (old desc -> probe -> new desc -> probe, paired) controls for
 *    session drift at the same probe cost as block-wise.
 *  - COLLISION-AWARE rewrite: the LLM is told sibling descriptions so it won't steal triggers.
 *  - Applies the new description only if P(improvement) >= bar AND the effect is positive;
 *    otherwise reverts. Original is always backed up to SKILL.md.bak. */
import { readFileSync, writeFileSync, existsSync, readdirSync, copyFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./types.ts";
import { getAdapter } from "./adapters/index.ts";
import { probImprovement, reliability } from "./stats.ts";
import { complete } from "./llm.ts";

const DESC_RE = /^description:\s*(.*)$/m;

function skillFile(cfg: Config, name: string): string {
  return join(cfg.cwd, ".claude", "skills", name, "SKILL.md");
}

export function readDesc(file: string): string {
  const m = DESC_RE.exec(readFileSync(file, "utf8"));
  if (!m) throw new Error(`no single-line 'description:' found in ${file} (multi-line block scalars not yet supported)`);
  return m[1]!.trim();
}

/** Replace only the single-line description; backups are handled explicitly in runFix (not here,
 * because the interleaved loop calls this many times and must not snapshot intermediate states). */
export function writeDesc(file: string, desc: string): void {
  const txt = readFileSync(file, "utf8");
  writeFileSync(file, txt.replace(DESC_RE, `description: ${desc}`));
}

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
  n: number;       // completed (non-errored) interleaved pairs
  errors: number;  // pairs dropped due to an infra error on either side
  applied: boolean;
  applyBar: number;
  /** path of the kept backup (only when applied); null when reverted (no change made) */
  backupPath: string | null;
}

export interface FixOpts { skill: string; k: number; applyBar: number; model?: string }
export interface FixDeps {
  rewrite?: (skill: string, cur: string, prompts: string[], siblings: Sibling[], model?: string) => Promise<string>;
}

export async function runFix(cfg: Config, opts: FixOpts, deps: FixDeps = {}): Promise<FixResult> {
  const adapter = getAdapter(cfg.runtime);
  const file = skillFile(cfg, opts.skill);
  if (!existsSync(file)) throw new Error(`skill not found: ${file}`);

  const root = join(cfg.cwd, ".claude", "skills");
  const siblings: Sibling[] = readdirSync(root)
    .filter((n) => n !== opts.skill && existsSync(join(root, n, "SKILL.md")))
    .map((n) => ({ name: n, desc: readDesc(join(root, n, "SKILL.md")) }));

  const prompts = cfg.cases.filter((c) => c.expected === opts.skill).map((c) => c.prompt);
  if (prompts.length === 0) throw new Error(`no cases in the config expect skill '${opts.skill}'`);

  const oldDesc = readDesc(file);
  const rewrite = deps.rewrite ?? defaultRewrite;
  const newDesc = await rewrite(opts.skill, oldDesc, prompts, siblings, opts.model);

  // Snapshot the EXACT pre-fix file once, to a unique path (never clobber a prior run's backup).
  const backupPath = backupPathFor(file);
  copyFileSync(file, backupPath);

  const probeWith = async (desc: string, prompt: string) => {
    writeDesc(file, desc);
    return adapter.probe(prompt, { cwd: cfg.cwd, ...(cfg.model ? { model: cfg.model } : {}) });
  };

  let beforeHits = 0, afterHits = 0, n = 0, errors = 0;
  try {
    for (let i = 0; i < opts.k; i++) {
      for (const p of prompts) {
        const rb = await probeWith(oldDesc, p);
        const ra = await probeWith(newDesc, p);
        if (rb.status === "error" || ra.status === "error") { errors++; continue; } // drop incomplete pair
        if (rb.skillFired === opts.skill) beforeHits++;
        if (ra.skillFired === opts.skill) afterHits++;
        n++;
      }
    }
    const imp = probImprovement(beforeHits, n, afterHits, n);
    const applied = n > 0 && imp.pImprove >= opts.applyBar && imp.deltaMean > 0;
    if (applied) {
      writeDesc(file, newDesc);          // commit; keep the timestamped backup
    } else {
      copyFileSync(backupPath, file);    // restore exact original
      unlinkSync(backupPath);            // no change made -> don't leave a redundant backup
    }
    return {
      skill: opts.skill, oldDesc, newDesc,
      before: reliability(beforeHits, n), after: reliability(afterHits, n),
      pImprove: imp.pImprove, deltaMean: imp.deltaMean, deltaCi: imp.deltaCi,
      n, errors, applied, applyBar: opts.applyBar,
      backupPath: applied ? backupPath : null,
    };
  } catch (e) {
    copyFileSync(backupPath, file);      // restore exact pre-fix file on any error
    unlinkSync(backupPath);
    throw e;
  }
}
