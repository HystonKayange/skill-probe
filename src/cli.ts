#!/usr/bin/env node
/** skill-probe CLI.
 *   skill-probe --config <f>                  audit a co-loaded skill library
 *   skill-probe fix --config <f> --skill <n>  rewrite a skill's description & prove the lift
 * Exit: 0 = pass/applied, 1 = behavioral fail/reverted, 2 = inconclusive/infra error/usage. */
import { parseArgs } from "node:util";
import { runAudit } from "./eval.ts";
import { runFix } from "./fix.ts";
import { loadConfig, ConfigError } from "./config.ts";
import { renderTable, renderJson, renderFix } from "./report.ts";

const HELP = `skill-probe — audit a co-loaded agent skill library by real activation behavior.

USAGE
  skill-probe --config <file.json> [options]                 # audit
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
  fix only:
      --skill <name>       the skill whose description to rewrite (uses the config's cases for it)
      --apply-threshold <p> min P(improvement) to keep the rewrite (default 0.9)
  -h, --help               show this help

Reliability carries a Wilson CI + sample size k. fix rewrites the description, runs an INTERLEAVED
before/after, and applies it only if the Bayesian P(improvement) clears the apply-threshold.`;

async function audit(values: Record<string, unknown>): Promise<number> {
  const cfg = loadConfig(values["config"] as string, {
    runtime: values["runtime"] as string | undefined, model: values["model"] as string | undefined,
    k: values["k"] as string | undefined, threshold: values["threshold"] as string | undefined,
    conf: values["conf"] as string | undefined,
  });
  const result = await runAudit(cfg);
  console.log(values["json"] ? renderJson(result) : renderTable(result));
  return result.exitCode;
}

async function fix(values: Record<string, unknown>): Promise<number> {
  const skill = values["skill"] as string | undefined;
  if (!skill) { console.error("fix requires --skill <name>"); return 2; }
  const cfg = loadConfig(values["config"] as string, {
    runtime: values["runtime"] as string | undefined, model: values["model"] as string | undefined,
    k: values["k"] as string | undefined, conf: values["conf"] as string | undefined,
  });
  const applyBar = values["apply-threshold"] ? Number(values["apply-threshold"]) : 0.9;
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
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help || !values.config) {
    console.log(HELP);
    process.exit(values.help ? 0 : 2);
  }
  const cmd = positionals[0];
  const code = cmd === "fix" ? await fix(values) : await audit(values);
  process.exit(code);
}

main().catch((e: unknown) => {
  if (e instanceof ConfigError) console.error(e.message);
  else console.error("skill-probe failed:", e instanceof Error ? e.message : e);
  process.exit(2);
});
