/** LLM text completion for `gen` and `fix`. Unified auth (v0.4):
 *   - ANTHROPIC_API_KEY set  → call the Anthropic API directly (fetch, Node >=18).
 *   - otherwise              → fall back to the `claude` CLI (works on a Claude subscription,
 *                              no API key needed).
 * So the whole tool — audit, gen, fix — runs on just a logged-in `claude`. */
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";

export type LlmBackend = "api" | "cli";

/** Which backend complete() will use, given the environment. Exported for testing/diagnostics. */
export function llmBackend(): LlmBackend {
  return process.env["ANTHROPIC_API_KEY"] ? "api" : "cli";
}

export interface CompleteOpts { model?: string; maxTokens?: number }

export async function complete(system: string, user: string, opts: CompleteOpts = {}): Promise<string> {
  return llmBackend() === "api"
    ? completeViaApi(system, user, opts)
    : completeViaClaudeCli(system, user, opts);
}

// --- API backend (pay-as-you-go key) ---
interface AnthropicResponse { content?: Array<{ type?: string; text?: string }> }

async function completeViaApi(system: string, user: string, opts: CompleteOpts): Promise<string> {
  const key = process.env["ANTHROPIC_API_KEY"]!;
  const model = opts.model ?? process.env["SKILL_PROBE_FIX_MODEL"] ?? "claude-sonnet-4-6";
  const res = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model, max_tokens: opts.maxTokens ?? 400, system, messages: [{ role: "user", content: user }] }),
  });
  if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = (await res.json()) as AnthropicResponse;
  return (body.content ?? []).filter((b) => b.type === "text").map((b) => b.text ?? "").join("").trim();
}

// --- CLI backend (Claude subscription via the `claude` binary) ---
interface ClaudeJsonResult { result?: unknown; is_error?: boolean }

function completeViaClaudeCli(system: string, user: string, opts: CompleteOpts): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const args = ["-p", user, "--append-system-prompt", system, "--output-format", "json"];
    if (opts.model) args.push("--model", opts.model);
    // run in a neutral cwd so the project's own skills/AGENTS.md don't bias the generation
    const child = spawn("claude", args, { cwd: tmpdir(), stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    let settled = false;
    const timer = setTimeout(() => { child.kill("SIGKILL"); }, 120_000);
    const done = (fn: () => void) => { if (settled) return; settled = true; clearTimeout(timer); fn(); };
    child.stdout.on("data", (d: Buffer) => { out += d.toString(); });
    child.stderr.on("data", (d: Buffer) => { err += d.toString(); });
    child.on("error", (e: Error) => done(() =>
      reject(new Error(`claude CLI failed: ${e.message} — set ANTHROPIC_API_KEY or install/login 'claude'.`))));
    child.on("close", () => done(() => {
      let text = "";
      try {
        const j = JSON.parse(out) as ClaudeJsonResult;
        if (typeof j.result === "string") text = j.result;
      } catch { text = out; } // tolerate plain-text output
      text = text.trim();
      if (text) resolve(text);
      else reject(new Error(`claude CLI returned no text (${(err || out).slice(0, 200)})`));
    }));
  });
}
