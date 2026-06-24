/** `skill-probe diagnose` — when a skill fails to fire, WHY? Two very different root causes need
 * two very different fixes, and you can't tell them apart from the activation rate alone:
 *
 *   - DESCRIPTION PROBLEM: the model, asked point-blank "which skill handles this?", doesn't even
 *     pick the expected skill. Its description fails to communicate what it's for. Remedy: rewrite
 *     the description (`skill-probe fix`).
 *   - ROUTING MISS: the model DOES pick the expected skill when asked — it understands the
 *     description — but a sibling wins at actual activation time. Remedy: deconflict the sibling /
 *     inspect with `skill-probe context`. Rewriting this skill's description won't help.
 *
 * We measure ACTUAL activation (the real runtime probe) and INTENDED routing (a forced-choice: the
 * model is shown the skill descriptions and asked which one applies, with no auto-execution), then
 * classify the gap between them. */
import type { Config } from "./types.ts";
import { reliability, sequentialDecision } from "./stats.ts";
import { measure, infraUntrustworthy, type RunStats } from "./orchestrator.ts";
import { getAdapter } from "./adapters/index.ts";
import { listSkills, type SkillInfo } from "./gen.ts";
import { complete } from "./llm.ts";
import { ConfigError } from "./config.ts";

export type DiagVerdict = "routes-ok" | "routing-miss" | "description-problem" | "inconclusive" | "error";

/** Returns the chosen skill name, "none", or null when the answer is unusable (LLM error/garbage). */
export type ChoiceFn = (skills: SkillInfo[], prompt: string, model?: string) => Promise<string | null>;

type Rel = ReturnType<typeof reliability>;
interface IntendedStats { dist: Record<string, number>; hits: number; n: number; errors: number }

export interface DiagCaseResult {
  prompt: string;
  expected: string;
  actual: { stats: RunStats; rel: Rel };
  intended: { stats: IntendedStats; rel: Rel };
  verdict: DiagVerdict;
  /** the sibling that wins activation in a routing-miss (most-fired non-expected skill), if any */
  competitor: string | null;
  remedy: string;
}

export interface DiagnoseResult {
  runtime: string;
  model: string;
  threshold: number;
  conf: number;
  cases: DiagCaseResult[];
  skipped: string[];
  totalCost: number;
  exitCode: 0 | 1 | 2;
}

export interface DiagProgress {
  caseIndex: number; caseTotal: number; prompt: string;
  phase: "actual" | "intended"; validN: number; maxK: number;
}

const ROUTER_SYSTEM =
  "You are a skill router. Given a user request and a list of available skills (name + " +
  "description), decide which single skill should handle the request. Reply with EXACTLY one skill " +
  "name from the list, or the word none if no skill fits. Output only that one word — no punctuation, " +
  "no explanation.";

export function normalizeChoice(text: string, skills: SkillInfo[]): string | null {
  const lower = text.trim().toLowerCase();
  // detect "no skill" answers on the raw text, before punctuation is stripped (so "n/a" survives)
  if (/^(none|null|no skill|no-skill|n\/a|n\.a\.?)$/.test(lower)) return "None";
  const t = lower.replace(/[^a-z0-9_\-\s]/g, "").trim();
  if (!t) return null;
  for (const s of skills) if (t === s.name.toLowerCase()) return s.name;
  // tolerate "the greeter skill" / "use greeter" by substring match on a known name
  for (const s of skills) if (new RegExp(`\\b${s.name.toLowerCase()}\\b`).test(t)) return s.name;
  if (/\bnone\b/.test(t)) return "None";
  return null;
}

export const defaultChoice: ChoiceFn = async (skills, prompt, model) => {
  const list = skills.map((s) => `- ${s.name}: ${s.description}`).join("\n");
  const user = `Available skills:\n${list}\n\nUser request: "${prompt}"\n\n` +
    `Which ONE skill should handle this request? Reply with exactly one skill name, or "none".`;
  let text: string;
  try { text = await complete(ROUTER_SYSTEM, user, { ...(model ? { model } : {}), maxTokens: 16 }); }
  catch { return null; }
  return normalizeChoice(text, skills);
};

async function measureIntended(
  skills: SkillInfo[], prompt: string, expected: string,
  o: { maxK: number; threshold: number; conf: number; choice: ChoiceFn; model?: string; onProbe?: (n: number, k: number) => void },
): Promise<IntendedStats> {
  const dist: Record<string, number> = {};
  let hits = 0, n = 0, errors = 0;
  const maxAttempts = o.maxK + Math.ceil(o.maxK / 2);
  for (let a = 0; a < maxAttempts && n < o.maxK; a++) {
    const c = await o.choice(skills, prompt, o.model);
    if (c === null) { errors++; o.onProbe?.(n, o.maxK); continue; }
    dist[c] = (dist[c] ?? 0) + 1;
    if (c === expected) hits++;
    n++;
    o.onProbe?.(n, o.maxK);
    if (n >= 3 && sequentialDecision(hits, n, o.threshold, o.conf) !== "undecided") break;
  }
  return { dist, hits, n, errors };
}

