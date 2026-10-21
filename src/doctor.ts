/** `skill-probe doctor` — preflight checks. Now that the tool is public, the first failures users
 * hit are SETUP failures (no skills dir, runtime not installed, not authed, a config typo), not deep
 * eval problems. doctor surfaces those in one cheap pass before they spend probes on a broken setup.
 *
 * Exit: 0 = healthy, 1 = warnings only, 2 = at least one hard failure. */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { type Config, type ProbeResult, type ProbeOpts, probeSettings } from "./types.ts";
import { loadConfig } from "./config.ts";
import { kToCertify } from "./stats.ts";
import { getAdapter } from "./adapters/index.ts";
import { readSkillFile, skillFolders, skillsRoot, type SkillInfo } from "./skills.ts";
import { loadProblems } from "./orchestrator.ts";
import { withSandbox } from "./sandbox.ts";

export type CheckStatus = "pass" | "warn" | "fail" | "info";
export interface Check { status: CheckStatus; message: string }
export interface DoctorResult { checks: Check[]; exitCode: 0 | 1 | 2 }

export interface DoctorOpts {
  cwd: string;
  configPath?: string;
  runtime?: string;
  model?: string;
  skipProbe?: boolean;
  userConfig?: boolean;
}

/** Injection seam so tests don't shell out to a real runtime. */
export interface DoctorDeps {
  cliInstalled?: (cmd: string) => boolean;
  probe?: (runtime: string, prompt: string, opts: ProbeOpts) => Promise<ProbeResult>;
}

const MIN_NODE = { major: 22, minor: 18 }; // package.json engines: ">=22.18"
const HARMLESS_PROMPT = "Reply with exactly: ok";

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
  const library: SkillInfo[] = [];
  const root = skillsRoot(skillsCwd);
  if (!existsSync(root)) {
    add("fail", `no .claude/skills/ directory under ${skillsCwd}`);
  } else {
    const dirs = skillFolders(skillsCwd);
    if (dirs.length === 0) {
      add("fail", `.claude/skills/ exists but contains no skill folders`);
    }
    for (const name of dirs) {
      const md = join(root, name, "SKILL.md");
      if (!existsSync(md)) { add("fail", `skill "${name}" missing SKILL.md`); continue; }
      const s = readSkillFile(md, name);
      if (!s.frontmatterName) add("fail", `skill "${name}" missing name: (in a --- frontmatter block)`);
      else if (s.frontmatterName !== name) add("warn", `skill "${name}" has name: "${s.frontmatterName}" (doesn't match folder name)`);
      if (!s.description) add("fail", `skill "${name}" missing description: (in a --- frontmatter block)`);
      library.push(s);
    }
    if (library.length > 0) add("pass", `found .claude/skills/ with ${library.length} skill${library.length === 1 ? "" : "s"}`);
  }
  const skillNames = new Set(library.map((s) => s.name));

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
    const need = kToCertify(cfg.threshold, cfg.conf);
    if (need > cfg.k) {
      add("warn", `threshold ${Math.round(cfg.threshold * 100)}% with k=${cfg.k} cannot certify a pass ` +
        `even on a perfect run — need k≥${need} (or lower the threshold)`);
    }
    if (cfg.userConfig) {
      add("warn", `userConfig is on: probes load your personal runtime config, so results won't reproduce in CI`);
    }
  }

  // 10-11. Runtime + a harmless live probe (verifies the CLI is installed AND authed)
  const model = cfg?.model ?? opts.model;
  add("info", `runtime: ${runtime}  model: ${model ?? "(runtime default)"}`);
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
    const settings: Omit<ProbeOpts, "cwd"> = {
      ...(cfg ? probeSettings(cfg) : {}),
      ...(model ? { model } : {}),
      ...(opts.userConfig ? { userConfig: true } : {}),
      timeoutMs: 60_000,
    };
    const r = await probe(runtime, HARMLESS_PROMPT, { cwd: skillsCwd, ...settings });
    if (r.status !== "ok") {
      add("fail", `${runtime} probe failed — check auth/login: ${r.error ?? "unknown error"}`);
    } else {
      add("pass", `${runtime} probe succeeded (CLI is authenticated)` +
        (r.env?.runtimeVersion ? ` — ${bin} ${r.env.runtimeVersion}` : "") +
        (r.env?.model && !model ? `, default model ${r.env.model}` : ""));
      // what the runtime ACTUALLY loads (only runtimes that report it)
      if (r.env?.loadedSkills && library.length) {
        const { missing } = loadProblems(r.env, library.map((s) => s.name), library);
        if (missing.length) {
          add("fail", `the runtime did not load: ${missing.join(", ")} — it rejected or ignored these ` +
            `SKILL.md files, so they can never fire`);
        } else {
          add("pass", `the runtime loads all ${library.length} library skill${library.length === 1 ? "" : "s"}`);
        }
        // built-ins load in every probe; a library skill sharing a built-in's name is ambiguous
        const empty = await withSandbox(skillsCwd, [], (sb) => probe(runtime, HARMLESS_PROMPT, { cwd: sb.cwd, ...settings }));
        const builtins = empty.status === "ok" ? empty.env?.loadedSkills ?? [] : [];
        const clash = library.filter((s) => builtins.includes(s.name) ||
          (s.frontmatterName !== undefined && builtins.includes(s.frontmatterName)));
        for (const s of clash) {
          add("warn", `skill "${s.name}" has the same name as a ${runtime} built-in skill — the two compete ` +
            `for the same trigger; consider renaming it`);
        }
        if (builtins.length) {
          add("info", `${builtins.length} ${runtime} built-in skill(s) load alongside your library in every probe ` +
            `(${builtins.slice(0, 8).join(", ")}${builtins.length > 8 ? ", …" : ""}) — they are part of the real ` +
            `environment and can steal triggers`);
        }
      }
    }
  }

  const hasFail = checks.some((c) => c.status === "fail");
  const hasWarn = checks.some((c) => c.status === "warn");
  const exitCode: 0 | 1 | 2 = hasFail ? 2 : hasWarn ? 1 : 0;
  return { checks, exitCode };
}
