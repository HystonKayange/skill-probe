/** Child-process plumbing shared by the runtime adapters and the LLM CLI backend: one spawn with a
 * hard timeout, plus a registry of live children and temp dirs so Ctrl-C / SIGTERM never leaves
 * orphaned `claude` processes or sandbox directories behind. */
import { spawn, type ChildProcess } from "node:child_process";
import { rmSync } from "node:fs";

export interface ProcResult {
  /** exit code; null when killed by a signal or when the spawn itself failed */
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** set when the binary couldn't be started at all (e.g. ENOENT: not on PATH) */
  spawnError?: string;
}

const liveChildren = new Set<ChildProcess>();
/** temp dir -> extra cleanup to run alongside removing it */
const liveDirs = new Map<string, (() => void) | undefined>();

/** How long to wait for stdout/stderr to close after the child exits or is killed. A descendant
 * that inherited our pipes can hold them open forever; the timeout must still bound wall time. */
const PIPE_GRACE_MS = 1500;
const OWN_GROUP = process.platform !== "win32";

/** Kill the child and everything it spawned. Each child leads its own process group (detached),
 * so one signal to -pid reaches grandchildren too. Only while the leader is alive — once it has
 * exited, its group id could in principle be recycled, and we never signal a group we don't own. */
function killTree(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (OWN_GROUP) process.kill(-child.pid, "SIGKILL");
    else child.kill("SIGKILL");
  } catch {
    try { child.kill("SIGKILL"); } catch { /* already gone */ }
  }
}

/** Run `cmd args` in `cwd` with stdin closed (some CLIs hang waiting on an open stdin). Never
 * rejects: failures come back as data so callers can classify them as infrastructure errors.
 * Resolves within timeoutMs + PIPE_GRACE_MS no matter what the child's descendants do. */
export function runProcess(
  cmd: string, args: string[], opts: { cwd: string; timeoutMs: number; env?: NodeJS.ProcessEnv },
): Promise<ProcResult> {
  return new Promise<ProcResult>((resolve) => {
    let stdout = "", stderr = "", timedOut = false, settled = false;
    let exitCode: number | null = null;
    let grace: NodeJS.Timeout | undefined;
    const child = spawn(cmd, args, {
      cwd: opts.cwd, stdio: ["ignore", "pipe", "pipe"], detached: OWN_GROUP,
      ...(opts.env ? { env: opts.env } : {}),
    });
    liveChildren.add(child);
    const finish = (r: ProcResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(grace);
      liveChildren.delete(child);
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolve(r);
    };
    const finishSoon = (): void => {
      grace ??= setTimeout(() => finish({ code: exitCode, stdout, stderr, timedOut }), PIPE_GRACE_MS);
    };
    const timer = setTimeout(() => { timedOut = true; killTree(child); finishSoon(); }, opts.timeoutMs);
    child.stdout!.on("data", (d: Buffer) => { stdout += d.toString(); });
    child.stderr!.on("data", (d: Buffer) => { stderr += d.toString(); });
    child.on("error", (e: Error) => finish({ code: null, stdout, stderr, timedOut, spawnError: e.message }));
    child.on("exit", (code: number | null) => { exitCode = code; finishSoon(); });
    child.on("close", (code: number | null) => finish({ code, stdout, stderr, timedOut }));
  });
}

/** Track a temp dir so it's removed (plus `also`) even if the run is interrupted. */
export function trackTempDir(dir: string, also?: () => void): void { liveDirs.set(dir, also); }
export function untrackTempDir(dir: string): void { liveDirs.delete(dir); }

/** Kill live children and remove tracked temp dirs. Synchronous: safe inside an 'exit' handler. */
export function cleanupAll(): void {
  for (const c of liveChildren) killTree(c);
  liveChildren.clear();
  for (const [d, also] of liveDirs) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
    try { also?.(); } catch { /* best effort */ }
  }
  liveDirs.clear();
}

let installed = false;
/** For the CLI entry point only (library callers keep default signal behavior). */
export function installSignalHandlers(): void {
  if (installed) return;
  installed = true;
  process.on("exit", cleanupAll);
  for (const [sig, code] of [["SIGINT", 130], ["SIGTERM", 143]] as const) {
    process.on(sig, () => {
      process.stderr.write(`\nskill-probe: interrupted (${sig}) — stopping probes and cleaning up\n`);
      cleanupAll();
      process.exit(code);
    });
  }
}
