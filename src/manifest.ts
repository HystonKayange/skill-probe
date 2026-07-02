/** Run manifest — stamps every probe-running result so two runs are comparable and a report is
 * citable: tool version, command, when it ran, runtime/model, the statistical settings, and a
 * hash of the resolved config. Same configHash = same cases + settings = apples to apples; the
 * baseline comparison uses it to warn when a gate compares different experiments. */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./types.ts";

export interface RunManifest {
  tool: "skill-probe";
  version: string;
  command: "audit" | "context" | "diagnose";
  /** ISO 8601 UTC */
  date: string;
  runtime: string;
  model: string;
  k: number;
  threshold: number;
  conf: number;
  /** sha256 (first 16 hex chars) of the resolved config — cases + settings, NOT cwd */
  configHash: string;
  node: string;
}

let cachedVersion: string | undefined;
export function toolVersion(): string {
  if (cachedVersion === undefined) {
    try {
      const pkg = JSON.parse(
        readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8"),
      ) as { version?: string };
      cachedVersion = pkg.version ?? "unknown";
    } catch {
      cachedVersion = "unknown";
    }
  }
  return cachedVersion;
}

/** Hash the parts of the config that change what was measured. `cwd` is deliberately EXCLUDED:
 * the same library checked out at a different path (CI runner vs laptop) is the same experiment. */
export function configHash(cfg: Config): string {
  const canonical = JSON.stringify({
    runtime: cfg.runtime,
    model: cfg.model ?? null,
    k: cfg.k,
    threshold: cfg.threshold,
    conf: cfg.conf,
    cases: cfg.cases.map((c) => ({ prompt: c.prompt, expected: c.expected })),
  });
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

export function buildManifest(command: RunManifest["command"], cfg: Config): RunManifest {
  return {
    tool: "skill-probe",
    version: toolVersion(),
    command,
    date: new Date().toISOString(),
    runtime: cfg.runtime,
    model: cfg.model ?? "(runtime default)",
    k: cfg.k,
    threshold: cfg.threshold,
    conf: cfg.conf,
    configHash: configHash(cfg),
    node: process.version,
  };
}
