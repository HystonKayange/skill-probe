/** Core types. The normalized ProbeResult is the seam every runtime adapter maps to. */

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
}

export interface ProbeOpts {
  cwd: string;
  timeoutMs?: number;
  /** model id to pin (runtime-specific format, e.g. "claude-sonnet-4-6" or
   * "anthropic/claude-haiku-4-5"); omitted = the runtime's default. */
  model?: string;
}

export interface RuntimeAdapter {
  readonly name: string;
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
  /** confidence level for intervals */
  conf: number;
  cases: EvalCase[];
}
