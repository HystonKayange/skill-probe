/** Config loading + validation. Bad inputs must fail loudly with a clear message, never
 * silently produce NaN intervals or zero-run audits. */
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import type { Config, EvalCase } from "./types.ts";

const VALID_CONF = new Set([0.9, 0.95, 0.99]);

export class ConfigError extends Error {
  readonly errors: string[];
  constructor(errors: string[]) {
    super("invalid config:\n  - " + errors.join("\n  - "));
    this.name = "ConfigError";
    this.errors = errors;
  }
}

/** Validate a raw config object (already merged with CLI flag overrides).
 * `configPath` is used to resolve a relative `cwd` against the CONFIG FILE's
 * directory — not the caller's shell (finding #3). Throws ConfigError on any problem. */
export function validateConfig(raw: unknown, configPath: string): Config {
  const r = (raw ?? {}) as Record<string, unknown>;
  const errs: string[] = [];

  const runtime = typeof r["runtime"] === "string" && r["runtime"] ? (r["runtime"] as string) : "claude-code";

  let model: string | undefined;
  if (r["model"] !== undefined) {
    if (typeof r["model"] !== "string" || !r["model"]) errs.push(`model must be a non-empty string if set`);
    else model = r["model"] as string;
  }

  const cwdRaw = typeof r["cwd"] === "string" ? (r["cwd"] as string) : ".";
  const cwd = resolve(dirname(resolve(configPath)), cwdRaw);

  const k = r["k"] ?? 10;
  if (typeof k !== "number" || !Number.isInteger(k) || k <= 0) {
    errs.push(`k must be a positive integer (got ${JSON.stringify(r["k"])})`);
  }

  // Default 0.7 = a "smoke test" bar: a clean 10/10 at default k=10 certifies (Wilson lo ≈ 0.72).
  // For strict certification (e.g. >=0.9) raise BOTH threshold and k — the report says how much.
  const threshold = r["threshold"] ?? 0.7;
  if (typeof threshold !== "number" || Number.isNaN(threshold) || threshold <= 0 || threshold >= 1) {
    errs.push(`threshold must be a number strictly between 0 and 1 (got ${JSON.stringify(r["threshold"])})`);
  }

  const conf = r["conf"] ?? 0.95;
  if (typeof conf !== "number" || !VALID_CONF.has(conf)) {
    errs.push(`conf must be one of 0.9, 0.95, 0.99 (got ${JSON.stringify(r["conf"])})`);
  }

  const cases = Array.isArray(r["cases"]) ? (r["cases"] as unknown[]) : [];
  if (cases.length === 0) errs.push("config needs a non-empty `cases` array");
  cases.forEach((c, i) => {
    const cc = (c ?? {}) as Record<string, unknown>;
    if (typeof cc["prompt"] !== "string" || !cc["prompt"]) {
      errs.push(`cases[${i}].prompt must be a non-empty string`);
    }
    if (!(cc["expected"] === null || typeof cc["expected"] === "string")) {
      errs.push(`cases[${i}].expected must be a skill name (string) or null`);
    }
  });

  if (errs.length) throw new ConfigError(errs);
  return {
    runtime,
    ...(model ? { model } : {}),
    cwd,
    k: k as number,
    threshold: threshold as number,
    conf: conf as number,
    cases: cases as EvalCase[],
  };
}

/** Validate a probability-ish flag (e.g. --apply-threshold): must be a number strictly in (0,1). */
export function parseProbability(raw: string | undefined, name: string, def: number): number {
  if (raw === undefined) return def;
  const v = Number(raw);
  if (!Number.isFinite(v) || v <= 0 || v >= 1) {
    throw new ConfigError([`${name} must be a number strictly between 0 and 1 (got ${JSON.stringify(raw)})`]);
  }
  return v;
}

/** Validate an integer flag (e.g. --per-skill, --decoys): must be an integer >= min if provided. */
export function parseIntFlag(raw: string | undefined, name: string, def: number, min: number): number {
  if (raw === undefined) return def;
  const v = Number(raw);
  if (!Number.isInteger(v) || v < min) {
    throw new ConfigError([`${name} must be an integer >= ${min} (got ${JSON.stringify(raw)})`]);
  }
  return v;
}

/** CLI flag overrides (already string-typed from argv); numerics are coerced then validated. */
export interface Overrides {
  runtime?: string | undefined;
  model?: string | undefined;
  k?: string | undefined;
  threshold?: string | undefined;
  conf?: string | undefined;
}

export function loadConfig(configPath: string, overrides: Overrides = {}): Config {
  let fileRaw: unknown;
  try {
    fileRaw = JSON.parse(readFileSync(resolve(configPath), "utf8"));
  } catch (e) {
    throw new ConfigError([`could not read/parse config '${configPath}': ${e instanceof Error ? e.message : e}`]);
  }
  const merged: Record<string, unknown> = { ...(fileRaw as Record<string, unknown>) };
  if (overrides.runtime !== undefined) merged["runtime"] = overrides.runtime;
  if (overrides.model !== undefined) merged["model"] = overrides.model;
  if (overrides.k !== undefined) merged["k"] = Number(overrides.k);
  if (overrides.threshold !== undefined) merged["threshold"] = Number(overrides.threshold);
  if (overrides.conf !== undefined) merged["conf"] = Number(overrides.conf);
  return validateConfig(merged, configPath);
}
