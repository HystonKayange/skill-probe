/** Probe sandboxes: throwaway project dirs holding a chosen subset of the library.
 *
 * Every condition that is COMPARED against another (context's isolation / co-loaded / ablation runs,
 * fix's before / after) must be built the same way, differing ONLY in which skills are present.
 * Comparing a sandbox against the real project dir confounds the skill set with everything else in
 * the project (CLAUDE.md, settings, files): a drop caused by the project's CLAUDE.md would read as
 * "interference", and every leave-one-out run would "recover" and name an innocent sibling.
 *
 * Each sandbox gets the project's instruction files (they shape routing, so they're held constant)
 * but not its settings/hooks/MCP config (side effects; can't run safely from another directory). */
import { mkdtempSync, mkdirSync, cpSync, rmSync, existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { skillsRoot } from "./skills.ts";
import { trackTempDir, untrackTempDir } from "./proc.ts";

/** Project instruction files copied into every sandbox, relative to the project root. */
export const INSTRUCTION_FILES = ["CLAUDE.md", "AGENTS.md", join(".claude", "CLAUDE.md")];

export interface Sandbox { cwd: string; skills: string[]; cleanup: () => void }

/** True if `dir` holds nothing but (recursively) empty directories. */
function onlyEmptyDirs(dir: string): boolean {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory() || !onlyEmptyDirs(join(dir, e.name))) return false;
  }
  return true;
}

/** Claude Code creates `<config>/projects/<cwd with non-alphanumerics as "-">/memory/` for every
 * working directory it starts in, even with --no-session-persistence. Each sandbox is a fresh path,
 * so without this a big context/ablation run would leave dozens of empty dirs per run. Removes the
 * dir for THIS sandbox path only, and only if it contains nothing but empty directories — it never
 * deletes a file. Exported for testing. */
export function removeRuntimeStateFor(sandboxPath: string, configDir?: string): void {
  const root = join(configDir ?? process.env["CLAUDE_CONFIG_DIR"] ?? join(homedir(), ".claude"), "projects");
  const paths = new Set([sandboxPath]);
  try { paths.add(realpathSync(sandboxPath)); } catch { /* already removed */ }
  for (const p of paths) {
    const dir = join(root, p.replace(/[^a-zA-Z0-9]/g, "-"));
    try {
      if (statSync(dir).isDirectory() && onlyEmptyDirs(dir)) rmSync(dir, { recursive: true });
    } catch { /* absent or unreadable — leave it */ }
  }
}

/** Build a sandbox whose .claude/skills/ holds exactly `skillNames` (copied from srcCwd, with any
 * supporting files) plus srcCwd's instruction files. Removed on cleanup() or on process exit. */
export function buildSandbox(srcCwd: string, skillNames: string[]): Sandbox {
  const root = mkdtempSync(join(tmpdir(), "skill-probe-"));
  let real = root;
  try { real = realpathSync(root); } catch { /* keep root */ }
  const forgetState = (): void => { removeRuntimeStateFor(root); if (real !== root) removeRuntimeStateFor(real); };
  trackTempDir(root, forgetState);
  const cleanup = (): void => {
    rmSync(root, { recursive: true, force: true });
    forgetState();
    untrackTempDir(root);
  };
  try {
    const destSkills = skillsRoot(root);
    mkdirSync(destSkills, { recursive: true });
    for (const name of skillNames) {
      const src = join(skillsRoot(srcCwd), name);
      if (!existsSync(src)) throw new Error(`skill not found in ${srcCwd}: ${name}`);
      // dereference: a symlinked SKILL.md (or skill folder) must become a real copy, or a write
      // into the sandbox would land in the user's real file
      cpSync(src, join(destSkills, name), { recursive: true, dereference: true });
    }
    for (const rel of INSTRUCTION_FILES) {
      const src = join(srcCwd, rel);
      if (!existsSync(src)) continue;
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      cpSync(src, join(root, rel), { dereference: true });
    }
  } catch (e) {
    cleanup();
    throw e;
  }
  return { cwd: root, skills: [...skillNames], cleanup };
}

/** Run `fn` inside a sandbox, always cleaning up. */
export async function withSandbox<T>(
  srcCwd: string, skillNames: string[], fn: (sb: Sandbox) => Promise<T>,
): Promise<T> {
  const sb = buildSandbox(srcCwd, skillNames);
  try { return await fn(sb); } finally { sb.cleanup(); }
}
