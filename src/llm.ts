/** LLM text completion for `gen` and `fix`. Unified auth (v0.4):
 *   - ANTHROPIC_API_KEY set  → call the Anthropic API directly (fetch, Node >=18).
 *   - otherwise              → fall back to the `claude` CLI (works on a Claude subscription,
 *                              no API key needed).
 * So the whole tool — audit, gen, fix — runs on just a logged-in `claude`. */
import { tmpdir } from "node:os";
import { runProcess } from "./proc.ts";

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

/** Pure interpreter of a `claude -p --output-format json` run. Treats a non-zero exit, an
 * `is_error: true` payload, a timeout, or empty output as ERRORS — so an error string can never
 * be mistaken for a valid generation (critical: fix would otherwise write it as a description). */
export function interpretClaudeJson(
  code: number | null, out: string, err: string, timedOut: boolean,
): { text?: string; error?: string } {
  if (timedOut) return { error: "claude CLI timed out after 120s" };
  let parsed: ClaudeJsonResult | null = null;
  try { parsed = JSON.parse(out) as ClaudeJsonResult; } catch { /* may be plain text */ }
  if (code !== 0 || parsed?.is_error === true) {
    const ctx = (parsed && typeof parsed.result === "string" ? parsed.result : "") || err || out;
    return { error: `claude CLI error (exit ${code}): ${ctx.trim().slice(0, 200)}` };
  }
  let text = parsed ? (typeof parsed.result === "string" ? parsed.result : "") : out;
  text = text.trim();
  return text ? { text } : { error: `claude CLI returned no text (${(err || out).slice(0, 200)})` };
}

/** CLI arguments for one completion. Exported for testing. */
export function claudeCliArgs(system: string, user: string, opts: CompleteOpts): string[] {
  // hermetic + no session transcript: diagnose calls this k times per case, and neither the user's
  // plugins/MCP servers nor ~/.claude/projects clutter have any business in a plain completion
  const args = [
    "-p", user, "--append-system-prompt", system, "--output-format", "json",
    "--no-session-persistence", "--setting-sources", "project", "--strict-mcp-config",
  ];
  if (opts.model) args.push("--model", opts.model);
  return args;
}

async function completeViaClaudeCli(system: string, user: string, opts: CompleteOpts): Promise<string> {
  // run in a neutral cwd so the project's own skills/AGENTS.md don't bias the generation
  const r = await runProcess("claude", claudeCliArgs(system, user, opts), { cwd: tmpdir(), timeoutMs: 120_000 });
  if (r.spawnError) {
    throw new Error(`claude CLI failed: ${r.spawnError} — set ANTHROPIC_API_KEY or install/login 'claude'.`);
  }
  const out = interpretClaudeJson(r.code, r.stdout, r.stderr, r.timedOut);
  if (out.text) return out.text;
  throw new Error(out.error ?? "claude CLI failed");
}
