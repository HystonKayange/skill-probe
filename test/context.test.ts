import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildContextDir, runContextAudit } from "../src/context.ts";
import { ADAPTERS } from "../src/adapters/index.ts";
import { renderContext } from "../src/report.ts";
import type { ProbeResult, RuntimeAdapter } from "../src/types.ts";
import { tempDir } from "./helpers.ts";

/** Make a temp project with the named skills under .claude/skills/. */
function makeProject(skills: string[]): string {
  const root = tempDir("skill-probe-test-");
  for (const s of skills) {
    const dir = join(root, ".claude", "skills", s);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), `---\nname: ${s}\ndescription: the ${s} skill\n---\n# ${s}\n`);
  }
  return root;
}

const ok = (skill: string | null): ProbeResult => ({ status: "ok", skillFired: skill, trajectory: [], cost: 0 });
const err = (msg: string): ProbeResult => ({ status: "error", skillFired: null, trajectory: [], cost: 0, error: msg });

/** The skills present in a probe's project dir — what a real runtime would load. */
const skillsIn = (cwd: string): string[] =>
  existsSync(join(cwd, ".claude", "skills")) ? readdirSync(join(cwd, ".claude", "skills")).sort() : [];

/** Fires `isoSkill` when only one skill is present (isolation), `coSkill` when the library is. */
function cwdAwareAdapter(name: string, isoSkill: string | null, coSkill: string | null): RuntimeAdapter {
  return { name, probe: async (_p, opts) => (skillsIn(opts.cwd).length === 1 ? ok(isoSkill) : ok(coSkill)) };
}

test("buildContextDir copies ONLY the named skills (plus project instruction files)", () => {
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
  ADAPTERS["mock-ctx-theft"] = cwdAwareAdapter("mock-ctx-theft", "greeter", "welcomer");
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
  ADAPTERS["mock-ctx-ok"] = cwdAwareAdapter("mock-ctx-ok", "greeter", "greeter");
  const r = await runContextAudit({
    runtime: "mock-ctx-ok", cwd: src, k: 6, threshold: 0.7, conf: 0.95,
    cases: [{ prompt: "say hello", expected: "greeter" }],
  });
  const c = r.cases[0]!;
  assert.equal(c.interference, false);
  assert.equal(c.deltaP, 0);
  assert.equal(r.exitCode, 0);
});

test("multi-case runs are BH-corrected: adjusted p >= raw p, real thefts still flagged", async () => {
  const src = makeProject(["greeter", "welcomer"]);
  // per-PROMPT behavior: two theft cases (welcomer steals when co-loaded) + one clean case
  ADAPTERS["mock-ctx-bh"] = {
    name: "mock-ctx-bh",
    probe: async (prompt, opts) => {
      if (skillsIn(opts.cwd).length === 1) return ok("greeter");    // isolation: always fires
      return ok(prompt.startsWith("steal") ? "welcomer" : "greeter"); // co-loaded
    },
  };
  const r = await runContextAudit({
    runtime: "mock-ctx-bh", cwd: src, k: 8, threshold: 0.7, conf: 0.95,
    cases: [
      { prompt: "steal one", expected: "greeter" },
      { prompt: "steal two", expected: "greeter" },
      { prompt: "clean case", expected: "greeter" },
    ],
  });
  assert.equal(r.cases.length, 3);
  const [s1, s2, clean] = r.cases as [typeof r.cases[0], typeof r.cases[0], typeof r.cases[0]];
  // the family correction is visible: adjusted p is never below raw p
  for (const c of r.cases) {
    assert.ok(c.fisherPAdj >= c.fisherP - 1e-12, `adj ${c.fisherPAdj} < raw ${c.fisherP}`);
  }
  // with equal-strength thefts (m=3, two small p's + one p=1) the shared adjusted p is
  // raw * 3/2 — strictly larger than raw, but still well under 0.05: both stay flagged
  assert.ok(s1.fisherPAdj > s1.fisherP, "correction actually applied");
  assert.equal(s1.interference, true);
  assert.equal(s2.interference, true);
  assert.equal(clean.interference, false);
  assert.equal(clean.fisherPAdj, 1);
  assert.equal(r.exitCode, 1);
});

test("an unknown expected skill name is a CONFIG ERROR, not a silent skip (#2)", async () => {
  const src = makeProject(["greeter"]);
  ADAPTERS["mock-ctx-typo"] = cwdAwareAdapter("mock-ctx-typo", "greeter", "greeter");
  await assert.rejects(
    () => runContextAudit({
      runtime: "mock-ctx-typo", cwd: src, k: 4, threshold: 0.7, conf: 0.95,
      cases: [{ prompt: "do x", expected: "greter" }], // typo of "greeter"
    }),
    /not in .*\.claude\/skills|greter/,
  );
});

