# Changelog

## 0.10.0 — 2026-10-21

Correctness hardening: several measurements could come out confidently wrong. Each item below was
found by measurement, and each has a regression test.

### Fixed — results that could be wrong

- **Verdict error rates now match the stated confidence.** The old early-stopping rule re-checked a
  Wilson interval after every probe ("peeking"). At k=35, a skill sitting exactly at the threshold
  was wrongly passed 9% and wrongly failed 18% of the time, against a nominal 2.5%. Verdicts now
  come from an exact group-sequential test whose error is bounded by `1 − conf` in each direction,
  however early the run stops. The tests check this by exact enumeration over a grid of k,
  thresholds and confidence levels. Smoke defaults still work: a clean 10/10 certifies 70%.
  Certifying ≥90% with a perfect run now needs k≥29 (the README said ~35).
- **`context` compared different environments.** Isolation and ablation runs used a bare sandbox,
  but the co-loaded run used your real project, so anything your `CLAUDE.md` did was blamed on the
  library. `--ablate` could then name an innocent sibling as the thief. Every condition now runs in
  an identical sandbox (the skill subset plus the project's instruction files).
- **Probes loaded your personal Claude Code config.** User plugins, synced skills, settings and MCP
  servers were co-loaded into every probe (measured: 32 skills loaded for a 2-skill project), so
  laptop and CI runs measured different things. Probes are now hermetic by default
  (`--setting-sources project --strict-mcp-config`). Use `--user-config` to opt back in.
- **OpenCode false pass.** A single `{"type":"error"}` event (bad auth, quota, version gate) was
  scored as a valid run where no skill fired, so a decoy case passed while the runtime was broken.
  Error events, and output with no model step, are now infrastructure errors.
- **Multi-line descriptions were read as `>-`.** `gen`, `diagnose` and `doctor` treated a YAML block
  scalar description as the literal text `>-`; `diagnose` showed that to the router, and `fix`
  refused the skill. All commands now share one frontmatter parser, and `fix` rewrites any form in
  place while preserving the rest of the file byte for byte.
- **One stray firing failed a case.** At k=10, a 95%-reliable skill failed 38% of the time because
  of the any-other-skill-fired rule. Trigger-theft is now a warning (with counts) and the verdict
  comes from the reliability test. `--fail-on-theft` / `"failOnTheft": true` keeps zero tolerance.

### Fixed — safety

- `fix` no longer edits your real `SKILL.md` during the experiment. Before/after run in two
  sandboxes, and the file is written once at the end. If the file changed on disk during the run,
  `fix` refuses to overwrite it. An interrupted `fix` can't leave a half-edited file.
- Sandboxes copy symlinks as real files, so a symlinked `SKILL.md` can't be written through to the
  shared original. Symlinked skill folders count as skills; they used to be silently dropped by
  `context`, `doctor` and `fix`.
- `fix` refuses a description with an unterminated quote before paying for a rewrite, instead of
  rewriting it by deleting the lines that follow.
- Ctrl-C / SIGTERM kills in-flight probes, including any processes they spawned, and removes every
  sandbox (exit 130/143). A probe's timeout now bounds wall time even if a descendant process holds
  its output open.
- Probes no longer write a session transcript into `~/.claude/projects/` (`--no-session-persistence`).
  The empty per-directory folders Claude Code creates for sandboxes are removed too, but only
  when they contain nothing.
- GitHub Action: inputs reach the shell only through environment variables (no script injection),
  unknown `command:` values are rejected, and multi-line `args:` keep every flag.

### Added

- The runtime's own report of what it loaded is recorded in every manifest: runtime version, the
  model it resolved to, and skills loaded besides the library (e.g. Claude Code's built-ins). The
  report shows it. The baseline gate warns when any of these drifted. `context` treats a condition
  that loaded the wrong skill set as an error, not a result.
- `doctor` checks that the runtime actually loads every library skill, lists the runtime's built-in
  skills, and warns when a library skill shares a built-in's name. `context` handles such clashes too:
  it learns the built-in names with one extra probe, but only when a load check looks wrong, and
  warns instead of marking every comparison untrustworthy.
- Reports never call a run hermetic when the runtime can't exclude personal config (OpenCode). They
  warn when a setting like `maxTurns` is ignored by the runtime.
- `context --ablate`: a thief from outside the library (e.g. a built-in) is named as such, instead
  of being reported as "dilution".
- `--concurrency <n>`, `--max-cost <usd>` (runtime probes only), `--max-turns <n>`, `--timeout <sec>`,
  `--version`.
- The audit flags probes that called another tool first and loaded no skill, since activation may
  be under-counted at `--max-turns 1`.
- Unknown config keys and unknown subcommands are errors. Previously `"treshold"` silently used the
  default, and `skill-probe contxt` silently ran an audit.
- CI: Node 22 + 24 matrix, compiled-CLI smoke test. A weekly `live-smoke` workflow runs real probes.
- Test fixtures of real, sanitized runtime output.

### Changed

- `fix` exit code `1` now means "not applied" for any reason (insufficient evidence, file changed,
  identical rewrite). Previously it was printed as "REVERTED".
- `conf` now defines the verdict error bound as `1 − conf` per direction (one-sided). The printed
  interval is still the two-sided Wilson CI.
