import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { listSkills, generateCases, genConfig, type SkillInfo } from "../src/gen.ts";

function setup(): string {
  const cwd = mkdtempSync(join(tmpdir(), "skp-gen-"));
  const root = join(cwd, ".claude", "skills");
  mkdirSync(join(root, "alpha"), { recursive: true });
  mkdirSync(join(root, "beta"), { recursive: true });
  writeFileSync(join(root, "alpha", "SKILL.md"), "---\nname: alpha\ndescription: do alpha things\n---\nbody\n");
  writeFileSync(join(root, "beta", "SKILL.md"), "---\nname: beta\ndescription: do beta things\n---\nbody\n");
  return cwd;
}

test("listSkills reads name + description from each SKILL.md", () => {
  const cwd = setup();
  const skills = listSkills(cwd).sort((a, b) => a.name.localeCompare(b.name));
  assert.deepEqual(skills, [
    { name: "alpha", description: "do alpha things" },
    { name: "beta", description: "do beta things" },
  ]);
  rmSync(cwd, { recursive: true, force: true });
});

test("listSkills throws clearly when there is no skills dir", () => {
  const cwd = mkdtempSync(join(tmpdir(), "skp-empty-"));
  assert.throws(() => listSkills(cwd), /no \.claude\/skills/);
  rmSync(cwd, { recursive: true, force: true });
});

test("generateCases keeps valid cases and DROPS hallucinated skill names", async () => {
  const skills: SkillInfo[] = [{ name: "alpha", description: "x" }, { name: "beta", description: "y" }];
  const mockGen = async () => ([
    { prompt: "do an alpha", expected: "alpha" },
    { prompt: "do a beta", expected: "beta" },
    { prompt: "weather?", expected: null },
    { prompt: "bad one", expected: "ghost-skill" }, // hallucinated -> must be dropped
    { prompt: "", expected: "alpha" },               // empty prompt -> dropped
  ]);
  const cases = await generateCases(skills, { perSkill: 2, decoys: 1 }, { generate: mockGen as never });
  assert.equal(cases.length, 3);
  assert.ok(!cases.some((c) => c.expected === "ghost-skill"));
  assert.ok(cases.some((c) => c.expected === null));
});

test("genConfig wraps cases with runnable defaults", () => {
  const cfg = genConfig([{ prompt: "p", expected: "alpha" }]);
  assert.equal(cfg.runtime, "claude-code");
  assert.equal(cfg.cwd, ".");
  assert.equal(cfg.k, 10);
  assert.equal(cfg.threshold, 0.7);
  assert.equal(cfg.cases.length, 1);
});