/** Two thieves in the co-loaded outcomes; removing `welcomer` restores activation, removing
 * `other` doesn't. Ablation must rank welcomer first (stole more) and name ONLY it. */
function twoThiefAdapter(name: string): RuntimeAdapter {
  let coCalls = 0;
  return {
    name,
    probe: async (_p, opts) => {
      const has = (s: string) => existsSync(join(opts.cwd, ".claude", "skills", s));
      if (!has("welcomer")) return ok("greeter");     // isolation, or welcomer ablated → recovers
      if (has("other")) {                             // co-loaded: welcomer steals 2, other steals 1
        return ok(coCalls++ % 3 === 1 ? "other" : "welcomer");
      }
      return ok("welcomer");                          // other ablated: welcomer still steals
    },
  };
}

test("ablation names the thief: ranked by stolen probes, only the real culprit flagged", async () => {
  const src = makeProject(["greeter", "welcomer", "other"]);
  ADAPTERS["mock-ctx-loo"] = twoThiefAdapter("mock-ctx-loo");
  const r = await runContextAudit(
    { runtime: "mock-ctx-loo", cwd: src, k: 8, threshold: 0.7, conf: 0.95,
      cases: [{ prompt: "say hello", expected: "greeter" }] },
    { ablate: true },
  );
  const c = r.cases[0]!;
  assert.equal(c.interference, true);
  assert.ok(c.ablation && c.ablation.length === 2, "both suspects ablated");
  const [first, second] = c.ablation!;
  // ranked by probes stolen in the co-loaded run: welcomer (2) before other (1)
  assert.equal(first!.removed, "welcomer");
  assert.equal(second!.removed, "other");
  assert.ok(first!.stolen > second!.stolen);
  // removing welcomer restores activation — significant even after BH; removing other doesn't
  assert.equal(first!.culprit, true);
  assert.ok(first!.deltaVsCoLoaded > 0);
  assert.ok(first!.fisherPAdj < 0.05, `adj p=${first!.fisherPAdj}`);
  assert.ok(first!.fisherPAdj >= first!.fisherP - 1e-12, "ablation family is BH-corrected");
  assert.equal(second!.culprit, false);
  assert.equal(r.exitCode, 1);
  // and the report says it out loud
  const text = renderContext(r);
  assert.match(text, /THIEF \(full recovery\)/);
  assert.match(text, /thieves named: welcomer/);
  assert.doesNotMatch(text, /thieves named:.*other/);
});

test("ablation respects the --suspects cap", async () => {
  const src = makeProject(["greeter", "welcomer", "other"]);
  ADAPTERS["mock-ctx-loo-cap"] = twoThiefAdapter("mock-ctx-loo-cap");
  const r = await runContextAudit(
    { runtime: "mock-ctx-loo-cap", cwd: src, k: 8, threshold: 0.7, conf: 0.95,
      cases: [{ prompt: "say hello", expected: "greeter" }] },
    { ablate: true, suspects: 1 },
  );
  const c = r.cases[0]!;
  assert.equal(c.ablation!.length, 1, "capped to the top suspect");
  assert.equal(c.ablation![0]!.removed, "welcomer");
});

test("without --ablate, no ablation runs happen (default unchanged)", async () => {
  const src = makeProject(["greeter", "welcomer"]);
  ADAPTERS["mock-ctx-noabl"] = cwdAwareAdapter("mock-ctx-noabl", "greeter", "welcomer");
  const r = await runContextAudit({
    runtime: "mock-ctx-noabl", cwd: src, k: 8, threshold: 0.7, conf: 0.95,
    cases: [{ prompt: "say hello", expected: "greeter" }],
  });
  assert.equal(r.cases[0]!.ablation, undefined);
});

test("ablation with no named thief (suppressed to None) reports dilution, not theft", async () => {
  const src = makeProject(["greeter", "welcomer"]);
  // co-loaded: nothing fires at all — no sibling in the outcomes to ablate
  ADAPTERS["mock-ctx-dilut"] = cwdAwareAdapter("mock-ctx-dilut", "greeter", null);
  const r = await runContextAudit(
    { runtime: "mock-ctx-dilut", cwd: src, k: 8, threshold: 0.7, conf: 0.95,
      cases: [{ prompt: "say hello", expected: "greeter" }] },
    { ablate: true },
  );
  const c = r.cases[0]!;
  assert.equal(c.interference, true);
  assert.deepEqual(c.ablation, []);
  assert.match(renderContext(r), /dilution, not theft/);
});

