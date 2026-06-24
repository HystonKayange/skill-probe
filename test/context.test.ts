import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildContextDir, runContextAudit } from "../src/context.ts";
import { ADAPTERS } from "../src/adapters/index.ts";
import type { ProbeResult, RuntimeAdapter } from "../src/types.ts";

/** Make a temp project with the named skills under .claude/skills/. */
function makeProject(skills: string[]): string {
  const root = mkdtempSync(join(tmpdir(), "skill-probe-test-"));
  for (const s of skills) {
    const dir = join(root, ".claude", "skills", s);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), `---\nname: ${s}\ndescription: the ${s} skill\n---\n# ${s}\n`);
  }
  return root;
}

const ok = (skill: string | null): ProbeResult => ({ status: "ok", skillFired: skill, trajectory: [], cost: 0 });

/** Fires `isoSkill` when run in isolation (any cwd != coLoadedCwd), `coSkill` when co-loaded. */
function cwdAwareAdapter(name: string, coLoadedCwd: string, isoSkill: string | null, coSkill: string | null): RuntimeAdapter {
  return { name, probe: async (_p, opts) => (opts.cwd === coLoadedCwd ? ok(coSkill) : ok(isoSkill)) };
}

test("buildContextDir copies ONLY the named skills", () => {
  const src = makeProject(["greeter", "welcomer", "committer"]);
  const { cwd, cleanup } = buildContextDir(src, ["greeter"]);
  try {
    const present = readdirSync(join(cwd, ".claude", "skills"));
    assert.deepEqual(present.sort(), ["greeter"]);
    assert.ok(existsSync(join(cwd, ".claude", "skills", "greeter", "SKILL.md")));
  } finally {
    cleanup();
    assert.ok(!existsSync(cwd), "cleanup removes the temp dir");
  }
});

test("buildContextDir throws on an unknown skill", () => {
  const src = makeProject(["greeter"]);
  assert.throws(() => buildContextDir(src, ["nope"]), /skill not found/);
});

test("flags interference: fires alone, suppressed (stolen) under load", async () => {
  const src = makeProject(["greeter", "welcomer"]);
  // isolation -> greeter fires; co-loaded -> welcomer steals it (greeter never fires)
  ADAPTERS["mock-ctx-theft"] = cwdAwareAdapter("mock-ctx-theft", src, "greeter", "welcomer");
  const r = await runContextAudit({
    runtime: "mock-ctx-theft", cwd: src, k: 8, threshold: 0.7, conf: 0.95,
    cases: [
      { prompt: "say hello", expected: "greeter" },
      { prompt: "what's the weather?", expected: null }, // decoy -> skipped
    ],
  });
  assert.equal(r.cases.length, 1, "decoy is not isolable, skipped");
  assert.deepEqual(r.skipped, ["what's the weather?"]);
  const c = r.cases[0]!;
  assert.equal(c.interference, true);
  assert.equal(c.isolation.rel.pHat, 1);
  assert.equal(c.coLoaded.rel.pHat, 0);
  assert.ok(c.deltaP < 0);
  assert.ok(c.fisherP < 0.05, `fisher p should be significant, got ${c.fisherP}`);
  assert.equal(r.exitCode, 1);
});

test("no interference when the skill fires the same alone and co-loaded", async () => {
  const src = makeProject(["greeter", "welcomer"]);
  ADAPTERS["mock-ctx-ok"] = cwdAwareAdapter("mock-ctx-ok", src, "greeter", "greeter");
  const r = await runContextAudit({
    runtime: "mock-ctx-ok", cwd: src, k: 6, threshold: 0.7, conf: 0.95,
    cases: [{ prompt: "say hello", expected: "greeter" }],
  });
  const c = r.cases[0]!;
  assert.equal(c.interference, false);
  assert.equal(c.deltaP, 0);
  assert.equal(r.exitCode, 0);
});

test("skips a case whose expected skill isn't in the library", async () => {
  const src = makeProject(["greeter"]);
  ADAPTERS["mock-ctx-skip"] = cwdAwareAdapter("mock-ctx-skip", src, "greeter", "greeter");
  const r = await runContextAudit({
    runtime: "mock-ctx-skip", cwd: src, k: 4, threshold: 0.7, conf: 0.95,
    cases: [{ prompt: "do x", expected: "ghost-skill" }],
  });
  assert.equal(r.cases.length, 0);
  assert.deepEqual(r.skipped, ["do x"]);
});