function classify(
  actual: RunStats, actualRel: Rel, intended: IntendedStats, expected: string,
  threshold: number, conf: number,
): { verdict: DiagVerdict; competitor: string | null; remedy: string } {
  const competitor = Object.entries(actual.dist)
    .filter(([s]) => s !== expected && s !== "None")
    .sort((p, q) => q[1] - p[1])[0]?.[0] ?? null;

  if (infraUntrustworthy(actual) || intended.n === 0) {
    return { verdict: "error", competitor,
      remedy: "infrastructure/LLM errors dominated — rerun; the result isn't trustworthy." };
  }
  const actualDecision = sequentialDecision(actual.hits, actual.n, threshold, conf);
  if (actualDecision === "above") {
    // actual is the ground truth. But if the forced-choice router rarely picks it, the description
    // reads ambiguously in isolation — a leading indicator that activation may be fragile.
    const ambiguous = sequentialDecision(intended.hits, intended.n, threshold, conf) === "below";
    const note = ambiguous
      ? ` — but the description reads ambiguously in isolation (intended only ${Math.round((intended.hits / intended.n) * 100)}%), ` +
        `so activation may be fragile across models/contexts`
      : "";
    return { verdict: "routes-ok", competitor: null,
      remedy: `fires reliably (${Math.round(actualRel.pHat * 100)}%) — no action needed${note}.` };
  }
  const intendedDecision = sequentialDecision(intended.hits, intended.n, threshold, conf);
  if (intendedDecision === "above") {
    return { verdict: "routing-miss", competitor,
      remedy: `the model picks "${expected}" when asked, but ${competitor ? `"${competitor}"` : "another skill"} ` +
        `wins at activation. Remedy: deconflict the sibling (narrow its description) or inspect with ` +
        `\`skill-probe context\`. Rewriting "${expected}" likely won't help.` };
  }
  if (intendedDecision === "below") {
    return { verdict: "description-problem", competitor,
      remedy: `the model doesn't recognize "${expected}" applies to this request. Remedy: ` +
        `\`skill-probe fix --skill ${expected}\` to rewrite its trigger description.` };
  }
  return { verdict: "inconclusive", competitor,
    remedy: "neither activation nor intent is statistically decided — raise k and rerun." };
}

export async function runDiagnose(
  cfg: Config,
  deps: { choice?: ChoiceFn; onProgress?: (e: DiagProgress) => void } = {},
): Promise<DiagnoseResult> {
  const adapter = getAdapter(cfg.runtime);
  const choice = deps.choice ?? defaultChoice;
  const skills = listSkills(cfg.cwd);
  const present = new Set(skills.map((s) => s.name));

  const skipped: string[] = [];
  const unknown: string[] = [];
  const eligible: typeof cfg.cases = [];
  for (const c of cfg.cases) {
    if (c.expected === null) skipped.push(c.prompt);
    else if (!present.has(c.expected)) unknown.push(c.expected);
    else eligible.push(c);
  }
  if (unknown.length) {
    throw new ConfigError([
      `expected skill(s) not in ${cfg.cwd}/.claude/skills/: ${[...new Set(unknown)].join(", ")} ` +
      `(typo?). Available: ${skills.map((s) => s.name).join(", ") || "(none)"}.`,
    ]);
  }

  const cases: DiagCaseResult[] = [];
  let totalCost = 0;
  for (let i = 0; i < eligible.length; i++) {
    const c = eligible[i]!;
    const expected = c.expected!;
    const actual = await measure(adapter, c.prompt, expected, {
      cwd: cfg.cwd, maxK: cfg.k, threshold: cfg.threshold, conf: cfg.conf,
      ...(cfg.model ? { model: cfg.model } : {}),
      ...(deps.onProgress ? { onProbe: (validN, maxK) => deps.onProgress!({ caseIndex: i + 1, caseTotal: eligible.length, prompt: c.prompt, phase: "actual", validN, maxK }) } : {}),
    });
    const intended = await measureIntended(skills, c.prompt, expected, {
      maxK: cfg.k, threshold: cfg.threshold, conf: cfg.conf, choice,
      ...(cfg.model ? { model: cfg.model } : {}),
      ...(deps.onProgress ? { onProbe: (validN, maxK) => deps.onProgress!({ caseIndex: i + 1, caseTotal: eligible.length, prompt: c.prompt, phase: "intended", validN, maxK }) } : {}),
    });
    totalCost += actual.totalCost;
    const actualRel = reliability(actual.hits, actual.n, cfg.conf);
    const intendedRel = reliability(intended.hits, intended.n, cfg.conf);
    const { verdict, competitor, remedy } = classify(actual, actualRel, intended, expected, cfg.threshold, cfg.conf);
    cases.push({
      prompt: c.prompt, expected,
      actual: { stats: actual, rel: actualRel },
      intended: { stats: intended, rel: intendedRel },
      verdict, competitor, remedy,
    });
  }

  const hasProblem = cases.some((c) => c.verdict === "routing-miss" || c.verdict === "description-problem");
  const hasBad = cases.some((c) => c.verdict === "error" || c.verdict === "inconclusive");
  const exitCode: 0 | 1 | 2 = hasProblem ? 1 : hasBad ? 2 : 0;

  return {
    runtime: cfg.runtime, model: cfg.model ?? "(runtime default)",
    threshold: cfg.threshold, conf: cfg.conf, cases, skipped, totalCost, exitCode,
  };
}
