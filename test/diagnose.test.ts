import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDiagnose, normalizeChoice, type ChoiceFn } from "../src/diagnose.ts";
import { ADAPTERS } from "../src/adapters/index.ts";
import type { ProbeResult, RuntimeAdapter } from "../src/types.ts";
import type { SkillInfo } from "../src/gen.ts";

function makeProject(skills: string[]): string {
  const root = mkdtempSync(join(tmpdir(), "skill-probe-diag-"));
  for (const s of skills) {
    const dir = join(root, ".claude", "skills", s);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), `---\nname: ${s}\ndescription: the ${s} skill\n---\n# ${s}\n`);
  }
  return root;
}
const ok = (skill: string | null): ProbeResult => ({ status: "ok", skillFired: skill, trajectory: [], cost: 0 });
const fires = (name: string, skill: string | null): RuntimeAdapter => ({ name, probe: async () => ok(skill) });
const picks = (name: string): ChoiceFn => async () => name;

const SKILLS: SkillInfo[] = [{ name: "greeter", description: "" }, { name: "welcomer", description: "" }];
// k=10: a clean run certifies 0.7 (Wilson lo for 10/10 ≈ 0.72 > 0.7); smaller k can't, by design.
const base = (src: string) => ({ runtime: "", cwd: src, k: 10, threshold: 0.7, conf: 0.95,
  cases: [{ prompt: "say hello", expected: "greeter" }] });

test("normalizeChoice maps names, none, and garbage", () => {
  assert.equal(normalizeChoice("greeter", SKILLS), "greeter");
  assert.equal(normalizeChoice("  WELCOMER.", SKILLS), "welcomer");
  assert.equal(normalizeChoice("use the greeter skill", SKILLS), "greeter");
  assert.equal(normalizeChoice("none", SKILLS), "None");
  assert.equal(normalizeChoice("n/a", SKILLS), "None");
  assert.equal(normalizeChoice("¯\\_(ツ)_/¯", SKILLS), null);
});

test("routes-ok: fires reliably AND intended picks it → exit 0", async () => {
  const src = makeProject(["greeter", "welcomer"]);
  ADAPTERS["mock-diag-ok"] = fires("mock-diag-ok", "greeter");
  try {
    const r = await runDiagnose({ ...base(src), runtime: "mock-diag-ok" }, { choice: picks("greeter") });
    assert.equal(r.cases[0]!.verdict, "routes-ok");
    assert.equal(r.exitCode, 0);
  } finally { rmSync(src, { recursive: true, force: true }); }
});

test("routes-ok but ambiguous: fires reliably yet intended picks a sibling → fragility note", async () => {
  const src = makeProject(["greeter", "welcomer"]);
  ADAPTERS["mock-diag-amb"] = fires("mock-diag-amb", "greeter"); // actual routes greeter correctly
  try {
    const r = await runDiagnose({ ...base(src), runtime: "mock-diag-amb" }, { choice: picks("welcomer") });
    const c = r.cases[0]!;
    assert.equal(c.verdict, "routes-ok");          // actual is ground truth → still ok
    assert.match(c.remedy, /ambiguous|fragile/);   // but flags the description ambiguity
    assert.equal(r.exitCode, 0);
  } finally { rmSync(src, { recursive: true, force: true }); }
});

test("routing-miss: model intends greeter but welcomer fires → remedy is deconflict, not fix", async () => {
  const src = makeProject(["greeter", "welcomer"]);
  ADAPTERS["mock-diag-miss"] = fires("mock-diag-miss", "welcomer"); // actual: welcomer steals it
  try {
    const r = await runDiagnose({ ...base(src), runtime: "mock-diag-miss" }, { choice: picks("greeter") });
    const c = r.cases[0]!;
    assert.equal(c.verdict, "routing-miss");
    assert.equal(c.competitor, "welcomer");
    assert.match(c.remedy, /deconflict|context/);
    assert.doesNotMatch(c.remedy, /skill-probe fix/); // explicitly NOT the fix remedy
    assert.equal(r.exitCode, 1);
  } finally { rmSync(src, { recursive: true, force: true }); }
});

test("description-problem: model doesn't even pick greeter → remedy is fix", async () => {
  const src = makeProject(["greeter", "welcomer"]);
  ADAPTERS["mock-diag-desc"] = fires("mock-diag-desc", "welcomer"); // actual fires welcomer
  try {
    const r = await runDiagnose({ ...base(src), runtime: "mock-diag-desc" }, { choice: picks("welcomer") }); // intended also welcomer
    const c = r.cases[0]!;
    assert.equal(c.verdict, "description-problem");
    assert.match(c.remedy, /skill-probe fix --skill greeter/);
    assert.equal(r.exitCode, 1);
  } finally { rmSync(src, { recursive: true, force: true }); }
});

test("error: actual probes all fail → untrustworthy, exit 2 (no false diagnosis)", async () => {
  const src = makeProject(["greeter", "welcomer"]);
  ADAPTERS["mock-diag-err"] = { name: "mock-diag-err", probe: async () => ({ status: "error", skillFired: null, trajectory: [], cost: 0, error: "auth" }) };
  try {
    const r = await runDiagnose({ ...base(src), runtime: "mock-diag-err" }, { choice: picks("greeter") });
    assert.equal(r.cases[0]!.verdict, "error");
    assert.equal(r.exitCode, 2);
  } finally { rmSync(src, { recursive: true, force: true }); }
});

test("error: forced-choice always unusable → intended n=0 → error", async () => {
  const src = makeProject(["greeter", "welcomer"]);
  ADAPTERS["mock-diag-noint"] = fires("mock-diag-noint", "greeter");
  try {
    const r = await runDiagnose({ ...base(src), runtime: "mock-diag-noint" }, { choice: async () => null });
    assert.equal(r.cases[0]!.verdict, "error");
    assert.equal(r.exitCode, 2);
  } finally { rmSync(src, { recursive: true, force: true }); }
});

test("decoys are skipped; unknown expected skill throws (consistent with context)", async () => {
  const src = makeProject(["greeter"]);
  ADAPTERS["mock-diag-skip"] = fires("mock-diag-skip", "greeter");
  try {
    const r = await runDiagnose({
      runtime: "mock-diag-skip", cwd: src, k: 4, threshold: 0.7, conf: 0.95,
      cases: [{ prompt: "weather?", expected: null }],
    }, { choice: picks("greeter") });
    assert.equal(r.cases.length, 0);
    assert.deepEqual(r.skipped, ["weather?"]);

    await assert.rejects(() => runDiagnose({
      runtime: "mock-diag-skip", cwd: src, k: 4, threshold: 0.7, conf: 0.95,
      cases: [{ prompt: "x", expected: "greter" }],
    }, { choice: picks("greeter") }), /not in .*\.claude\/skills|greter/);
  } finally { rmSync(src, { recursive: true, force: true }); }
});
