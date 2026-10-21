/** OpenCode adapter — the second runtime (cross-vendor; BYO-key). Reads `.claude/skills/`.
 * Activation surfaces as a tool part named "skill" with the name in state.input.name (confirmed
 * against opencode v1.17.9 `run --format json`). Distinguishes behavioral outcome from infra
 * failure (finding #1): a run counts only if there's evidence a model step actually ran — an
 * `{"type":"error"}` event (auth, quota, version gate; captured live on 1.17.9) or output with no
 * model step at all is an infrastructure error, never a behavioral "no skill fired".
 * GOTCHA: opencode `run` hangs unless stdin is closed — runProcess uses stdio ignore. */
import type { ProbeResult, RuntimeAdapter } from "../types.ts";
import { runProcess } from "../proc.ts";

export interface CoreResult {
  skillFired: string | null;
  trajectory: string[];
  cost: number;
  /** saw a model step / text / tool part — evidence the model actually ran */
  sawModelOutput: boolean;
  /** message of an error event, if the run reported one */
  error?: string;
}

const MODEL_OUTPUT_TYPES = new Set([
  "step_start", "step_finish", "step-start", "step-finish", "text", "tool", "tool_use", "reasoning",
]);

function errorMessage(o: Record<string, unknown>): string {
  const e = o["error"];
  if (typeof e === "string") return e;
  if (e && typeof e === "object") {
    const eo = e as Record<string, unknown>;
    const data = eo["data"] as Record<string, unknown> | undefined;
    const msg = data?.["message"] ?? eo["message"] ?? eo["name"];
    if (typeof msg === "string") return msg;
  }
  return typeof o["message"] === "string" ? (o["message"] as string) : "opencode reported an error";
}

/** Recursively scan parsed OpenCode output for a fired skill + tool trajectory. Defensive:
 * handles "skill name in input.name" or "input.skill", single JSON or JSONL of events. */
export function extractFromOpenCode(parsed: unknown): CoreResult {
  let skillFired: string | null = null;
  let cost = 0;
  let sawModelOutput = false;
  let error: string | undefined;
  const trajectory: string[] = [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) { node.forEach(visit); return; }
    if (!node || typeof node !== "object") return;
    const o = node as Record<string, unknown>;
    const type = o["type"];
    if (type === "error" && error === undefined) error = errorMessage(o);
    if (typeof type === "string" && MODEL_OUTPUT_TYPES.has(type)) sawModelOutput = true;
    if (type === "tool" && typeof o["tool"] === "string") {
      const tool = o["tool"] as string;
      trajectory.push(tool);
      if (tool === "skill") {
        const state = o["state"] as Record<string, unknown> | undefined;
        const input = (state?.["input"] ?? o["input"]) as Record<string, unknown> | undefined;
        const name = (input?.["name"] ?? input?.["skill"]) as string | undefined;
        if (name) skillFired = name;
      }
    }
    if (typeof o["cost"] === "number") cost = o["cost"] as number;
    for (const v of Object.values(o)) visit(v);
  };
  visit(parsed);
  return { skillFired, trajectory, cost, sawModelOutput, ...(error !== undefined ? { error } : {}) };
}

/** Parse stdout (whole-JSON or JSONL) and report how many events were seen (0 = no output). */
export function parseOutput(stdout: string): { result: CoreResult; eventCount: number } {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return { result: { skillFired: null, trajectory: [], cost: 0, sawModelOutput: false }, eventCount: 0 };
  }
  try {
    const whole = JSON.parse(trimmed);
    return { result: extractFromOpenCode(whole), eventCount: Array.isArray(whole) ? whole.length : 1 };
  } catch {
    const events: unknown[] = [];
    for (const line of trimmed.split("\n")) {
      const s = line.trim();
      if (!s) continue;
      try { events.push(JSON.parse(s)); } catch { /* skip non-json log lines */ }
    }
    return { result: extractFromOpenCode(events), eventCount: events.length };
  }
}

/** Decide what a finished (non-timeout) run means. Exported for testing. */
export function interpretOpenCode(stdout: string, stderr: string): ProbeResult {
  const { result, eventCount } = parseOutput(stdout);
  const fail = (error: string): ProbeResult =>
    ({ status: "error", skillFired: null, trajectory: result.trajectory, cost: result.cost, error });
  if (eventCount === 0) {
    // surface whatever diagnostic we have: stderr, else a non-JSON stdout log (opencode
    // prints provider/model errors to stdout), else a generic hint.
    const diag = stderr.trim() || stdout.trim();
    return fail(diag ? diag.slice(-200) : "no output (auth/model/hang? check `opencode auth list`)");
  }
  if (result.error !== undefined) return fail(`opencode error: ${result.error.slice(0, 200)}`);
  if (!result.sawModelOutput) {
    return fail("no model step in the output — the model did not actually run (check `opencode auth list`)");
  }
  return { status: "ok", skillFired: result.skillFired, trajectory: result.trajectory, cost: result.cost };
}

export const openCodeAdapter: RuntimeAdapter = {
  name: "opencode",
  // `opencode run` always loads its global config and has no turn limit — say so, don't pretend
  isolatesUserConfig: false,
  supportsMaxTurns: false,
  async probe(prompt, { cwd, timeoutMs = 120_000, model }) {
    // config/CLI --model wins; env var is a fallback convenience
    const effectiveModel = model ?? process.env["SKILL_PROBE_OPENCODE_MODEL"];
    const args = ["run", prompt, "--format", "json"];
    if (effectiveModel) args.push("--model", effectiveModel);
    const r = await runProcess("opencode", args, { cwd, timeoutMs });
    if (r.spawnError) {
      return {
        status: "error", skillFired: null, trajectory: [], cost: 0,
        error: `spawn failed: ${r.spawnError} (is 'opencode' installed and on PATH?)`,
      };
    }
    if (r.timedOut) {
      const { result } = parseOutput(r.stdout);
      return {
        status: "error", skillFired: null, trajectory: result.trajectory, cost: result.cost,
        error: `timed out after ${timeoutMs}ms`,
      };
    }
    return interpretOpenCode(r.stdout, r.stderr);
  },
};
