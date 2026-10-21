import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runProcess, trackTempDir, cleanupAll } from "../src/proc.ts";
import { mapPool } from "../src/orchestrator.ts";
import { buildSandbox } from "../src/sandbox.ts";
import { tempDir } from "./helpers.ts";

test("runProcess captures output and exit code", async () => {
  const r = await runProcess(process.execPath, ["-e", "process.stdout.write('hi'); process.stderr.write('err'); process.exit(3)"], { cwd: tmpdir(), timeoutMs: 10_000 });
  assert.equal(r.stdout, "hi");
  assert.equal(r.stderr, "err");
  assert.equal(r.code, 3);
  assert.equal(r.timedOut, false);
});

test("runProcess kills a hung child at the timeout", async () => {
  const t0 = Date.now();
  const r = await runProcess(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { cwd: tmpdir(), timeoutMs: 300 });
  assert.equal(r.timedOut, true);
  assert.ok(Date.now() - t0 < 5000);
});

test("runProcess reports a missing binary as data, never a throw", async () => {
  const r = await runProcess("definitely-not-a-real-binary-xyz", [], { cwd: tmpdir(), timeoutMs: 5000 });
  assert.match(r.spawnError!, /ENOENT/);
});

test("cleanupAll removes tracked sandboxes (the Ctrl-C path)", () => {
  const d = mkdtempSync(join(tmpdir(), "skp-track-"));
  trackTempDir(d);
  const sb = buildSandbox(d, []);
  assert.ok(existsSync(sb.cwd));
  cleanupAll();
  assert.ok(!existsSync(d) && !existsSync(sb.cwd));
});

test("mapPool keeps order and never exceeds the concurrency bound", async () => {
  let inFlight = 0, peak = 0;
  const out = await mapPool([5, 1, 4, 2, 3], 2, async (x) => {
    inFlight++; peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, x));
    inFlight--;
    return x * 10;
  });
  assert.deepEqual(out, [50, 10, 40, 20, 30]);
  assert.equal(peak, 2);
  assert.deepEqual(await mapPool([], 4, async (x) => x), []);
});

test("removeRuntimeStateFor deletes only an all-empty state dir for that exact sandbox path", async () => {
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const { removeRuntimeStateFor } = await import("../src/sandbox.ts");
  const config = tempDir("skp-cfg-");
  const key = (p: string) => join(config, "projects", p.replace(/[^a-zA-Z0-9]/g, "-"));
  // empty memory dir (what Claude Code leaves behind) → removed
  mkdirSync(join(key("/tmp/skill-probe-AAA"), "memory"), { recursive: true });
  removeRuntimeStateFor("/tmp/skill-probe-AAA", config);
  assert.ok(!existsSync(key("/tmp/skill-probe-AAA")));
  // anything with a file in it → kept
  mkdirSync(join(key("/tmp/skill-probe-BBB"), "memory"), { recursive: true });
  writeFileSync(join(key("/tmp/skill-probe-BBB"), "memory", "note.md"), "keep me");
  removeRuntimeStateFor("/tmp/skill-probe-BBB", config);
  assert.ok(existsSync(join(key("/tmp/skill-probe-BBB"), "memory", "note.md")));
  // a different path's dir → untouched
  mkdirSync(key("/tmp/other"), { recursive: true });
  removeRuntimeStateFor("/tmp/skill-probe-AAA", config);
  assert.ok(existsSync(key("/tmp/other")));
});

const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };

test("a timeout kills the whole process tree, grandchildren included", { skip: process.platform === "win32" }, async () => {
  // the child spawns a grandchild that inherits stdout, prints its pid, and both hang
  const script = `
    const { spawn } = require("node:child_process");
    const g = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: ["ignore", "inherit", "inherit"] });
    console.log(g.pid);
    setInterval(() => {}, 1000);`;
  const t0 = Date.now();
  const r = await runProcess(process.execPath, ["-e", script], { cwd: tmpdir(), timeoutMs: 500 });
  assert.equal(r.timedOut, true);
  assert.ok(Date.now() - t0 < 4000, `resolved after ${Date.now() - t0}ms`);
  const grandchild = Number(r.stdout.trim());
  assert.ok(grandchild > 0);
  await new Promise((res) => setTimeout(res, 200));
  assert.equal(alive(grandchild), false, "grandchild was killed with the group");
});

test("a descendant holding our pipes after the child exits can't hang the caller", { skip: process.platform === "win32" }, async () => {
  // the child exits at once, leaving a fully detached grandchild (its own session) on our stdout
  const script = `
    const { spawn } = require("node:child_process");
    const g = spawn(process.execPath, ["-e", "setTimeout(() => {}, 8000)"], { stdio: ["ignore", "inherit", "inherit"], detached: true });
    console.log(g.pid);
    g.unref();`;
  const t0 = Date.now();
  const r = await runProcess(process.execPath, ["-e", script], { cwd: tmpdir(), timeoutMs: 30_000 });
  assert.ok(Date.now() - t0 < 5000, `resolved after ${Date.now() - t0}ms`);
  assert.equal(r.code, 0);
  assert.equal(r.timedOut, false);
  try { process.kill(Number(r.stdout.trim()), "SIGKILL"); } catch { /* gone */ }
});
