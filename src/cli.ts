#!/usr/bin/env node
/** skill-probe CLI.
 *   skill-probe --config <f>                  audit a co-loaded skill library
 *   skill-probe fix --config <f> --skill <n>  rewrite a skill's description & prove the lift
 * Exit: 0 = pass/applied, 1 = behavioral fail/reverted, 2 = inconclusive/infra error/usage. */
import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { runAudit, type ProgressEvent } from "./eval.ts";
import { runFix } from "./fix.ts";
import { listSkills, generateCases, genConfig } from "./gen.ts";
import { loadConfig, parseProbability, parseIntFlag, ConfigError } from "./config.ts";
import { renderTable, renderMarkdown, renderJson, renderFix } from "./report.ts";

const HELP = `skill-probe — audit a co-loaded agent skill library by real activation behavior.

USAGE
  skill-probe --config <file.json> [options]                 # audit
  skill-probe gen [--cwd <dir>] > probe.config.json          # draft a test config from your skills
  skill-probe fix --config <file.json> --skill <name> [opts] # rewrite a description, prove the lift

OPTIONS
  -c, --config <file>      JSON config { cwd, cases:[{prompt,expected}], ... } (required).
                           Relative cwd resolves against the CONFIG FILE's directory.
      --runtime <name>     claude-code | opencode (default: claude-code)
      --model <id>         pin the model (e.g. claude-sonnet-4-6 or anthropic/claude-haiku-4-5).
                           Recorded in the report — REQUIRED for a fair cross-runtime comparison.
      --k <n>              max VALID repeats per prompt (positive integer; default 10)
      --threshold <p>      min acceptable reliability, strictly 0..1 (default 0.7 = smoke test)
      --conf <p>           confidence level: 0.9 | 0.95 | 0.99 (default 0.95)
      --json               emit JSON instead of a table
      --markdown           emit a Markdown table (paste into a PR/README)
      --no-cost            hide the cost line (e.g. when on a Claude subscription)
      --quiet              suppress the live progress line on stderr
  gen only (uses ANTHROPIC_API_KEY if set, else the logged-in 'claude' CLI):
      --cwd <dir>          project dir containing .claude/skills/ (default: .)
      --per-skill <n>      should-fire prompts to draft per skill (default 3)
      --decoys <n>         off-topic decoy prompts to draft (default 2)
  fix only:
      --skill <name>       the skill whose description to rewrite (uses the config's cases for it)
      --apply-threshold <p> min P(improvement) to keep the rewrite (default 0.9)
  -h, --help               show this help

Reliability carries a Wilson CI + sample size k. fix rewrites the description, runs an INTERLEAVED
before/after, and applies it only if the Bayesian P(improvement) clears the apply-threshold.`;

let progressLen = 0;
function makeProgress(values: Record<string, unknown>): ((e: ProgressEvent) => void) | undefined {
  if (values["json"] || values["quiet"] || !process.stderr.isTTY) return undefined;
  return (e: ProgressEvent) => {
    const p = e.prompt.length > 32 ? e.prompt.slice(0, 29) + "…" : e.prompt;
    const line = `  probing [${e.caseIndex}/${e.caseTotal}] "${p}" — run ${e.validN}/${e.maxK}`;
    const pad = Math.max(0, progressLen - line.length);
    process.stderr.write("\r" + line + " ".repeat(pad));
    progressLen = line.length;
  };
}
function clearProgress(): void {
  if (progressLen) { process.stderr.write("\r" + " ".repeat(progressLen) + "\r"); progressLen = 0; }
}

async function audit(values: Record<string, unknown>): Promise<number> {
  const cfg = loadConfig(values["config"] as string, {
    runtime: values["runtime"] as string | undefined, model: values["model"] as string | undefined,
    k: values["k"] as string | undefined, threshold: values["threshold"] as string | undefined,
    conf: values["conf"] as string | undefined,
  });
  const result = await runAudit(cfg, makeProgress(values));
  clearProgress();
  const showCost = !values["no-cost"];
  const text = values["json"] ? renderJson(result)
    : values["markdown"] ? renderMarkdown(result, { showCost })
    : renderTable(result, { showCost });
  console.log(text);
  return result.exitCode;
}

async function gen(values: Record<string, unknown>): Promise<number> {
  const cwd = (values["cwd"] as string | undefined) ?? ".";
  const perSkill = parseIntFlag(values["per-skill"] as string | undefined, "--per-skill", 3, 1);
  const decoys = parseIntFlag(values["decoys"] as string | undefined, "--decoys", 2, 0);
  const skills = listSkills(resolve(cwd));
  if (skills.length === 0) {
    console.error(`no skills found under ${cwd}/.claude/skills/`);
    return 2;
  }
  const model = values["model"] as string | undefined;
  const cases = await generateCases(skills, {
    perSkill, decoys, ...(model ? { model } : {}),
  });
  console.log(renderJson(genConfig(cases)));
  console.error(`# drafted ${cases.length} cases for ${skills.length} skill(s) — REVIEW before ` +
    `running (add the messy/oblique phrasings the generator misses).`);
  return 0;
}

async function fix(values: Record<string, unknown>): Promise<number> {
  const skill = values["skill"] as string | undefined;
  if (!skill) { console.error("fix requires --skill <name>"); return 2; }
  const cfg = loadConfig(values["config"] as string, {
    runtime: values["runtime"] as string | undefined, model: values["model"] as string | undefined,
    k: values["k"] as string | undefined, conf: values["conf"] as string | undefined,
  });
  const applyBar = parseProbability(values["apply-threshold"] as string | undefined, "--apply-threshold", 0.9);
  const result = await runFix(cfg, { skill, k: cfg.k, applyBar, ...(cfg.model ? { model: cfg.model } : {}) });
  console.log(values["json"] ? renderJson(result) : renderFix(result));
  return result.applied ? 0 : 1;
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      config: { type: "string", short: "c" },
      runtime: { type: "string" },
      model: { type: "string" },
      k: { type: "string" },
      threshold: { type: "string" },
      conf: { type: "string" },
      skill: { type: "string" },
      "apply-threshold": { type: "string" },
      cwd: { type: "string" },
      "per-skill": { type: "string" },
      decoys: { type: "string" },
      json: { type: "boolean", default: false },
      markdown: { type: "boolean", default: false },
      "no-cost": { type: "boolean", default: false },
      quiet: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) {
    console.log(HELP);
    process.exit(0);
  }
  const cmd = positionals[0];
  let code: number;
  if (cmd === "gen") {
    code = await gen(values);
  } else {
    if (!values.config) { console.log(HELP); process.exit(2); }
    code = cmd === "fix" ? await fix(values) : await audit(values);
  }
  process.exit(code);
}

main().catch((e: unknown) => {
  if (e instanceof ConfigError) console.error(e.message);
  else console.error("skill-probe failed:", e instanceof Error ? e.message : e);
  process.exit(2);
});
