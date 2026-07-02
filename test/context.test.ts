import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildContextDir, runContextAudit } from "../src/context.ts";
import { ADAPTERS } from "../src/adapters/index.ts";
import { renderContext } from "../src/report.ts";
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
const err = (msg: string): ProbeResult => ({ status: "error", skillFired: null, trajectory: [], cost: 0, error: msg });

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

test("multi-case runs are BH-corrected: adjusted p >= raw p, real thefts still flagged", async () => {
  const src = makeProject(["greeter", "welcomer"]);
  // per-PROMPT behavior: two theft cases (welcomer steals when co-loaded) + one clean case
  ADAPTERS["mock-ctx-bh"] = {
    name: "mock-ctx-bh",
    probe: async (prompt, opts) => {
      if (opts.cwd !== src) return ok("greeter");                   // isolation: always fires
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
  ADAPTERS["mock-ctx-typo"] = cwdAwareAdapter("mock-ctx-typo", src, "greeter", "greeter");
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
function twoThiefAdapter(name: string, coLoadedCwd: string): RuntimeAdapter {
  let coCalls = 0;
  return {
    name,
    probe: async (_p, opts) => {
      const has = (s: string) => existsSync(join(opts.cwd, ".claude", "skills", s));
      if (!has("welcomer")) return ok("greeter");     // isolation, or welcomer ablated → recovers
      if (opts.cwd === coLoadedCwd) {                 // co-loaded: welcomer steals 2, other steals 1
        return ok(coCalls++ % 3 === 1 ? "other" : "welcomer");
      }
      return ok("welcomer");                          // other ablated: welcomer still steals
    },
  };
}

test("ablation names the thief: ranked by stolen probes, only the real culprit flagged", async () => {
  const src = makeProject(["greeter", "welcomer", "other"]);
  ADAPTERS["mock-ctx-loo"] = twoThiefAdapter("mock-ctx-loo", src);
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
  ADAPTERS["mock-ctx-loo-cap"] = twoThiefAdapter("mock-ctx-loo-cap", src);
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
  ADAPTERS["mock-ctx-noabl"] = cwdAwareAdapter("mock-ctx-noabl", src, "greeter", "welcomer");
  const r = await runContextAudit({
    runtime: "mock-ctx-noabl", cwd: src, k: 8, threshold: 0.7, conf: 0.95,
    cases: [{ prompt: "say hello", expected: "greeter" }],
  });
  assert.equal(r.cases[0]!.ablation, undefined);
});

test("ablation with no named thief (suppressed to None) reports dilution, not theft", async () => {
  const src = makeProject(["greeter", "welcomer"]);
  // co-loaded: nothing fires at all — no sibling in the outcomes to ablate
  ADAPTERS["mock-ctx-dilut"] = cwdAwareAdapter("mock-ctx-dilut", src, "greeter", null);
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