test("infra errors do NOT false-pass — untrustworthy case exits 2 (#1)", async () => {
  const src = makeProject(["greeter"]);
  ADAPTERS["mock-ctx-allerr"] = { name: "mock-ctx-allerr", probe: async () => err("unauthenticated") };
  const r = await runContextAudit({
    runtime: "mock-ctx-allerr", cwd: src, k: 4, threshold: 0.7, conf: 0.95,
    cases: [{ prompt: "say hello", expected: "greeter" }],
  });
  const c = r.cases[0]!;
  assert.equal(c.untrustworthy, true);
  assert.equal(c.interference, false);   // critically NOT silently "ok"
  assert.equal(r.exitCode, 2);           // and NOT 0
});

test("every condition runs in a sandbox — never the real project dir", async () => {
  const src = makeProject(["greeter", "welcomer"]);
  writeFileSync(join(src, "CLAUDE.md"), "project instructions\n");
  const seen: Array<{ cwd: string; skills: string[]; hasClaudeMd: boolean }> = [];
  ADAPTERS["mock-ctx-where"] = {
    name: "mock-ctx-where",
    probe: async (_p, opts) => {
      seen.push({ cwd: opts.cwd, skills: skillsIn(opts.cwd), hasClaudeMd: existsSync(join(opts.cwd, "CLAUDE.md")) });
      return ok("greeter");
    },
  };
  await runContextAudit({
    runtime: "mock-ctx-where", cwd: src, k: 4, threshold: 0.7, conf: 0.95,
    cases: [{ prompt: "say hello", expected: "greeter" }],
  });
  assert.ok(seen.length > 0);
  assert.ok(seen.every((s) => s.cwd !== src), "no probe ran in the real project dir");
  assert.ok(seen.every((s) => s.hasClaudeMd), "project CLAUDE.md is held constant across conditions");
  assert.ok(seen.some((s) => s.skills.join() === "greeter"), "isolation sandbox has only the skill");
  assert.ok(seen.some((s) => s.skills.join() === "greeter,welcomer"), "co-loaded sandbox has the library");
  assert.ok(seen.every((s) => !existsSync(s.cwd)), "sandboxes are cleaned up");
});

test("project context can't masquerade as interference (regression: confounded conditions)", async () => {
  // The project's CLAUDE.md suppresses the skill no matter which skills are loaded. When co-loaded
  // ran in the real dir (with CLAUDE.md) and isolation in a bare sandbox (without), this read as a
  // significant "interference" — and every ablation "recovered", naming an innocent sibling.
  const src = makeProject(["greeter", "welcomer"]);
  writeFileSync(join(src, "CLAUDE.md"), "never greet anyone\n");
  ADAPTERS["mock-ctx-claudemd"] = {
    name: "mock-ctx-claudemd",
    probe: async (_p, opts) => ok(existsSync(join(opts.cwd, "CLAUDE.md")) ? null : "greeter"),
  };
  const r = await runContextAudit({
    runtime: "mock-ctx-claudemd", cwd: src, k: 8, threshold: 0.7, conf: 0.95,
    cases: [{ prompt: "say hello", expected: "greeter" }],
  }, { ablate: true });
  assert.equal(r.cases[0]!.interference, false);
  assert.equal(r.exitCode, 0);
});

test("a condition whose runtime loaded the wrong skills is untrustworthy, not a result", async () => {
  const src = makeProject(["greeter", "welcomer"]);
  // built-in "debug" loads everywhere; the isolation sandbox also leaks "welcomer"
  ADAPTERS["mock-ctx-leak"] = {
    name: "mock-ctx-leak",
    probe: async (_p, opts) => {
      const present = skillsIn(opts.cwd);
      const leaked = present.length === 1 ? ["welcomer"] : [];
      return {
        ...ok(present.length === 1 ? "greeter" : "welcomer"),
        env: { loadedSkills: [...present, ...leaked, "debug"] },
      };
    },
  };
  const r = await runContextAudit({
    runtime: "mock-ctx-leak", cwd: src, k: 8, threshold: 0.7, conf: 0.95,
    cases: [{ prompt: "say hello", expected: "greeter" }],
  });
  const c = r.cases[0]!;
  assert.equal(c.untrustworthy, true);
  assert.equal(c.interference, false);
  assert.match(c.loadIssue!, /isolation: the runtime also loaded welcomer/);
  assert.equal(r.exitCode, 2);
  assert.match(renderContext(r), /loaded the wrong skill set/);
  // built-ins outside the library are recorded, not treated as a leak
  assert.deepEqual(r.manifest.environment?.extraSkills, ["debug"]);
});

