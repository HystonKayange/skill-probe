/** Minimal Anthropic client for the `fix` command's description rewrite. Uses Node's built-in
 * fetch (Node >=18) — zero deps. Needs ANTHROPIC_API_KEY (only `fix` uses this, not the audit). */
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";

interface AnthropicResponse {
  content?: Array<{ type?: string; text?: string }>;
}

export async function complete(
  system: string,
  user: string,
  opts: { model?: string; maxTokens?: number } = {},
): Promise<string> {
  const key = process.env["ANTHROPIC_API_KEY"];
  if (!key) {
    throw new Error("ANTHROPIC_API_KEY is required for `skill-probe fix` (it rewrites the description).");
  }
  const model = opts.model ?? process.env["SKILL_PROBE_FIX_MODEL"] ?? "claude-sonnet-4-6";
  const res = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: opts.maxTokens ?? 400,
      system,
      messages: [{ role: "user", content: user }],
    }),
  });
  if (!res.ok) {
    throw new Error(`Anthropic API ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const body = (await res.json()) as AnthropicResponse;
  return (body.content ?? [])
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("")
    .trim();
}
