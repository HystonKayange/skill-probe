# skill-probe

Runtime-agnostic, **co-loaded-aware** auditor for an AI agent's skill library. It measures
which skill *actually* fires (by real activation, not keyword matching) when your whole
`SKILL.md` library is loaded together — with **statistical confidence**, not single-shot guesses.

> Most skill tooling tests one skill, in isolation, once. Skills only conflict when loaded
> *together*, and activation is *stochastic*. skill-probe is the tool that tests the real thing.

Complements static linters like `skill-audit` (security/quality) — this is **behavioral**.

> **How it works / requirements.** skill-probe is a **terminal CLI**, *not* an in-agent slash
> command. It drives your local runtime CLI under the hood, so you need that runtime installed and
> authenticated: **`claude`** (logged in) for `runtime: claude-code`, or **`opencode`** for
> `runtime: opencode`. `gen`/`fix` use `ANTHROPIC_API_KEY` if set, otherwise the local `claude` CLI.
> Codex/Gemini runtimes aren't supported yet (their traces don't expose which skill fired).

## Why

- Skill activation is stochastic: the same prompt can produce different skill-routing outcomes.
- A single run lies (we measured the same prompt at 0/5 one batch, 2/3 the next).
- skill-probe runs each prompt **k times**, reports a **Wilson 95% CI**, stops early when the
  result is statistically decided, and flags **trigger-theft** (a sibling stealing a trigger).

## Install

```bash
npm i -g skill-probe      # or: npx skill-probe
```

## Generate a config (`skill-probe gen`)

Don't want to hand-write the cases? Draft them from your skills, then review:

```bash
ANTHROPIC_API_KEY=sk-ant-...  skill-probe gen --cwd . > probe.config.json
```
It reads each `.claude/skills/*/SKILL.md`, and an LLM drafts realistic should-fire prompts per
skill, cross-skill **near-misses** (to surface mis-routing), and off-topic **decoys**. Hallucinated
skill names are dropped automatically. Flags: `--per-skill <n>` (default 3), `--decoys <n>`
(default 2), `--model <id>`.

> **Always review the draft before running.** Generators lean toward obvious keyword-matches; you
> add the messy, oblique phrasings real users type (that's where triggering actually fails).

`gen` (and `fix`) use `ANTHROPIC_API_KEY` if it's set, otherwise they fall back to the logged-in
**`claude` CLI** — so on a Claude subscription the whole tool (audit, gen, fix) works with **no API
key at all**.

## Use

```bash
# point it at your own config (after `npm i -g skill-probe`):
skill-probe --config my.config.json --k 10 --threshold 0.7 --json

# or, from a clone of this repo, try the bundled example (needs `claude` installed + auth):
skill-probe --config examples/audit.config.json
```

Config (`skill-probe.config.json`):
```json
{
  "runtime": "claude-code",
  "cwd": "./my-project",
  "k": 10, "threshold": 0.7, "conf": 0.95,
  "cases": [
    { "prompt": "write a commit message", "expected": "commit-writer" },
    { "prompt": "what's the weather?", "expected": null }
  ]
}
```
Output:
```
skill-probe — runtime: claude-code  model: (runtime default)  threshold: 70%

  PASS          expect=commit-writer  | write a commit message
        reliability 100% [72%, 100%] k=10
        outcomes: commit-writer×10
  FAIL          expect=pr-describer  | write a pull request description
        reliability 20% [6%, 51%] k=10
        outcomes: None×8, commit-writer×2
        ⚠ trigger-theft by: commit-writer
  PASS          expect=(none)  | what's the weather?
        reliability 100% [72%, 100%] k=10
        outcomes: None×10

Result: 2 pass / 1 fail / 0 inconclusive / 0 error  |  exit 1  |  cost $0.18
```

- `cwd` (relative paths resolve against the **config file's** directory) is a project dir
  containing `.claude/skills/`.
- `expected: null` = a decoy that should fire nothing.
- Exit code: `0` all pass, `1` a behavioral fail / trigger-theft, `2` inconclusive or an
  infrastructure error (runtime down → never a silent pass).

**Output options:** a live `probing [2/3] …` progress line prints to stderr while it runs (use
`--quiet` to silence it). `--markdown` emits a table you can paste into a PR/README; `--json`
for machine output; `--no-cost` hides the cost line (handy on a Claude subscription, where the
dollar figure is just an estimate, not a charge).

**Cross-runtime comparison must pin the model.** A skill can fire on one runtime and not another
partly because of the *model*, not the runtime. Always set `model` (recorded in the report) so a
Claude Code vs OpenCode comparison is fair — otherwise you're comparing two confounded variables.

**Two modes** — because confidence intervals are wide at small k:
- **Smoke (default):** `threshold 0.7, k 10` — a clean run certifies; cheap; good for CI.
- **Certify:** a strict bar needs more runs. To certify **≥0.9** you need **~k=35**; when a
  case is inconclusive the report prints the exact k for your threshold. Don't set `threshold
  0.9, k 10` and expect a pass — that's statistically impossible and the tool will say so.

## Fix a failing skill (`skill-probe fix`)

Rewrite a skill's trigger description and **prove the lift is real** before keeping it:

```bash
ANTHROPIC_API_KEY=sk-ant-... \
  skill-probe fix --config examples/fix.config.json --skill commit-writer
```

It (1) LLM-rewrites the description, told the sibling skills so it won't steal their triggers;
(2) runs an **interleaved** before/after (old desc → probe → new desc → probe, paired, to control
for drift); (3) computes the **Bayesian** P(improvement) + a credible interval on the change; and
(4) **applies the rewrite only if** `P(improvement) ≥ --apply-threshold` (default 0.9) **and** the
effect is positive — otherwise reverts. When applied, the original is snapshotted to a timestamped
`SKILL.md.bak.<timestamp>` (no backup is left behind on a revert).

```
before: 0% [0%, 49%]   after: 100% [51%, 100%]   (4 paired runs)
P(rewrite improved reliability) = 100%   Δ = +80% [36%, 99%]
✅ APPLIED
original backed up to: /path/to/SKILL.md.bak.1719000000000
```

`fix` does the rewrite via `ANTHROPIC_API_KEY` if set, else the logged-in `claude` CLI (subscription).
It changes descriptions on statistical evidence, not on "the new one looks nicer" — a rewrite that
doesn't measurably help is reverted.

## Status

Early (v0.4). **Audit (`skill-probe`):** Wilson confidence intervals + sequential stopping +
four-state verdict (pass / fail / inconclusive / **error**), across two runtimes (Claude Code,
OpenCode). Infrastructure failures (timeout / auth / crash / empty output) are reported as
`error`, never as a behavioral pass/fail — a decoy can't falsely pass because the runtime was down.

**Fix (`skill-probe fix`):** uses the **Bayesian Beta-Binomial** to gate description rewrites on a
*proven* lift (interleaved before/after, applied only if P(improvement) clears the bar).

**Implemented + unit-tested but NOT yet used by any command:** Fisher's exact test and
Benjamini-Hochberg FDR (`src/stats.ts`) — reserved for cross-case multiplicity control (a planned
enhancement). Don't read the presence of these functions as the audit using them.

## Dev

```bash
node --test test/*.test.ts   # run tests (zero deps; Node >= 22.18 strips types)
node src/cli.ts --help
npm run typecheck            # tsc --noEmit (needs `npm i`)
```
