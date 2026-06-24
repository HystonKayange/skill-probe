import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDoctor, type DoctorDeps } from "../src/doctor.ts";
import type { ProbeResult } from "../src/types.ts";

/** A project with skills; each entry is [folder, frontmatterName|null, description|null]. */
function makeProject(skills: Array<[string, string | null, string | null]>): string {
  const root = mkdtempSync(join(tmpdir(), "skill-probe-doc-"));
  for (const [folder, name, desc] of skills) {
    const dir = join(root, ".claude", "skills", folder);
    mkdirSync(dir, { recursive: true });
    const fm = ["---"];
    if (name !== null) fm.push(`name: ${name}`);
    if (desc !== null) fm.push(`description: ${desc}`);
    fm.push("---", `# ${folder}`, "");
    writeFileSync(join(dir, "SKILL.md"), fm.join("\n"));
  }
  return root;
}
const has = (r: { checks: { status: string; message: string }[] }, status: string, re: RegExp) =>
  r.checks.some((c) => c.status === status && re.test(c.message));

// healthy deps: CLI present, probe authenticates
const okDeps: DoctorDeps = {
  cliInstalled: () => true,
  probe: async (): Promise<ProbeResult> => ({ status: "ok", skillFired: null, trajectory: [], cost: 0 }),
};

test("healthy project: all pass, exit 0", async () => {
  const src = makeProject([["greeter", "greeter", "say hi"], ["welcomer", "welcomer", "welcome them"]]);
  try {
    const r = await runDoctor({ cwd: src }, okDeps);
    assert.equal(r.exitCode, 0, JSON.stringify(r.checks, null, 2));
    assert.ok(has(r, "pass", /found .claude\/skills\/ with 2 skills/));
    assert.ok(has(r, "pass", /claude CLI found/));
    assert.ok(has(r, "pass", /probe succeeded/));
  } finally { rmSync(src, { recursive: true, force: true }); }
});

test("missing description is a hard FAIL (exit 2)", async () => {
  const src = makeProject([["greeter", "greeter", null]]);
  try {
    const r = await runDoctor({ cwd: src }, okDeps);
    assert.ok(has(r, "fail", /greeter.*missing description/));
    assert.equal(r.exitCode, 2);
  } finally { rmSync(src, { recursive: true, force: true }); }
});

test("name not matching the folder is a WARN", async () => {
  const src = makeProject([["greeter", "greetings", "say hi"]]);
  try {
    const r = await runDoctor({ cwd: src }, okDeps);
    assert.ok(has(r, "warn", /name: "greetings".*doesn't match folder/));
  } finally { rmSync(src, { recursive: true, force: true }); }
});

test("no .claude/skills/ dir is a FAIL", async () => {
  const empty = mkdtempSync(join(tmpdir(), "skill-probe-doc-empty-"));
  try {
    const r = await runDoctor({ cwd: empty }, okDeps);
    assert.ok(has(r, "fail", /no .claude\/skills\//));
    assert.equal(r.exitCode, 2);
  } finally { rmSync(empty, { recursive: true, force: true }); }
});

test("config: infeasible threshold/k is a WARN (exit 1, not 2)", async () => {
  const src = makeProject([["greeter", "greeter", "say hi"]]);
  const cfgPath = join(src, "probe.config.json");
  writeFileSync(cfgPath, JSON.stringify({
    runtime: "claude-code", cwd: ".", k: 10, threshold: 0.9, conf: 0.95,
    cases: [{ prompt: "hi", expected: "greeter" }],
  }));
  try {
    const r = await runDoctor({ cwd: src, configPath: cfgPath }, okDeps);
    assert.ok(has(r, "warn", /threshold 90% with k=10 cannot certify/));
    assert.ok(has(r, "pass", /expected skills all exist/));
    assert.equal(r.exitCode, 1);
  } finally { rmSync(src, { recursive: true, force: true }); }
});

test("config: expected skill not in library is a FAIL", async () => {
  const src = makeProject([["greeter", "greeter", "say hi"]]);
  const cfgPath = join(src, "probe.config.json");
  writeFileSync(cfgPath, JSON.stringify({
    runtime: "claude-code", cwd: ".", k: 10, threshold: 0.7, conf: 0.95,
    cases: [{ prompt: "hi", expected: "greter" }], // typo
  }));
  try {
    const r = await runDoctor({ cwd: src, configPath: cfgPath }, okDeps);
    assert.ok(has(r, "fail", /not in the library: greter/));
    assert.equal(r.exitCode, 2);
  } finally { rmSync(src, { recursive: true, force: true }); }
});

test("config: only-decoys is a WARN", async () => {
  const src = makeProject([["greeter", "greeter", "say hi"]]);
  const cfgPath = join(src, "probe.config.json");
  writeFileSync(cfgPath, JSON.stringify({
    runtime: "claude-code", cwd: ".", k: 10, threshold: 0.7, conf: 0.95,
    cases: [{ prompt: "weather?", expected: null }],
  }));
  try {
    const r = await runDoctor({ cwd: src, configPath: cfgPath }, okDeps);
    assert.ok(has(r, "warn", /only decoy cases/));
  } finally { rmSync(src, { recursive: true, force: true }); }
});

test("runtime CLI missing is a FAIL and the probe is skipped", async () => {
  const src = makeProject([["greeter", "greeter", "say hi"]]);
  try {
    const r = await runDoctor({ cwd: src }, { cliInstalled: () => false, probe: okDeps.probe });
    assert.ok(has(r, "fail", /claude CLI not found/));
    assert.ok(!has(r, "pass", /probe succeeded/)); // never probed without a CLI
    assert.equal(r.exitCode, 2);
  } finally { rmSync(src, { recursive: true, force: true }); }
});

test("a failing probe (bad auth) is a FAIL", async () => {
  const src = makeProject([["greeter", "greeter", "say hi"]]);
  try {
    const r = await runDoctor({ cwd: src }, {
      cliInstalled: () => true,
      probe: async (): Promise<ProbeResult> => ({ status: "error", skillFired: null, trajectory: [], cost: 0, error: "not logged in" }),
    });
    assert.ok(has(r, "fail", /probe failed.*not logged in/));
    assert.equal(r.exitCode, 2);
  } finally { rmSync(src, { recursive: true, force: true }); }
});

test("--skip-probe avoids the live call but still validates the rest", async () => {
  const src = makeProject([["greeter", "greeter", "say hi"]]);
  let probed = false;
  try {
    const r = await runDoctor({ cwd: src, skipProbe: true }, {
      cliInstalled: () => true,
      probe: async (): Promise<ProbeResult> => { probed = true; return { status: "ok", skillFired: null, trajectory: [], cost: 0 }; },
    });
    assert.equal(probed, false);
    assert.ok(has(r, "info", /probe skipped/));
    assert.equal(r.exitCode, 0);
  } finally { rmSync(src, { recursive: true, force: true }); }
});
