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

/** Mock runtime: fires `target` iff the SKILL.md currently on disk contains TOKEN — so a rewrite
 * that adds TOKEN "improves triggering", letting us test the whole interleaved loop deterministically. */
function fileSensingAdapter(name: string, file: string, token: string): RuntimeAdapter {
  return {
    name,
    probe: async (): Promise<ProbeResult> => ({
      status: "ok",
      skillFired: readFileSync(file, "utf8").includes(token) ? "target" : null,
      trajectory: [], cost: 0,
    }),
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

test("fix REVERTS when the rewrite does not help", async () => {
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
