/** `skill-probe doctor` — preflight checks. Now that the tool is public, the first failures users
 * hit are SETUP failures (no skills dir, runtime not installed, not authed, a config typo), not deep
 * eval problems. doctor surfaces those in one cheap pass before they spend probes on a broken setup.
 *
 * Exit: 0 = healthy, 1 = warnings only, 2 = at least one hard failure. */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Config, ProbeResult, ProbeOpts } from "./types.ts";
import { loadConfig } from "./config.ts";
import { wilsonInterval } from "./stats.ts";
import { kToCertify } from "./report.ts";
import { getAdapter } from "./adapters/index.ts";

export type CheckStatus = "pass" | "warn" | "fail" | "info";
export interface Check { status: CheckStatus; message: string }
export interface DoctorResult { checks: Check[]; exitCode: 0 | 1 | 2 }

export interface DoctorOpts {
  cwd: string;
  configPath?: string;
  runtime?: string;
  model?: string;
  skipProbe?: boolean;
}

/** Injection seam so tests don't shell out to a real runtime. */
export interface DoctorDeps {
  cliInstalled?: (cmd: string) => boolean;
  probe?: (runtime: string, prompt: string, opts: ProbeOpts) => Promise<ProbeResult>;
}

const NAME_RE = /^name:\s*(.*)$/m;
const DESC_RE = /^description:\s*(.*)$/m;
const MIN_NODE = { major: 22, minor: 18 }; // package.json engines: ">=22.18"

function realCliInstalled(cmd: string): boolean {
  const r = spawnSync(cmd, ["--version"], { stdio: "ignore", timeout: 15_000 });
  // ENOENT = not on PATH. Any other result (even a non-zero exit) means the binary exists.
  return !(r.error && (r.error as NodeJS.ErrnoException).code === "ENOENT");
}

export async function runDoctor(opts: DoctorOpts, deps: DoctorDeps = {}): Promise<DoctorResult> {
  const cliInstalled = deps.cliInstalled ?? realCliInstalled;
  const probe = deps.probe ?? ((rt, p, o) => getAdapter(rt).probe(p, o));
  const checks: Check[] = [];
  const add = (status: CheckStatus, message: string): void => { checks.push({ status, message }); };

  // 1. Node version (declared engine)
  const [maj = 0, min = 0] = process.versions.node.split(".").map(Number);
  if (maj > MIN_NODE.major || (maj === MIN_NODE.major && min >= MIN_NODE.minor)) {
    add("pass", `Node ${process.versions.node}`);
  } else {
    add("warn", `Node ${process.versions.node} is below the declared engine >=22.18 ` +
      `(the compiled CLI may still run, but this is untested)`);
  }

  // 2. Config (optional). Load first — it can redirect the skills dir (cwd resolves to the config's dir).
  let cfg: Config | null = null;
  if (opts.configPath) {
    if (!existsSync(resolve(opts.configPath))) {
      add("fail", `config not found: ${opts.configPath}`);
    } else {
      try {
        cfg = loadConfig(opts.configPath, { ...(opts.runtime ? { runtime: opts.runtime } : {}) });
        add("pass", `config parsed: ${opts.configPath}`);
      } catch (e) {
        add("fail", `config ${opts.configPath}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  const skillsCwd = cfg ? cfg.cwd : resolve(opts.cwd);
  const runtime = cfg?.runtime ?? opts.runtime ?? "claude-code";

  // 3-6. Skills directory + each SKILL.md
  const skillNames = new Set<string>();
  const skillsRoot = join(skillsCwd, ".claude", "skills");
  if (!existsSync(skillsRoot)) {
    add("fail", `no .claude/skills/ directory under ${skillsCwd}`);
  } else {
    const dirs = readdirSync(skillsRoot, { withFileTypes: true }).filter((d) => d.isDirectory());
    if (dirs.length === 0) {
      add("fail", `.claude/skills/ exists but contains no skill folders`);
    }
    let valid = 0;
    for (const d of dirs) {
      const md = join(skillsRoot, d.name, "SKILL.md");
      if (!existsSync(md)) { add("fail", `skill "${d.name}" missing SKILL.md`); continue; }
      const text = readFileSync(md, "utf8");
      const name = NAME_RE.exec(text)?.[1]?.trim() ?? "";
      const desc = DESC_RE.exec(text)?.[1]?.trim() ?? "";
      if (!name) add("fail", `skill "${d.name}" missing name:`);
      else if (name !== d.name) add("warn", `skill "${d.name}" has name: "${name}" (doesn't match folder name)`);
      if (!desc) add("fail", `skill "${d.name}" missing description:`);
      else if (desc === "|" || desc === ">") add("warn", `skill "${d.name}" uses a multi-line description block — a single-line description triggers more reliably`);
      skillNames.add(d.name);
      valid++;
    }
    if (valid > 0) add("pass", `found .claude/skills/ with ${valid} skill${valid === 1 ? "" : "s"}`);
  }

  // 7-9. Config-dependent checks
  if (cfg) {
    const missing = cfg.cases
      .map((c) => c.expected).filter((s): s is string => s !== null)
      .filter((s) => !skillNames.has(s));
    if (missing.length) add("fail", `config expects skill(s) not in the library: ${[...new Set(missing)].join(", ")}`);
    else add("pass", `expected skills all exist`);

    if (cfg.cases.every((c) => c.expected === null)) {
      add("warn", `config has only decoy cases — no skill is being verified to fire`);
    }

    // a strict threshold at a small k can be mathematically impossible to certify
    if (wilsonInterval(cfg.k, cfg.k, cfg.conf).lo <= cfg.threshold) {
      add("warn", `threshold ${Math.round(cfg.threshold * 100)}% with k=${cfg.k} cannot certify a pass ` +
        `even on a perfect run — need ~k=${kToCertify(cfg.threshold, cfg.conf)} (or lower the threshold)`);
    }
  }

  // 10-11. Runtime + a harmless live probe (verifies the CLI is installed AND authed)
  add("info", `runtime: ${runtime}  model: ${cfg?.model ?? opts.model ?? "(runtime default)"}`);
  const known = runtime === "claude-code" || runtime === "opencode";
  const bin = runtime === "claude-code" ? "claude" : runtime === "opencode" ? "opencode" : null;
  let cliOk = false;
  if (!known) {
    add("fail", `unknown runtime "${runtime}" (expected claude-code or opencode)`);
  } else if (bin && cliInstalled(bin)) {
    add("pass", `${bin} CLI found`);
    cliOk = true;
  } else {
    add("fail", `${bin} CLI not found on PATH — install it and authenticate to run ${runtime}`);
  }

  if (opts.skipProbe) {
    add("info", `probe skipped (--skip-probe)`);
  } else if (known && cliOk) {
    const r = await probe(runtime, "Reply with exactly: ok", {
      cwd: skillsCwd, timeoutMs: 60_000,
      ...(cfg?.model ?? opts.model ? { model: (cfg?.model ?? opts.model)! } : {}),
    });
    if (r.status === "ok") add("pass", `${runtime} probe succeeded (CLI is authenticated)`);
    else add("fail", `${runtime} probe failed — check auth/login: ${r.error ?? "unknown error"}`);
  }

  const hasFail = checks.some((c) => c.status === "fail");
  const hasWarn = checks.some((c) => c.status === "warn");
  const exitCode: 0 | 1 | 2 = hasFail ? 2 : hasWarn ? 1 : 0;
  return { checks, exitCode };
}
