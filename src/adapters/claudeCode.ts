/** Claude Code adapter — the proven probe. Spawns `claude -p` headless, parses stream-json
 * for `tool_use name=="Skill"`. Distinguishes a real behavioral outcome (the model ran) from
 * an infrastructure failure (timeout / auth / crash / empty output) — finding #1.
 *
 * Hermetic by default: `--setting-sources project --strict-mcp-config` keeps the user's personal
 * plugins, synced skills, settings and MCP servers out of the probe (measured live on 2.1.305: a
 * 2-skill project loaded 32 skills with user config, 21 without — the rest are Claude Code's own
 * built-ins, which ship with the runtime and are recorded, not removed). `--no-session-persistence`
 * stops every probe from writing a session transcript into ~/.claude/projects/.
 *
 * NOTE: with `--max-turns 1` the process exits NON-ZERO on success (error_max_turns), so exit
 * code can't signal validity. We treat a probe as valid iff the model produced an assistant
 * message; otherwise it's an infra error. */
import type { ProbeEnv, ProbeOpts, ProbeResult, RuntimeAdapter } from "../types.ts";
import { runProcess } from "../proc.ts";

interface StreamEvent {
  type?: string;
  subtype?: string;
  message?: { content?: Array<{ type?: string; name?: string; input?: { skill?: string } }> };
  total_cost_usd?: number;
  skills?: unknown;
  claude_code_version?: unknown;
  model?: unknown;
}

export interface ParseInfo {
  skillFired: string | null;
  trajectory: string[];
  cost: number;
  sawInit: boolean;
  sawAssistant: boolean;
  env: ProbeEnv;
}

export function parseStream(stdout: string): ParseInfo {
  let skillFired: string | null = null;
  let cost = 0, sawInit = false, sawAssistant = false;
  const trajectory: string[] = [];
  const env: ProbeEnv = {};
  for (const raw of stdout.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    let e: StreamEvent;
    try { e = JSON.parse(line) as StreamEvent; } catch { continue; }
    if (e.type === "system" && e.subtype === "init") {
      sawInit = true;
      if (Array.isArray(e.skills)) env.loadedSkills = e.skills.filter((s): s is string => typeof s === "string");
      if (typeof e.claude_code_version === "string") env.runtimeVersion = e.claude_code_version;
      if (typeof e.model === "string") env.model = e.model;
    } else if (e.type === "assistant") {
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
  return { skillFired, trajectory, cost, sawInit, sawAssistant, env };
}

/** Decide what a finished (non-timeout) probe means. A probe is a VALID behavioral outcome only
 * if there is evidence the model actually ran: assistant output AND a nonzero billed cost. A
 * zero-cost "response" (observed live 2026-07-02: a usage-limit window returned assistant text
 * with total_cost_usd=0 and no tool_use, for several minutes) means the model never really ran —
 * counting it as "no skill fired" silently poisons every verdict. It must surface as an infra
 * error → untrustworthy, never as a behavioral result. */
export function interpretProbe(info: ParseInfo, stderrText: string): ProbeResult {
  const env = Object.keys(info.env).length ? { env: info.env } : {};
  if (!info.sawAssistant) {
    const err = stderrText.trim();
    const hint = /unknown option|unrecognized/i.test(err)
      ? " — this Claude Code version doesn't support a flag skill-probe needs; upgrade with `npm i -g @anthropic-ai/claude-code`"
      : "";
    return {
      status: "error", skillFired: null, trajectory: info.trajectory, cost: info.cost,
      error: (err ? err.slice(-200) : "no assistant output (auth/config/empty response?)") + hint, ...env,
    };
  }
  if (info.cost === 0) {
    return {
      status: "error", skillFired: null, trajectory: info.trajectory, cost: 0,
      error: "zero-cost response — the model did not actually run (usage limit / degraded CLI state?)", ...env,
    };
  }
  return { status: "ok", skillFired: info.skillFired, trajectory: info.trajectory, cost: info.cost, ...env };
}

/** CLI arguments for one probe. Exported for testing. */
export function buildArgs(prompt: string, opts: Omit<ProbeOpts, "cwd">): string[] {
  const args = [
    "-p", prompt, "--output-format", "stream-json", "--verbose",
    "--max-turns", String(opts.maxTurns ?? 1), "--no-session-persistence",
  ];
  if (!opts.userConfig) args.push("--setting-sources", "project", "--strict-mcp-config");
  if (opts.model) args.push("--model", opts.model);
  return args;
}

export const claudeCodeAdapter: RuntimeAdapter = {
  name: "claude-code",
  isolatesUserConfig: true,
  supportsMaxTurns: true,
  async probe(prompt, opts) {
    const timeoutMs = opts.timeoutMs ?? 120_000;
    const r = await runProcess("claude", buildArgs(prompt, opts), { cwd: opts.cwd, timeoutMs });
    if (r.spawnError) {
      return {
        status: "error", skillFired: null, trajectory: [], cost: 0,
        error: `spawn failed: ${r.spawnError} (is 'claude' installed and on PATH?)`,
      };
    }
    const info = parseStream(r.stdout);
    if (r.timedOut) {
      return {
        status: "error", skillFired: null, trajectory: info.trajectory, cost: info.cost,
        error: `timed out after ${timeoutMs}ms`,
      };
    }
    return interpretProbe(info, r.stderr);
  },
};
