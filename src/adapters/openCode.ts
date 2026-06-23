/** OpenCode adapter — the second runtime (cross-vendor; BYO-key). Reads `.claude/skills/`.
 * Activation surfaces as a tool part named "skill" with the name in state.input.name (confirmed
 * against opencode v1.17.9 `run --format json`). Distinguishes behavioral outcome from infra
 * failure (finding #1). GOTCHA: opencode `run` hangs unless stdin is closed — we use stdio ignore. */
import { spawn } from "node:child_process";
import type { ProbeResult, RuntimeAdapter } from "../types.ts";

export interface CoreResult { skillFired: string | null; trajectory: string[]; cost: number; }

/** Recursively scan parsed OpenCode output for a fired skill + tool trajectory. Defensive:
 * handles "skill name in input.name" or "input.skill", single JSON or JSONL of events. */
export function extractFromOpenCode(parsed: unknown): CoreResult {
  let skillFired: string | null = null;
  let cost = 0;
  const trajectory: string[] = [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) { node.forEach(visit); return; }
    if (!node || typeof node !== "object") return;
    const o = node as Record<string, unknown>;
    if (o["type"] === "tool" && typeof o["tool"] === "string") {
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
  return { skillFired, trajectory, cost };
}

/** Parse stdout (whole-JSON or JSONL) and report how many events were seen (0 = no output). */
export function parseOutput(stdout: string): { result: CoreResult; eventCount: number } {
  const trimmed = stdout.trim();
  if (!trimmed) return { result: { skillFired: null, trajectory: [], cost: 0 }, eventCount: 0 };
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

export const openCodeAdapter: RuntimeAdapter = {
  name: "opencode",
  probe(prompt, { cwd, timeoutMs = 120_000, model }) {
    // config/CLI --model wins; env var is a fallback convenience
    const effectiveModel = model ?? process.env["SKILL_PROBE_OPENCODE_MODEL"];
    const args = ["run", prompt, "--format", "json"];
    if (effectiveModel) args.push("--model", effectiveModel);
    return new Promise<ProbeResult>((resolve) => {
      let settled = false, timedOut = false;
      const child = spawn("opencode", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
      let out = "", err = "";
      const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs);
      const finish = (r: ProbeResult): void => {
        if (settled) return; settled = true; clearTimeout(timer); resolve(r);
      };
      child.stdout.on("data", (d: Buffer) => { out += d.toString(); });
      child.stderr.on("data", (d: Buffer) => { err += d.toString(); });
      child.on("error", (e: Error) => finish({
        status: "error", skillFired: null, trajectory: [], cost: 0,
        error: `spawn failed: ${e.message} (is 'opencode' installed and on PATH?)`,
      }));
      child.on("close", () => {
        const { result, eventCount } = parseOutput(out);
        if (timedOut) {
          return finish({
            status: "error", skillFired: null, trajectory: result.trajectory, cost: result.cost,
            error: `timed out after ${timeoutMs}ms`,
          });
        }
        if (eventCount === 0) {
          // surface whatever diagnostic we have: stderr, else a non-JSON stdout log (opencode
          // prints provider/model errors to stdout), else a generic hint.
          const diag = err.trim() || out.trim();
          return finish({
            status: "error", skillFired: null, trajectory: [], cost: 0,
            error: diag ? diag.slice(-200) : "no output (auth/model/hang? check `opencode auth list`)",
          });
        }
        finish({ status: "ok", skillFired: result.skillFired, trajectory: result.trajectory, cost: result.cost });
      });
    });
  },
};
