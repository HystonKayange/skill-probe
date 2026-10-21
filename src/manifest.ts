/** Run manifest — stamps every probe-running result so two runs are comparable and a report is
 * citable: tool version, command, when it ran, runtime/model, the statistical settings, and a
 * hash of the resolved config. Same configHash = same cases + settings = apples to apples; the
 * baseline comparison uses it to warn when a gate compares different experiments. */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Config, ProbeEnv, RuntimeAdapter } from "./types.ts";

/** What the runtime actually ran with — reported by the runtime itself, not assumed. */
export interface RunEnvironment {
  /** runtime CLI version (built-in skills and routing change between versions) */
  runtimeVersion?: string;
  /** the model the runtime actually used — resolves "(runtime default)" */
  resolvedModel?: string;
  /** skills the runtime loaded that are not in the library (e.g. Claude Code's built-ins) */
  extraSkills?: string[];
  /** the user's personal runtime config was requested in probes (--user-config) */
  userConfig: boolean;
  /** personal runtime config was actually kept out of probes (false when the runtime can't) */
  hermetic?: boolean;
  maxTurns: number;
}

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
  environment?: RunEnvironment;
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
 * the same library checked out at a different path (CI runner vs laptop) is the same experiment.
 * Settings added later are hashed only when non-default, so existing baselines keep their hash. */
export function configHash(cfg: Config): string {
  const canonical = JSON.stringify({
    runtime: cfg.runtime,
    model: cfg.model ?? null,
    k: cfg.k,
    threshold: cfg.threshold,
    conf: cfg.conf,
    cases: cfg.cases.map((c) => ({ prompt: c.prompt, expected: c.expected })),
    ...((cfg.maxTurns ?? 1) !== 1 ? { maxTurns: cfg.maxTurns } : {}),
    ...(cfg.userConfig ? { userConfig: true } : {}),
  });
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

export function buildEnvironment(
  cfg: Config, env: ProbeEnv | undefined, extraSkills: string[] | undefined, adapter: RuntimeAdapter,
): RunEnvironment {
  return {
    ...(env?.runtimeVersion ? { runtimeVersion: env.runtimeVersion } : {}),
    ...(env?.model ? { resolvedModel: env.model } : {}),
    ...(extraSkills ? { extraSkills } : {}),
    userConfig: Boolean(cfg.userConfig),
    hermetic: Boolean(adapter.isolatesUserConfig) && !cfg.userConfig,
    maxTurns: cfg.maxTurns ?? 1,
  };
}

/** Caveats when the config asks for something this runtime can't do. */
export function capabilityWarnings(cfg: Config, adapter: RuntimeAdapter): string[] {
  const w: string[] = [];
  if (cfg.maxTurns !== undefined && cfg.maxTurns !== 1 && !adapter.supportsMaxTurns) {
    w.push(`${adapter.name} has no turn limit — maxTurns (${cfg.maxTurns}) is ignored`);
  }
  if (!adapter.isolatesUserConfig && !cfg.userConfig) {
    w.push(`${adapter.name} can't exclude your personal/global config from probes — results may differ between machines`);
  }
  return w;
}

export function buildManifest(
  command: RunManifest["command"], cfg: Config, environment?: RunEnvironment,
): RunManifest {
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
    ...(environment ? { environment } : {}),
  };
}
