/** Claude Code adapter — the proven probe. Spawns `claude -p` headless, parses stream-json
 * for `tool_use name=="Skill"`. Distinguishes a real behavioral outcome (the model ran) from
 * an infrastructure failure (timeout / auth / crash / empty output) — finding #1.
 *
 * NOTE: with `--max-turns 1` the process exits NON-ZERO on success (error_max_turns), so exit
 * code can't signal validity. We treat a probe as valid iff the model produced an assistant
 * message; otherwise it's an infra error. */
import { spawn } from "node:child_process";
import type { ProbeResult, RuntimeAdapter } from "../types.ts";

interface StreamEvent {
  type?: string;
  subtype?: string;
  message?: { content?: Array<{ type?: string; name?: string; input?: { skill?: string } }> };
  total_cost_usd?: number;
}

export interface ParseInfo {
  skillFired: string | null;
  trajectory: string[];
  cost: number;
  sawInit: boolean;
  sawAssistant: boolean;
}

export function parseStream(stdout: string): ParseInfo {
  let skillFired: string | null = null;
  let cost = 0, sawInit = false, sawAssistant = false;
  const trajectory: string[] = [];
  for (const raw of stdout.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    let e: StreamEvent;
    try { e = JSON.parse(line) as StreamEvent; } catch { continue; }
    if (e.type === "system" && e.subtype === "init") sawInit = true;
    else if (e.type === "assistant") {
      sawAssistant = true;
      for (const b of e.message?.content ?? []) {
        if (b?.type === "tool_use" && b.name) {
          trajectory.push(b.name);
          if (b.name === "Skill" && b.input?.skill) skillFired = b.input.skill;
        }
      }
    } else if (e.type === "result" && typeof e.total_cost_usd === "number") {
      cost = e.total_cost_usd;
    }
  }
  return { skillFired, trajectory, cost, sawInit, sawAssistant };
}

export const claudeCodeAdapter: RuntimeAdapter = {
  name: "claude-code",
  probe(prompt, { cwd, timeoutMs = 120_000, model }) {
    return new Promise<ProbeResult>((resolve) => {
      let settled = false, timedOut = false;
      const args = ["-p", prompt, "--output-format", "stream-json", "--verbose", "--max-turns", "1"];
      if (model) args.push("--model", model);
      const child = spawn("claude", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
      let out = "", err = "";
      const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs);
      const finish = (r: ProbeResult): void => {
        if (settled) return; settled = true; clearTimeout(timer); resolve(r);
      };
      child.stdout.on("data", (d: Buffer) => { out += d.toString(); });
      child.stderr.on("data", (d: Buffer) => { err += d.toString(); });
      child.on("error", (e: Error) => finish({
        status: "error", skillFired: null, trajectory: [], cost: 0,
        error: `spawn failed: ${e.message} (is 'claude' installed and on PATH?)`,
      }));
      child.on("close", () => {
        const info = parseStream(out);
        if (timedOut) {
          return finish({
            status: "error", skillFired: null, trajectory: info.trajectory, cost: info.cost,
            error: `timed out after ${timeoutMs}ms`,
          });
        }
        if (!info.sawAssistant) {
          return finish({
            status: "error", skillFired: null, trajectory: info.trajectory, cost: info.cost,
            error: err.trim() ? err.trim().slice(-200) : "no assistant output (auth/config/empty response?)",
          });
        }
        finish({ status: "ok", skillFired: info.skillFired, trajectory: info.trajectory, cost: info.cost });
      });
    });
  },
};
