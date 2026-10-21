import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runFix } from "../src/fix.ts";
import { ADAPTERS } from "../src/adapters/index.ts";
import type { ProbeResult, RuntimeAdapter } from "../src/types.ts";

function setupSkills(): { cwd: string; file: string } {
  const cwd = mkdtempSync(join(tmpdir(), "skp-"));
  const root = join(cwd, ".claude", "skills");
  mkdirSync(join(root, "target"), { recursive: true });
  mkdirSync(join(root, "sibling"), { recursive: true });
  writeFileSync(join(root, "target", "SKILL.md"), "---\nname: target\ndescription: old terse desc\n---\nbody\n");
  writeFileSync(join(root, "sibling", "SKILL.md"), "---\nname: sibling\ndescription: does other stuff\n---\nbody\n");
  return { cwd, file: join(root, "target", "SKILL.md") };
}

/** Mock runtime: fires `target` iff the SKILL.md in the probe's project dir contains TOKEN — so a
 * rewrite that adds TOKEN "improves triggering", letting us test the whole paired loop
 * deterministically. `onProbe` lets a test observe (or tamper with) the world mid-run. */
function fileSensingAdapter(name: string, _file: string, token: string, onProbe?: (cwd: string) => void): RuntimeAdapter {
  return {
    name,
    probe: async (_p, opts): Promise<ProbeResult> => {
      onProbe?.(opts.cwd);
      const md = join(opts.cwd, ".claude", "skills", "target", "SKILL.md");
      return {
        status: "ok",
        skillFired: readFileSync(md, "utf8").includes(token) ? "target" : null,
        trajectory: [], cost: 0,
      };
    },
  };
}

test("fix APPLIES when the rewrite proves a real lift (Bayesian)", async () => {
  const { cwd, file } = setupSkills();
  ADAPTERS["mock-fix"] = fileSensingAdapter("mock-fix", file, "TRIGGER");
  const r = await runFix(
    { runtime: "mock-fix", cwd, k: 5, threshold: 0.7, conf: 0.95, cases: [{ prompt: "do target thing", expected: "target" }] },
    { skill: "target", k: 5, applyBar: 0.9 },
    { rewrite: async () => "TRIGGER do the target thing reliably" },
  );
  assert.equal(r.applied, true);
  assert.ok(r.pImprove > 0.9, `pImprove=${r.pImprove}`);
  assert.equal(r.before.pHat, 0);
  assert.equal(r.after.pHat, 1);
  assert.ok(readFileSync(file, "utf8").includes("TRIGGER"));               // new desc committed
  assert.ok(r.backupPath && existsSync(r.backupPath));                     // timestamped backup kept
  assert.ok(readFileSync(r.backupPath!, "utf8").includes("old terse desc")); // backup = exact original
  rmSync(cwd, { recursive: true, force: true });
});

test("fix does NOT apply when the rewrite does not help", async () => {
  const { cwd, file } = setupSkills();
  ADAPTERS["mock-fix2"] = fileSensingAdapter("mock-fix2", file, "TRIGGER");
  const r = await runFix(
    { runtime: "mock-fix2", cwd, k: 5, threshold: 0.7, conf: 0.95, cases: [{ prompt: "do target thing", expected: "target" }] },
    { skill: "target", k: 5, applyBar: 0.9 },
    { rewrite: async () => "still no magic token in here" },              // doesn't fix triggering
  );
  assert.equal(r.applied, false);
  assert.ok(r.pImprove < 0.9);
  assert.equal(r.backupPath, null);                                        // no backup kept on revert
  assert.ok(readFileSync(file, "utf8").includes("old terse desc"));        // reverted to original
  assert.equal(readdirSync(join(cwd, ".claude", "skills", "target")).filter((f) => f.includes(".bak")).length, 0);
  rmSync(cwd, { recursive: true, force: true });
});

test("fix errors clearly when no config case targets the skill", async () => {
  const { cwd } = setupSkills();
  ADAPTERS["mock-fix3"] = fileSensingAdapter("mock-fix3", join(cwd, "x"), "T");
  await assert.rejects(
    () => runFix(
      { runtime: "mock-fix3", cwd, k: 3, threshold: 0.7, conf: 0.95, cases: [{ prompt: "p", expected: "other" }] },
      { skill: "target", k: 3, applyBar: 0.9 },
      { rewrite: async () => "x" },
    ),
    /no cases in the config expect skill 'target'/,
  );
  rmSync(cwd, { recursive: true, force: true });
});

test("the real SKILL.md is never touched while the experiment runs (interrupt-safe)", async () => {
  const { cwd, file } = setupSkills();
  const original = readFileSync(file, "utf8");
  let probes = 0;
  ADAPTERS["mock-fix-untouched"] = fileSensingAdapter("mock-fix-untouched", file, "TRIGGER", (probeCwd) => {
    probes++;
    assert.notEqual(probeCwd, cwd, "probes run in sandboxes, not the real project");
    assert.equal(readFileSync(file, "utf8"), original, "real file unchanged mid-run");
  });
  const r = await runFix(
    { runtime: "mock-fix-untouched", cwd, k: 3, threshold: 0.7, conf: 0.95, cases: [{ prompt: "p", expected: "target" }] },
    { skill: "target", k: 3, applyBar: 0.9 },
    { rewrite: async () => "TRIGGER better" },
  );
  assert.equal(probes, 6, "3 pairs = 6 probes");
  assert.equal(r.applied, true);
  rmSync(cwd, { recursive: true, force: true });
});