test("a thief from OUTSIDE the library is named as such — it can't be ablated", async () => {
  const src = makeProject(["greeter", "welcomer"]);
  ADAPTERS["mock-ctx-builtin"] = cwdAwareAdapter("mock-ctx-builtin", "greeter", "debug");
  const r = await runContextAudit(
    { runtime: "mock-ctx-builtin", cwd: src, k: 8, threshold: 0.7, conf: 0.95,
      cases: [{ prompt: "say hello", expected: "greeter" }] },
    { ablate: true },
  );
  const c = r.cases[0]!;
  assert.equal(c.interference, true);
  assert.deepEqual(c.externalThieves, ["debug"]);
  assert.deepEqual(c.ablation, []);
  const text = renderContext(r);
  assert.match(text, /debug \(outside the library\)/);
  assert.match(text, /can't be removed/);
  assert.doesNotMatch(text, /dilution/);
});

test("context runs cases concurrently with identical results", async () => {
  const src = makeProject(["greeter", "welcomer"]);
  ADAPTERS["mock-ctx-par"] = {
    name: "mock-ctx-par",
    probe: async (prompt, opts) => {
      await new Promise((r) => setTimeout(r, 1));
      if (skillsIn(opts.cwd).length === 1) return ok("greeter");
      return ok(prompt.startsWith("steal") ? "welcomer" : "greeter");
    },
  };
  const cfg = {
    runtime: "mock-ctx-par", cwd: src, k: 6, threshold: 0.7, conf: 0.95,
    cases: [
      { prompt: "steal a", expected: "greeter" }, { prompt: "clean b", expected: "greeter" },
      { prompt: "steal c", expected: "greeter" }, { prompt: "clean d", expected: "greeter" },
    ],
  };
  const seq = await runContextAudit(cfg);
  const par = await runContextAudit(cfg, { concurrency: 4 });
  assert.deepEqual(par.cases.map((c) => [c.prompt, c.interference]), seq.cases.map((c) => [c.prompt, c.interference]));
});

test("a library skill named like a runtime built-in doesn't poison every comparison", async () => {
  // regression: built-in "debug" shows as loaded in every sandbox, so the library's own "debug"
  // looked like a leak into every other case's isolation run (all untrustworthy, exit 2)
  const src = makeProject(["greeter", "debug"]);
  let probes = 0;
  ADAPTERS["mock-ctx-clash"] = {
    name: "mock-ctx-clash",
    probe: async (_p, opts) => {
      probes++;
      const present = skillsIn(opts.cwd);
      return { ...ok("greeter"), cost: 0.01, env: { loadedSkills: [...new Set([...present, "debug", "verify"])] } };
    },
  };
  const r = await runContextAudit({
    runtime: "mock-ctx-clash", cwd: src, k: 8, threshold: 0.7, conf: 0.95,
    cases: [{ prompt: "say hello", expected: "greeter" }],
  });
  assert.equal(r.cases[0]!.untrustworthy, false, r.cases[0]!.loadIssue);
  assert.equal(r.exitCode, 0);
  assert.match(r.warnings.join("\n"), /debug shares a name with a mock-ctx-clash built-in/);
  assert.match(renderContext(r), /⚠ debug shares a name/);
  const measuredProbes = r.cases[0]!.isolation.stats.n + r.cases[0]!.coLoaded.stats.n;
  assert.equal(probes, measuredProbes + 1, "exactly one extra probe to learn the built-ins");
  assert.ok(Math.abs(r.totalCost - probes * 0.01) < 1e-9, "the extra probe is counted in the cost");
});

test("no extra probe when every condition loaded exactly what it should", async () => {
  const src = makeProject(["greeter", "welcomer"]);
  let probes = 0;
  ADAPTERS["mock-ctx-clean"] = {
    name: "mock-ctx-clean", isolatesUserConfig: true,
    probe: async (_p, opts) => { probes++; return { ...ok("greeter"), env: { loadedSkills: [...skillsIn(opts.cwd), "debug"] } }; },
  };
  const r = await runContextAudit({
    runtime: "mock-ctx-clean", cwd: src, k: 8, threshold: 0.7, conf: 0.95,
    cases: [{ prompt: "say hello", expected: "greeter" }],
  });
  assert.equal(probes, r.cases[0]!.isolation.stats.n + r.cases[0]!.coLoaded.stats.n);
  assert.deepEqual(r.warnings, []);
});
