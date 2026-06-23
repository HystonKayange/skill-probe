import test from "node:test";
import assert from "node:assert/strict";
import { validateConfig, ConfigError } from "../src/config.ts";
import { resolve, dirname } from "node:path";

const PATH = "/some/dir/skill-probe.config.json";
const okCases = [{ prompt: "do x", expected: "x-skill" }];

test("accepts a valid config and resolves cwd against the config file dir (#3)", () => {
  const cfg = validateConfig({ cwd: "./my-project", cases: okCases }, PATH);
  assert.equal(cfg.cwd, resolve(dirname(PATH), "./my-project"));
  assert.equal(cfg.k, 10);
  assert.equal(cfg.threshold, 0.7); // smoke-test default (review-2 #2)
  assert.equal(cfg.conf, 0.95);
});

test("rejects bad k (#2)", () => {
  for (const k of [0, -1, 2.5, NaN, "nope"]) {
    assert.throws(() => validateConfig({ k, cases: okCases }, PATH), ConfigError, `k=${k}`);
  }
});

test("rejects out-of-range threshold (#2)", () => {
  for (const t of [0, 1, 1.5, -0.2, NaN]) {
    assert.throws(() => validateConfig({ threshold: t, cases: okCases }, PATH), ConfigError);
  }
});

test("rejects unsupported confidence (#2)", () => {
  assert.throws(() => validateConfig({ conf: 0.975, cases: okCases }, PATH), ConfigError);
  assert.doesNotThrow(() => validateConfig({ conf: 0.99, cases: okCases }, PATH));
});

test("rejects empty / malformed cases", () => {
  assert.throws(() => validateConfig({ cases: [] }, PATH), ConfigError);
  assert.throws(() => validateConfig({ cases: [{ prompt: "", expected: "x" }] }, PATH), ConfigError);
  assert.throws(() => validateConfig({ cases: [{ prompt: "ok", expected: 42 }] }, PATH), ConfigError);
  assert.doesNotThrow(() => validateConfig({ cases: [{ prompt: "ok", expected: null }] }, PATH));
});
