/** Human table + machine JSON rendering. Every number ships with its CI and k; infrastructure
 * errors are shown distinctly from behavioral results. */
import { wilsonInterval } from "./stats.ts";
import type { AuditResult, Verdict } from "./eval.ts";
import type { FixResult } from "./fix.ts";
import type { ContextAuditResult } from "./context.ts";
import type { DoctorResult } from "./doctor.ts";
import type { DiagnoseResult, DiagVerdict } from "./diagnose.ts";

const pct = (x: number) => `${Math.round(x * 100)}%`;
const pval = (p: number) => (p < 0.001 ? "<0.001" : p.toFixed(3));
const LABEL: Record<Verdict, string> = {
  pass: "PASS        ", fail: "FAIL        ",
  inconclusive: "INCONCLUSIVE", error: "ERROR       ",
};

/** Smallest k at which an all-success run could certify reliability >= threshold. */
export function kToCertify(threshold: number, conf: number): number {
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
  const conf = a.cases[0]?.reliability.conf ?? 0.95;
  out.push(`### skill-probe — \`${a.runtime}\` · model \`${a.model}\` · threshold ${pct(a.threshold)}`);
  out.push("");
  out.push(`| Verdict | Skill | Reliability (${pct(conf)} CI) | k | Notes |`);
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

/** intended (forced-choice routing) vs actual (real activation), classified into a remedy. */
export function renderDiagnose(d: DiagnoseResult, opts: RenderOpts = {}): string {
  const showCost = opts.showCost ?? true;
  const LBL: Record<DiagVerdict, string> = {
    "routes-ok": "✅ ROUTES-OK", "routing-miss": "🔀 ROUTING-MISS",
    "description-problem": "✍ DESCRIPTION-PROBLEM", inconclusive: "⚠️ INCONCLUSIVE", error: "⛔ ERROR",
  };
  const out: string[] = [];
  out.push(`skill-probe diagnose — runtime: ${d.runtime}  model: ${d.model}  threshold: ${pct(d.threshold)}`);
  out.push(`  actual = real activation · intended = forced-choice routing (does the model even pick it?)`);
  out.push("");
  const dist = (m: Record<string, number>) =>
    Object.entries(m).sort((p, q) => q[1] - p[1]).map(([s, n]) => `${s}×${n}`).join(", ") || "(none)";
  for (const c of d.cases) {
    out.push(`  [${LBL[c.verdict]}]  ${c.expected}  | ${c.prompt}`);
    out.push(`        actual   fires ${pct(c.actual.rel.pHat)} [${pct(c.actual.rel.ciLow)}, ${pct(c.actual.rel.ciHigh)}] ` +
      `k=${c.actual.rel.k}  (${dist(c.actual.stats.dist)})`);
    out.push(`        intended picks ${pct(c.intended.rel.pHat)} [${pct(c.intended.rel.ciLow)}, ${pct(c.intended.rel.ciHigh)}] ` +
      `k=${c.intended.rel.k}  (${dist(c.intended.stats.dist)})`);
    out.push(`        → ${c.remedy}`);
  }
  if (d.skipped.length) {
    out.push("");
    out.push(`  skipped ${d.skipped.length} decoy case(s) — diagnose explains why an expected skill doesn't fire.`);
  }
  out.push("");
  const counts = (v: DiagVerdict) => d.cases.filter((c) => c.verdict === v).length;
  out.push(`Result: ${counts("routes-ok")} ok / ${counts("routing-miss")} routing-miss / ` +
    `${counts("description-problem")} description-problem / ${counts("inconclusive") + counts("error")} other  ` +
    `|  exit ${d.exitCode}` + (showCost ? `  |  cost $${d.totalCost.toFixed(4)}` : ""));
  return out.join("\n");
}

export function renderDoctor(d: DoctorResult): string {
  const out: string[] = ["skill-probe doctor", ""];
  for (const c of d.checks) out.push(`${c.status.toUpperCase().padEnd(4)}  ${c.message}`);
  out.push("");
  const f = d.checks.filter((c) => c.status === "fail").length;
  const w = d.checks.filter((c) => c.status === "warn").length;
  out.push(f ? `${f} failure(s)` + (w ? `, ${w} warning(s)` : "") + `  |  exit ${d.exitCode}`
    : w ? `${w} warning(s)  |  exit ${d.exitCode}`
    : `all healthy  |  exit 0`);
  return out.join("\n");
}

/** activation-rate-by-context: isolation vs co-loaded, with a Fisher's-exact p on the drop. */
export function renderContext(a: ContextAuditResult, opts: RenderOpts = {}): string {
  const showCost = opts.showCost ?? true;
  const out: string[] = [];
  out.push(`skill-probe context — runtime: ${a.runtime}  model: ${a.model}  ` +
    `threshold: ${pct(a.threshold)}  library: ${a.librarySize} skills`);
  out.push(`  isolation = only that skill loaded · co-loaded = the full library (${a.librarySize}) loaded`);
  out.push("");
  const ci = (r: { pHat: number; ciLow: number; ciHigh: number; k: number }) =>
    `${pct(r.pHat)} [${pct(r.ciLow)}, ${pct(r.ciHigh)}] k=${r.k}`;
  for (const c of a.cases) {
    if (c.untrustworthy) {
      out.push(`  [⛔ ERROR]  ${c.expected}  | ${c.prompt}`);
      out.push(`        infrastructure errors dominated — comparison NOT trustworthy ` +
        `(isolation ${c.isolation.stats.errors} err/${c.isolation.stats.n} valid, ` +
        `co-loaded ${c.coLoaded.stats.errors} err/${c.coLoaded.stats.n} valid)`);
      const reason = c.isolation.stats.lastError ?? c.coLoaded.stats.lastError;
      if (reason) out.push(`        reason: ${reason}`);
      continue;
    }
    const flag = c.interference ? "⚠ INTERFERENCE" : "ok";
    out.push(`  [${flag}]  ${c.expected}  | ${c.prompt}`);
    out.push(`        isolation ${ci(c.isolation.rel)}`);
    out.push(`        co-loaded ${ci(c.coLoaded.rel)}`);
    out.push(`        Δ ${c.deltaP >= 0 ? "+" : ""}${pct(c.deltaP)} under load   Fisher p=${pval(c.fisherP)}`);
    if (c.interference) {
      const thieves = Object.keys(c.coLoaded.stats.dist)
        .filter((s) => s !== c.expected && s !== "None");
      out.push(`        ↳ fires reliably alone but is suppressed when the library is co-loaded` +
        (thieves.length ? ` (stolen by: ${thieves.join(", ")})` : ""));
    }
  }
  if (a.skipped.length) {
    out.push("");
    out.push(`  skipped ${a.skipped.length} decoy case(s) — no single skill to isolate.`);
  }
  out.push("");
  const interfN = a.cases.filter((c) => c.interference).length;
  const errN = a.cases.filter((c) => c.untrustworthy).length;
  out.push(`Result: ${interfN} interference / ${a.cases.length} measured` +
    (errN ? ` / ${errN} error` : "") + `  |  exit ${a.exitCode}` +
    (showCost ? `  |  cost $${a.totalCost.toFixed(4)}` : ""));
  return out.join("\n");
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
