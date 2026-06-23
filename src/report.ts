/** Human table + machine JSON rendering. Every number ships with its CI and k; infrastructure
 * errors are shown distinctly from behavioral results. */
import { wilsonInterval } from "./stats.ts";
import type { AuditResult, Verdict } from "./eval.ts";
import type { FixResult } from "./fix.ts";

const pct = (x: number) => `${Math.round(x * 100)}%`;
const LABEL: Record<Verdict, string> = {
  pass: "PASS        ", fail: "FAIL        ",
  inconclusive: "INCONCLUSIVE", error: "ERROR       ",
};

/** Smallest k at which an all-success run could certify reliability >= threshold. */
function kToCertify(threshold: number, conf: number): number {
  for (let k = 1; k <= 500; k++) {
    if (wilsonInterval(k, k, conf).lo > threshold) return k;
  }
  return 500;
}

export interface RenderOpts { showCost?: boolean }

export function renderTable(a: AuditResult, opts: RenderOpts = {}): string {
  const showCost = opts.showCost ?? true;
  const out: string[] = [];
  out.push(`skill-probe — runtime: ${a.runtime}  model: ${a.model}  threshold: ${pct(a.threshold)}`);
  out.push("");
  for (const c of a.cases) {
    const r = c.reliability;
    out.push(`  ${LABEL[c.verdict]}  expect=${c.expected ?? "(none)"}  | ${c.prompt}`);
    if (c.verdict === "error") {
      out.push(`        ⛔ infrastructure error — result NOT trustworthy ` +
        `(${c.stats.errors} failed, ${c.stats.n} valid)`);
      if (c.stats.lastError) out.push(`        reason: ${c.stats.lastError}`);
      continue;
    }
    out.push(`        reliability ${pct(r.pHat)} [${pct(r.ciLow)}, ${pct(r.ciHigh)}] k=${r.k}` +
      (c.stats.errors ? `  (+${c.stats.errors} infra errors ignored)` : ""));
    const dist = Object.entries(c.stats.dist)
      .sort((p, q) => q[1] - p[1]).map(([s, n]) => `${s}×${n}`).join(", ");
    out.push(`        outcomes: ${dist}`);
    if (c.theft.length) out.push(`        ⚠ trigger-theft by: ${c.theft.join(", ")}`);
    if (c.verdict === "inconclusive") {
      out.push(`        ↳ CI straddles threshold — need ~k=${kToCertify(a.threshold, r.conf)} ` +
        `all-success runs to certify ≥${pct(a.threshold)} (currently k=${r.k})`);
    }
  }
  out.push("");
  out.push(`Result: ${a.counts.pass} pass / ${a.counts.fail} fail / ` +
    `${a.counts.inconclusive} inconclusive / ${a.counts.error} error  |  exit ${a.exitCode}` +
    (showCost ? `  |  cost $${a.totalCost.toFixed(4)}` : ""));
  return out.join("\n");
}

/** Markdown table — paste into a PR or README. */
export function renderMarkdown(a: AuditResult, opts: RenderOpts = {}): string {
  const showCost = opts.showCost ?? true;
  const mark: Record<Verdict, string> = {
    pass: "✅ pass", fail: "❌ fail", inconclusive: "⚠️ inconclusive", error: "⛔ error",
  };
  const out: string[] = [];
  out.push(`### skill-probe — \`${a.runtime}\` · model \`${a.model}\` · threshold ${pct(a.threshold)}`);
  out.push("");
  out.push("| Verdict | Skill | Reliability (95% CI) | k | Notes |");
  out.push("|---|---|---|---|---|");
  for (const c of a.cases) {
    const r = c.reliability;
    const expect = c.expected ?? "(decoy)";
    let notes = "";
    if (c.verdict === "error") notes = `infra error: ${c.stats.lastError ?? "untrustworthy"}`;
    else if (c.theft.length) notes = `⚠ trigger-theft by ${c.theft.join(", ")}`;
    else if (c.verdict === "inconclusive") notes = `need ~k=${kToCertify(a.threshold, r.conf)} to certify`;
    const rel = c.verdict === "error" ? "—" : `${pct(r.pHat)} [${pct(r.ciLow)}, ${pct(r.ciHigh)}]`;
    out.push(`| ${mark[c.verdict]} | \`${expect}\` | ${rel} | ${r.k} | ${notes} |`);
  }
  out.push("");
  out.push(`**${a.counts.pass} pass · ${a.counts.fail} fail · ${a.counts.inconclusive} inconclusive · ` +
    `${a.counts.error} error**` + (showCost ? ` · cost $${a.totalCost.toFixed(4)}` : ""));
  return out.join("\n");
}

export function renderJson(a: AuditResult | unknown): string {
  return JSON.stringify(a, null, 2);
}

export function renderFix(f: FixResult): string {
  const out: string[] = [];
  out.push(`skill-probe fix — skill: ${f.skill}`);
  out.push("");
  out.push(`  old: ${f.oldDesc}`);
  out.push(`  new: ${f.newDesc}`);
  out.push("");
  out.push(`  before: ${pct(f.before.pHat)} [${pct(f.before.ciLow)}, ${pct(f.before.ciHigh)}]  ` +
    `after: ${pct(f.after.pHat)} [${pct(f.after.ciLow)}, ${pct(f.after.ciHigh)}]  ` +
    `(${f.n} paired runs${f.errors ? `, ${f.errors} dropped to infra errors` : ""})`);
  out.push(`  P(rewrite improved reliability) = ${pct(f.pImprove)}   ` +
    `Δ = ${f.deltaMean >= 0 ? "+" : ""}${pct(f.deltaMean)} [${pct(f.deltaCi[0])}, ${pct(f.deltaCi[1])}]`);
  out.push("");
  if (f.applied) {
    out.push(`  ✅ APPLIED — P(improvement) ${pct(f.pImprove)} ≥ bar ${pct(f.applyBar)} and Δ>0.`);
    out.push(`     original backed up to: ${f.backupPath}`);
  } else {
    out.push(`  ↩ REVERTED — not enough evidence the rewrite helps ` +
      `(need P(improvement) ≥ ${pct(f.applyBar)} and Δ>0). Description unchanged, no backup kept.`);
  }
  return out.join("\n");
}
