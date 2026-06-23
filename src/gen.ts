/** `skill-probe gen` — draft a test config from the skills in a project. The skill descriptions
 * already say what each skill is for, so an LLM can propose realistic should-fire prompts,
 * cross-skill near-misses (to surface mis-routing), and decoys. ALWAYS human-reviewed before use
 * (the generator tends toward obvious keyword-matches; you add the messy real-world phrasings). */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Config, EvalCase } from "./types.ts";
import { complete } from "./llm.ts";

const DESC_RE = /^description:\s*(.*)$/m;

export interface SkillInfo { name: string; description: string; }

export function listSkills(cwd: string): SkillInfo[] {
  const root = join(cwd, ".claude", "skills");
  if (!existsSync(root)) throw new Error(`no .claude/skills/ directory under ${cwd}`);
  const skills: SkillInfo[] = [];
  for (const name of readdirSync(root)) {
    const file = join(root, name, "SKILL.md");
    if (!existsSync(file)) continue;
    const m = DESC_RE.exec(readFileSync(file, "utf8"));
    skills.push({ name, description: m ? m[1]!.trim() : "" });
  }
  return skills;
}

export interface GenOpts { perSkill: number; decoys: number; model?: string }
/** A raw, untrusted candidate from a generator — sanitized by generateCases(). */
export interface RawCase { prompt?: unknown; expected?: unknown }
export interface GenDeps {
  generate?: (skills: SkillInfo[], opts: GenOpts) => Promise<RawCase[]>;
}

export async function defaultGenerate(skills: SkillInfo[], opts: GenOpts): Promise<RawCase[]> {
  const list = skills.map((s) => `- ${s.name}: ${s.description}`).join("\n");
  const sys = "You build a TEST SUITE that audits whether an AI coding agent loads the correct "
    + "skill for a user's prompt. Output ONLY a JSON array, no prose.";
  const user =
    `Skills available (name: description):\n${list}\n\n`
    + `Produce a JSON array of {"prompt": string, "expected": string|null}:\n`
    + `- For EACH skill, ${opts.perSkill} realistic user prompts that SHOULD load it. Vary the `
    + `phrasing — direct, oblique/indirect, terse, and with surrounding context. Do NOT just echo `
    + `the description's keywords; write how real users actually type.\n`
    + `- Where two skills overlap, add a few NEAR-MISS prompts in the gray zone, with "expected" `
    + `set to the single most-appropriate skill (these surface mis-routing / trigger-theft).\n`
    + `- ${opts.decoys} DECOY prompts that match NO skill, each with "expected": null.\n`
    + `"expected" MUST be exactly one of the skill names above, or null. Return ONLY the JSON array.`;
  const raw = await complete(sys, user, opts.model ? { model: opts.model, maxTokens: 2000 } : { maxTokens: 2000 });
  const m = raw.match(/\[[\s\S]*\]/);
  if (!m) throw new Error("generator did not return a JSON array");
  return JSON.parse(m[0]) as RawCase[];
}

/** Runs a generator, then SANITIZES its output (applies to any generator, not just the LLM one):
 * keep entries with a non-empty prompt and an `expected` that is a real skill name or null —
 * dropping hallucinated skill names. */
export async function generateCases(
  skills: SkillInfo[], opts: GenOpts, deps: GenDeps = {},
): Promise<EvalCase[]> {
  const raw = await (deps.generate ?? defaultGenerate)(skills, opts);
  const names = new Set(skills.map((s) => s.name));
  const cases: EvalCase[] = [];
  for (const c of raw) {
    if (typeof c?.prompt !== "string" || !c.prompt) continue;
    const exp = c.expected;
    if (exp === null || exp === undefined) cases.push({ prompt: c.prompt, expected: null });
    else if (typeof exp === "string" && names.has(exp)) cases.push({ prompt: c.prompt, expected: exp });
  }
  return cases;
}

/** Wrap generated cases in a ready-to-run config with sensible defaults. */
export function genConfig(cases: EvalCase[]): Config {
  return { runtime: "claude-code", cwd: ".", k: 10, threshold: 0.7, conf: 0.95, cases };
}
