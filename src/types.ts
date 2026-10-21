/** Core types. The normalized ProbeResult is the seam every runtime adapter maps to. */

/** What the runtime reported about its own session — the ground truth of what was co-loaded. */
export interface ProbeEnv {
  /** every skill the runtime loaded for this probe (library + runtime built-ins + anything else) */
  loadedSkills?: string[];
  /** runtime CLI version, e.g. "2.1.305" */
  runtimeVersion?: string;
  /** model the runtime actually used (resolves "(runtime default)") */
  model?: string;
}

export interface ProbeResult {
  /** "ok" = the runtime ran and we trust the reading; "error" = infrastructure failure
   * (timeout, auth, crash, empty/unparseable output) — must NOT count as a behavioral outcome. */
  status: "ok" | "error";
  /** name of the skill that activated, or null if none fired. Meaningful only when status==="ok". */
  skillFired: string | null;
  /** tool names in invocation order (for execution-trajectory checks later) */
  trajectory: string[];
  /** USD cost of this single probe, if the runtime reports it */
  cost: number;
  /** failure reason when status==="error" */
  error?: string;
  /** session facts reported by the runtime, when it exposes them */
  env?: ProbeEnv;
}

export interface ProbeOpts {
  cwd: string;
  timeoutMs?: number;
  /** model id to pin (runtime-specific format, e.g. "claude-sonnet-4-6" or
   * "anthropic/claude-haiku-4-5"); omitted = the runtime's default. */
  model?: string;
  /** agent turns the runtime may take before we read the outcome (default 1) */
  maxTurns?: number;
  /** also load the user's personal runtime config (user settings, plugins, MCP servers). Off by
   * default: personal config differs per machine, so results wouldn't reproduce in CI. */
  userConfig?: boolean;
}

export interface RuntimeAdapter {
  readonly name: string;
  /** honours ProbeOpts.userConfig=false by keeping the user's personal config out of probes */
  readonly isolatesUserConfig?: boolean;
  /** honours ProbeOpts.maxTurns */
  readonly supportsMaxTurns?: boolean;
  /** Run one prompt with the library at cwd co-loaded; report what fired. */
  probe(prompt: string, opts: ProbeOpts): Promise<ProbeResult>;
}

export interface EvalCase {
  prompt: string;
  /** the skill that SHOULD fire, or null = a decoy that should fire nothing */
  expected: string | null;
}

export interface Config {
  runtime: string;
  /** model id to pin for reproducible, fair cross-runtime comparison (optional) */
  model?: string;
  /** project dir that contains .claude/skills/ */
  cwd: string;
  /** max repeats per prompt (sequential stop may finish earlier) */
  k: number;
  /** minimum acceptable trigger reliability (0..1) */
  threshold: number;
  /** confidence level for intervals and verdicts */
  conf: number;
  cases: EvalCase[];
  /** agent turns per probe (default 1) */
  maxTurns?: number;
  /** load the user's personal runtime config into probes (default false — hermetic) */
  userConfig?: boolean;
  /** per-probe timeout in ms (default 120000) */
  timeoutMs?: number;
  /** fail a case when ANY other skill fires, even if reliability clears the threshold (default false) */
  failOnTheft?: boolean;
}

/** The probe settings a Config implies (shared by every command). */
export function probeSettings(cfg: Config): Omit<ProbeOpts, "cwd"> {
  return {
    ...(cfg.model ? { model: cfg.model } : {}),
    ...(cfg.maxTurns !== undefined ? { maxTurns: cfg.maxTurns } : {}),
    ...(cfg.userConfig ? { userConfig: true } : {}),
    ...(cfg.timeoutMs !== undefined ? { timeoutMs: cfg.timeoutMs } : {}),
  };
}
