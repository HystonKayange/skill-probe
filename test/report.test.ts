import test from "node:test";
import assert from "node:assert/strict";
import { renderTable, renderMarkdown } from "../src/report.ts";
import type { AuditResult } from "../src/eval.ts";

const audit: AuditResult = {
  runtime: "claude-code", model: "(runtime default)", threshold: 0.7,
  totalCost: 0.49,
  counts: { pass: 1, fail: 1, inconclusive: 0, error: 0 },
  exitCode: 1,
  cases: [
    {
      prompt: "write a greeting", expected: "greeter",
      stats: { hits: 9, n: 9, errors: 0, dist: { greeter: 9 }, totalCost: 0.2 },
      reliability: { pHat: 1, ciLow: 0.7, ciHigh: 1, k: 9, conf: 0.95 },
      theft: [], decision: "above", verdict: "pass",
    },
    {
      prompt: "welcome the new hire", expected: "welcomer",
      stats: { hits: 2, n: 9, errors: 0, dist: { greeter: 7, welcomer: 2 }, totalCost: 0.2 },
      reliability: { pHat: 0.22, ciLow: 0.06, ciHigh: 0.55, k: 9, conf: 0.95 },
      theft: ["greeter"], decision: "below", verdict: "fail",
    },
  ],
};

test("renderTable shows cost by default, hides it with showCost:false", () => {
  assert.match(renderTable(audit), /cost \$0\.4900/);
  assert.doesNotMatch(renderTable(audit, { showCost: false }), /cost \$/);
});

test("renderTable surfaces trigger-theft", () => {
  assert.match(renderTable(audit), /trigger-theft by: greeter/);
});

test("renderMarkdown produces a table with verdicts + CI, honors no-cost", () => {
  const md = renderMarkdown(audit);
  assert.match(md, /\| Verdict \| Skill \| Reliability/);
  assert.match(md, /✅ pass/);
  assert.match(md, /❌ fail/);
  assert.match(md, /100% \[70%, 100%\]/);
  assert.match(md, /trigger-theft by greeter/);
  assert.match(md, /cost \$0\.4900/);
  assert.doesNotMatch(renderMarkdown(audit, { showCost: false }), /cost \$/);
});
