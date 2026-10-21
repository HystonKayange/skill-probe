import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseFrontmatter, replaceDescription, yamlScalar, listSkills } from "../src/skills.ts";

const desc = (text: string) => parseFrontmatter(text).fields["description"];

test("plain one-line description", () => {
  assert.equal(desc("---\nname: a\ndescription: Use this when x\n---\nbody\n"), "Use this when x");
});

test("folded block scalar (>-) — previously read as the literal '>-'", () => {
  const t = "---\nname: a\ndescription: >-\n  Use this skill when\n  the user wants X.\nallowed-tools: Read\n---\n";
  assert.equal(desc(t), "Use this skill when the user wants X.");
  assert.equal(parseFrontmatter(t).fields["allowed-tools"], "Read");
});

test("literal block scalar (|) keeps line breaks; clip chomping adds one newline", () => {
  assert.equal(desc("---\ndescription: |\n  line one\n  line two\nname: a\n---\n"), "line one\nline two\n");
  assert.equal(desc("---\ndescription: |-\n  line one\n  line two\n---\n"), "line one\nline two");
});

test("folded scalar keeps paragraph breaks", () => {
  assert.equal(desc("---\ndescription: >-\n  para one\n  continues\n\n  para two\n---\n"), "para one continues\npara two");
});

test("multi-line plain scalar and value on the next line", () => {
  assert.equal(desc("---\ndescription: Use this when\n  the user asks\nmetadata:\n  type: x\n---\n"), "Use this when the user asks");
  assert.equal(desc("---\nname: a\ndescription:\n  on next line\n---\n"), "on next line");
});

test("quoted scalars: escapes, doubled single quotes, multi-line", () => {
  assert.equal(desc('---\ndescription: "Use: this \\"quoted\\"\n  and continued"\n---\n'), 'Use: this "quoted" and continued');
  assert.equal(desc("---\ndescription: 'it''s fine'\n---\n"), "it's fine");
  assert.equal(desc('---\ndescription: "tab\\there \\u00e9"\n---\n'), "tab\there é");
});

test("comments, CRLF line endings and a BOM", () => {
  assert.equal(desc("---\ndescription: hello # a comment\n---\n"), "hello");
  assert.equal(desc("\uFEFF---\r\nname: a\r\ndescription: >\r\n  crlf folded\r\n  text\r\n---\r\nbody\r\n"), "crlf folded text\n");
});

test("only the frontmatter counts — a 'description:' in the body is ignored", () => {
  assert.equal(desc("---\nname: a\n---\ndescription: nope\n"), undefined);
  assert.equal(parseFrontmatter("# no frontmatter\ndescription: nope\n").ok, false);
  assert.equal(parseFrontmatter("---\nname: a\n(never closed)\n").ok, false);
});

test("yamlScalar quotes exactly when a plain scalar would be misread", () => {
  assert.equal(yamlScalar("Use this when the user commits"), "Use this when the user commits");
  for (const s of ["key: value", "has # hash", "- leading dash", "true", "123", "'quote", "", " padded"]) {
    assert.equal(yamlScalar(s), JSON.stringify(s), s);
  }
});

test("replaceDescription round-trips any string and preserves every other byte", () => {
  const files = [
    "---\nname: a\ndescription: old\n---\nbody description: keep\n",
    "---\nname: a\ndescription: >-\n  old folded\n  text\nallowed-tools: Read\n---\nbody\n",
    "---\r\nname: a\r\ndescription: 'old'\r\n---\r\nbody\r\n",
    "\uFEFF---\nname: a\n---\nno description yet\n",
  ];
  const descs = ["New: desc # with specials", "plain words", 'quote " and \\ backslash', "true"];
  for (const f of files) for (const d of descs) {
    const out = replaceDescription(f, d);
    assert.equal(desc(out), d, `${JSON.stringify(f)} / ${JSON.stringify(d)}`);
    assert.equal(parseFrontmatter(out).fields["name"], "a");
    // everything outside the description entry is untouched
    const strip = (t: string) => t.split(/\r?\n/).filter((l) => !l.startsWith("description:") && !l.startsWith("  ")).join("\n");
    assert.equal(strip(out), strip(f));
  }
  assert.ok(replaceDescription(files[2]!, "x").includes("\r\n"), "keeps CRLF");
  assert.ok(replaceDescription(files[3]!, "x").startsWith("\uFEFF"), "keeps BOM");
});

test("listSkills returns normalized one-line descriptions, sorted, with frontmatter names", () => {
  const root = mkdtempSync(join(tmpdir(), "skp-skills-"));
  const add = (folder: string, body: string) => {
    mkdirSync(join(root, ".claude", "skills", folder), { recursive: true });
    writeFileSync(join(root, ".claude", "skills", folder, "SKILL.md"), body);
  };
  add("zeta", "---\nname: zeta\ndescription: >-\n  multi\n  line\n---\n");
  add("alpha", "---\nname: alpha-skill\ndescription: one\n---\n");
  mkdirSync(join(root, ".claude", "skills", "empty-dir"));
  try {
    assert.deepEqual(listSkills(root), [
      { name: "alpha", description: "one", frontmatterName: "alpha-skill" },
      { name: "zeta", description: "multi line", frontmatterName: "zeta" },
    ]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("mixed line endings survive a rewrite byte for byte", () => {
  const f = "---\r\nname: a\ndescription: old\r\nallowed-tools: Read\n---\r\nbody\n";
  assert.equal(replaceDescription(f, "new"), "---\r\nname: a\ndescription: new\r\nallowed-tools: Read\n---\r\nbody\n");
  const noDesc = "---\nname: a\r\n---\nbody\n";
  assert.equal(replaceDescription(noDesc, "new"), "---\nname: a\r\ndescription: new\r\n---\nbody\n");
});

test("an unterminated quoted description is refused, never 'repaired' by deleting lines", () => {
  const f = '---\ndescription: "x\nname: bar\n---\nbody\n';
  assert.throws(() => replaceDescription(f, "NEW"), /unterminated quote/);
  // and parsing still stops at the closing --- instead of swallowing the body
  assert.equal(parseFrontmatter(f).ok, true);
});

test("symlinked skill folders are skills like any other", async () => {
  const { symlinkSync } = await import("node:fs");
  const root = mkdtempSync(join(tmpdir(), "skp-symdir-"));
  const real = join(root, "shared", "greeter");
  mkdirSync(real, { recursive: true });
  writeFileSync(join(real, "SKILL.md"), "---\nname: greeter\ndescription: hi\n---\n");
  mkdirSync(join(root, ".claude", "skills"), { recursive: true });
  symlinkSync(real, join(root, ".claude", "skills", "greeter"), "dir");
  try {
    assert.deepEqual(listSkills(root).map((s) => s.name), ["greeter"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
