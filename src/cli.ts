#!/usr/bin/env node
/** skill-probe CLI.
 *   skill-probe --config <f>                  audit a co-loaded skill library
 *   skill-probe fix --config <f> --skill <n>  rewrite a skill's description & prove the lift
 * Exit: 0 = pass/applied, 1 = behavioral fail/reverted, 2 = inconclusive/infra error/usage. */
import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { runAudit, type ProgressEvent } from "./eval.ts";
import { runFix } from "./fix.ts";
import { runContextAudit, type ContextProgress } from "./context.ts";
import { runDiagnose, type DiagProgress } from "./diagnose.ts";
import { runDoctor } from "./doctor.ts";
import { listSkills, generateCases, genConfig } from "./gen.ts";
import { loadConfig, parseProbability, parseIntFlag, ConfigError } from "./config.ts";
import { loadBaseline, saveBaseline, compareToBaseline, type BaselineComparison } from "./baseline.ts";
import { renderTable, renderMarkdown, renderJson, renderFix, renderContext, renderDoctor, renderDiagnose, renderBaseline } from "./report.ts";

const HELP = `skill-probe — audit a co-loaded agent skill library by real activation behavior.

USAGE
  skill-probe --config <file.json> [options]                 # audit
  skill-probe context --config <file.json> [--ablate]        # isolation vs co-loaded activation rates
  skill-probe diagnose --config <file.json> [options]        # why a skill fails: routing-miss vs description
  skill-probe doctor [--cwd <dir>] [--config <file.json>]    # preflight: setup/auth/config sanity
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
  audit only (CI gating):
      --save-baseline <f>  after the run, save per-case counts + a run manifest to <f>
      --baseline <f>       compare this run against a saved baseline: per-case Fisher's exact,
                           Benjamini-Hochberg corrected — exit 1 ONLY on a significant regression
                           (noise passes; real drops fail)
  context only:
      --ablate             leave-one-out: for each interference case, re-run with each suspect
                           sibling removed and NAME the thief when activation recovers (Fisher +
                           Benjamini-Hochberg corrected)
      --suspects <n>       max siblings to ablate per case, ranked by probes stolen (default 3)
  doctor only:
      --cwd <dir>          project dir containing .claude/skills/ (default: .)
      --config <file>      also sanity-check a config (expected skills exist, k/threshold feasible)
      --skip-probe         don't run the harmless live probe (skip the auth check; no cost)
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

function makeContextProgress(values: Record<string, unknown>): ((e: ContextProgress) => void) | undefined {
  if (values["json"] || values["quiet"] || !process.stderr.isTTY) return undefined;
  return (e: ContextProgress) => {
    const p = e.prompt.length > 28 ? e.prompt.slice(0, 25) + "…" : e.prompt;
    const cond = e.condition === "ablation" ? `−${e.removed}` : e.condition;
    const line = `  [${e.caseIndex}/${e.caseTotal}] ${cond.padEnd(9)} "${p}" — run ${e.validN}/${e.maxK}`;
    const pad = Math.max(0, progressLen - line.length);
    process.stderr.write("\r" + line + " ".repeat(pad));
    progressLen = line.length;
  };
}

function makeDiagProgress(values: Record<string, unknown>): ((e: DiagProgress) => void) | undefined {
  if (values["json"] || values["quiet"] || !process.stderr.isTTY) return undefined;
  return (e: DiagProgress) => {
    const p = e.prompt.length > 28 ? e.prompt.slice(0, 25) + "…" : e.prompt;
    const line = `  [${e.caseIndex}/${e.caseTotal}] ${e.phase.padEnd(8)} "${p}" — run ${e.validN}/${e.maxK}`;
    const pad = Math.max(0, progressLen - line.length);
    process.stderr.write("\r" + line + " ".repeat(pad));
    progressLen = line.length;
  };
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

  let cmp: BaselineComparison | undefined;
  if (values["baseline"]) cmp = compareToBaseline(result, loadBaseline(values["baseline"] as string));
  if (values["save-baseline"]) {
    saveBaseline(result, values["save-baseline"] as string);
    console.error(`baseline saved to ${values["save-baseline"]}`);
  }

  const text = values["json"] ? renderJson(cmp ? { ...result, baseline: cmp } : result)
    : values["markdown"] ? renderMarkdown(result, { showCost }) + (cmp ? "\n\n" + renderBaseline(cmp) : "")
    : renderTable(result, { showCost }) + (cmp ? "\n\n" + renderBaseline(cmp) : "");
  console.log(text);
  // precedence mirrors the rest of the tool: a behavioral signal (fail/regression, 1) outranks
  // inconclusive/infra (2), which outranks clean (0).
  if (result.exitCode === 1 || cmp?.exitCode === 1) return 1;
  return result.exitCode;
}

async function diagnose(values: Record<string, unknown>): Promise<number> {
  const cfg = loadConfig(values["config"] as string, {
    runtime: values["runtime"] as string | undefined, model: values["model"] as string | undefined,
    k: values["k"] as string | undefined, threshold: values["threshold"] as string | undefined,
    conf: values["conf"] as string | undefined,
  });
  const result = await runDiagnose(cfg, {
    ...(makeDiagProgress(values) ? { onProgress: makeDiagProgress(values)! } : {}),
  });
  clearProgress();
  const showCost = !values["no-cost"];
  console.log(values["json"] ? renderJson(result) : renderDiagnose(result, { showCost }));
  return result.exitCode;
}

async function doctor(values: Record<string, unknown>): Promise<number> {
  const result = await runDoctor({
    cwd: (values["cwd"] as string | undefined) ?? ".",
    ...(values["config"] ? { configPath: values["config"] as string } : {}),
    ...(values["runtime"] ? { runtime: values["runtime"] as string } : {}),
    ...(values["model"] ? { model: values["model"] as string } : {}),
    ...(values["skip-probe"] ? { skipProbe: true } : {}),
  });
  console.log(values["json"] ? renderJson(result) : renderDoctor(result));
  return result.exitCode;
}

async function context(values: Record<string, unknown>): Promise<number> {
  const cfg = loadConfig(values["config"] as string, {
    runtime: values["runtime"] as string | undefined, model: values["model"] as string | undefined,
    k: values["k"] as string | undefined, threshold: values["threshold"] as string | undefined,
    conf: values["conf"] as string | undefined,
  });
  const suspects = parseIntFlag(values["suspects"] as string | undefined, "--suspects", 3, 1);
  const onProgress = makeContextProgress(values);
  const result = await runContextAudit(cfg, {
    ablate: Boolean(values["ablate"]), suspects,
    ...(onProgress ? { onProgress } : {}),
  });
  clearProgress();
  const showCost = !values["no-cost"];
  console.log(values["json"] ? renderJson(result) : renderContext(result, { showCost }));
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
      ablate: { type: "boolean", default: false },
      suspects: { type: "string" },
      baseline: { type: "string" },
      "save-baseline": { type: "string" },
      "skip-probe": { type: "boolean", default: false },
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
  } else if (cmd === "doctor") {
    code = await doctor(values); // config is optional for doctor
  } else {
    if (!values.config) { console.log(HELP); process.exit(2); }
    code = cmd === "fix" ? await fix(values)
      : cmd === "context" ? await context(values)
      : cmd === "diagnose" ? await diagnose(values)
      : await audit(values);
  }
  process.exit(code);
}

main().catch((e: unknown) => {
  if (e instanceof ConfigError) console.error(e.message);
  else console.error("skill-probe failed:", e instanceof Error ? e.message : e);
  process.exit(2);
});
