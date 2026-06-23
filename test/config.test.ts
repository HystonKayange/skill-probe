import test from "node:test";
import assert from "node:assert/strict";
import { validateConfig, parseProbability, parseIntFlag, ConfigError } from "../src/config.ts";
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

test("parseProbability validates --apply-threshold (review-3)", () => {
  assert.equal(parseProbability(undefined, "--apply-threshold", 0.9), 0.9); // default
  assert.equal(parseProbability("0.95", "--apply-threshold", 0.9), 0.95);
  for (const bad of ["nope", "0", "1", "1.5", "-0.2", "NaN"]) {
    assert.throws(() => parseProbability(bad, "--apply-threshold", 0.9), ConfigError, `bad=${bad}`);
  }
});

test("parseIntFlag validates --per-skill/--decoys (review-4)", () => {
  assert.equal(parseIntFlag(undefined, "--per-skill", 3, 1), 3); // default
  assert.equal(parseIntFlag("5", "--per-skill", 3, 1), 5);
  assert.equal(parseIntFlag("0", "--decoys", 2, 0), 0);          // min 0 allowed for decoys
  for (const bad of ["nope", "2.5", "-1", "NaN"]) {
    assert.throws(() => parseIntFlag(bad, "--per-skill", 3, 1), ConfigError, `bad=${bad}`);
  }
});

test("rejects empty / malformed cases", () => {
  assert.throws(() => validateConfig({ cases: [] }, PATH), ConfigError);
  assert.throws(() => validateConfig({ cases: [{ prompt: "", expected: "x" }] }, PATH), ConfigError);
  assert.throws(() => validateConfig({ cases: [{ prompt: "ok", expected: 42 }] }, PATH), ConfigError);
  assert.doesNotThrow(() => validateConfig({ cases: [{ prompt: "ok", expected: null }] }, PATH));
});