test("fix refuses to overwrite a SKILL.md that changed on disk during the run", async () => {
  const { cwd, file } = setupSkills();
  ADAPTERS["mock-fix-race"] = fileSensingAdapter("mock-fix-race", file, "TRIGGER", () => {
    writeFileSync(file, readFileSync(file, "utf8").replace("body", "body edited by a human"));
  });
  const r = await runFix(
    { runtime: "mock-fix-race", cwd, k: 3, threshold: 0.7, conf: 0.95, cases: [{ prompt: "p", expected: "target" }] },
    { skill: "target", k: 3, applyBar: 0.9 },
    { rewrite: async () => "TRIGGER better" },
  );
  assert.equal(r.applied, false);
  assert.match(r.note!, /changed on disk/);
  assert.ok(readFileSync(file, "utf8").includes("edited by a human"), "the human's edit survives");
  assert.ok(!readFileSync(file, "utf8").includes("TRIGGER"));
  rmSync(cwd, { recursive: true, force: true });
});

test("fix rewrites a multi-line (block scalar) description and keeps the rest of the file", async () => {
  const { cwd, file } = setupSkills();
  writeFileSync(file, "---\nname: target\ndescription: >-\n  old folded\n  description\nallowed-tools: Read\n---\nbody\n");
  ADAPTERS["mock-fix-block"] = fileSensingAdapter("mock-fix-block", file, "TRIGGER");
  let seenOld = "";
  const r = await runFix(
    { runtime: "mock-fix-block", cwd, k: 4, threshold: 0.7, conf: 0.95, cases: [{ prompt: "p", expected: "target" }] },
    { skill: "target", k: 4, applyBar: 0.9 },
    { rewrite: async (_s, cur) => { seenOld = cur; return "TRIGGER: new one-liner"; } },
  );
  assert.equal(seenOld, "old folded description", "the LLM saw the real description, not '>-'");
  assert.equal(r.applied, true);
  assert.equal(readFileSync(file, "utf8"),
    '---\nname: target\ndescription: "TRIGGER: new one-liner"\nallowed-tools: Read\n---\nbody\n');
  rmSync(cwd, { recursive: true, force: true });
});

test("an identical rewrite isn't tested (no probes spent)", async () => {
  const { cwd, file } = setupSkills();
  let probes = 0;
  ADAPTERS["mock-fix-same"] = fileSensingAdapter("mock-fix-same", file, "T", () => { probes++; });
  const r = await runFix(
    { runtime: "mock-fix-same", cwd, k: 3, threshold: 0.7, conf: 0.95, cases: [{ prompt: "p", expected: "target" }] },
    { skill: "target", k: 3, applyBar: 0.9 },
    { rewrite: async () => "old terse desc" },
  );
  assert.equal(probes, 0);
  assert.equal(r.applied, false);
  assert.match(r.note!, /identical/);
  rmSync(cwd, { recursive: true, force: true });
});

test("fix never writes through a symlinked SKILL.md into the real (shared) file", async () => {
  // regression: the sandbox copied the symlink as a symlink, so writing the candidate description
  // into the "after" sandbox overwrote the user's real file — with no backup
  const { symlinkSync } = await import("node:fs");
  const { cwd } = setupSkills();
  const shared = join(cwd, "shared-target.md");
  const original = "---\nname: target\ndescription: old terse desc\n---\nbody\n";
  writeFileSync(shared, original);
  const link = join(cwd, ".claude", "skills", "target", "SKILL.md");
  rmSync(link);
  symlinkSync(shared, link);
  ADAPTERS["mock-fix-symlink"] = fileSensingAdapter("mock-fix-symlink", link, "TRIGGER", () => {
    assert.equal(readFileSync(shared, "utf8"), original, "shared file untouched mid-run");
  });
  const r = await runFix(
    { runtime: "mock-fix-symlink", cwd, k: 3, threshold: 0.7, conf: 0.95, cases: [{ prompt: "p", expected: "target" }] },
    { skill: "target", k: 3, applyBar: 0.9 },
    { rewrite: async () => "TRIGGER better" },
  );
  assert.equal(r.before.pHat, 0, "the before arm really saw the old description");
  assert.equal(r.applied, true);
  assert.ok(readFileSync(shared, "utf8").includes("TRIGGER"), "the proven rewrite is written through the link at the end");
  assert.equal(readFileSync(r.backupPath!, "utf8"), original);
  rmSync(cwd, { recursive: true, force: true });
});

test("fix refuses an unrewritable description BEFORE paying for an LLM rewrite", async () => {
  const { cwd, file } = setupSkills();
  writeFileSync(file, '---\nname: target\ndescription: "unterminated\n---\nbody\n');
  let rewrites = 0;
  ADAPTERS["mock-fix-broken"] = fileSensingAdapter("mock-fix-broken", file, "T");
  await assert.rejects(
    () => runFix(
      { runtime: "mock-fix-broken", cwd, k: 3, threshold: 0.7, conf: 0.95, cases: [{ prompt: "p", expected: "target" }] },
      { skill: "target", k: 3, applyBar: 0.9 },
      { rewrite: async () => { rewrites++; return "x"; } },
    ),
    /unterminated quote/,
  );
  assert.equal(rewrites, 0);
  rmSync(cwd, { recursive: true, force: true });
});
