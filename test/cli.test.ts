import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const run = (...args: string[]) => spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8" });

test("--version prints the package version", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
  const r = run("--version");
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), pkg.version);
});

test("an unknown subcommand is a usage error, not a silent audit", () => {
  const r = run("contxt", "--config", "x.json");
  assert.equal(r.status, 2);
  assert.match(r.stderr, /unknown command: contxt/);
});

test("a config typo exits 2 with the reason", () => {
  const r = run("--config", "/definitely/missing.json");
  assert.equal(r.status, 2);
  assert.match(r.stderr, /could not read\/parse config/);
});

test("--help exits 0", () => {
  const r = run("--help");
  assert.equal(r.status, 0);
  assert.match(r.stdout, /--max-cost/);
});
