/** Human table + machine JSON rendering. Every number ships with its CI and k; infrastructure
 * errors are shown distinctly from behavioral results. */
import { kToCertify } from "./stats.ts";
import type { AuditResult, CaseResult, Verdict } from "./eval.ts";
import type { FixResult } from "./fix.ts";
import type { ContextAuditResult } from "./context.ts";
import type { DoctorResult } from "./doctor.ts";
import type { DiagnoseResult, DiagVerdict } from "./diagnose.ts";
import type { BaselineComparison } from "./baseline.ts";
import type { RunManifest } from "./manifest.ts";

export { kToCertify };

const pct = (x: number) => `${Math.round(x * 100)}%`;
const pval = (p: number) => (p < 0.001 ? "<0.001" : p.toFixed(3));
const LABEL: Record<Verdict, string> = {
  pass: "PASS        ", fail: "FAIL        ",
  inconclusive: "INCONCLUSIVE", error: "ERROR       ",
};

export interface RenderOpts { showCost?: boolean }

/** One line describing what the runtime actually ran with, when it told us. */
function environmentLine(m: RunManifest | undefined): string | null {
  const e = m?.environment;
  if (!e) return null;
  const bits: string[] = [];
  if (e.runtimeVersion) bits.push(`runtime ${e.runtimeVersion}`);
  if (e.resolvedModel && m!.model === "(runtime default)") bits.push(`model resolved to ${e.resolvedModel}`);
  if (e.extraSkills) {
    bits.push(e.extraSkills.length
      ? `${e.extraSkills.length} skill(s) outside the library also loaded (${e.extraSkills.slice(0, 6).join(", ")}${e.extraSkills.length > 6 ? ", …" : ""})`
      : "no skills outside the library loaded");
  }
  bits.push(e.userConfig ? "personal runtime config INCLUDED"
    : e.hermetic ? "hermetic (personal runtime config excluded)"
    : "personal runtime config NOT isolated (this runtime can't exclude it)");
  return `  ${bits.join(" · ")}`;
}

function theftLine(c: CaseResult): string {
  const counts = c.theft.map((s) => `${s} ${c.stats.dist[s]}/${c.stats.n}`).join(", ");
  return `        ⚠ trigger-theft by: ${counts}` +
    (c.verdict === "pass" ? " (reliability still clears the bar; --fail-on-theft makes this fail)" : "");
}

export function renderTable(a: AuditResult, opts: RenderOpts = {}): string {
  const showCost = opts.showCost ?? true;
  const out: string[] = [];
  out.push(`skill-probe — runtime: ${a.runtime}  model: ${a.model}  threshold: ${pct(a.threshold)}`);
  const env = environmentLine(a.manifest);
  if (env) out.push(env);
  for (const w of a.warnings ?? []) out.push(`  ⚠ ${w}`);
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
    if (c.notLoaded) out.push(`        ⛔ the runtime never loaded "${c.expected}" — it cannot fire (check its SKILL.md)`);
    if (c.theft.length) out.push(theftLine(c));
    if (c.expected !== null && c.stats.preempted > 0 && c.verdict !== "pass") {
      out.push(`        ⓘ ${c.stats.preempted}/${c.stats.n} probes called another tool first and loaded no skill — ` +
        `activation may be under-counted (try --max-turns 2)`);
    }
    if (c.verdict === "inconclusive") {
      out.push(`        ↳ not statistically decided at k=${r.k} — certifying ≥${pct(a.threshold)} needs ` +
        `k≥${kToCertify(a.threshold, r.conf)} with every run firing (more if some miss)`);
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
  const env = environmentLine(a.manifest);
  if (env) out.push("", `_${env.trim()}_`);
  for (const w of a.warnings ?? []) out.push("", `> ⚠ ${w}`);
  out.push("");
  out.push(`| Verdict | Skill | Reliability (${pct(conf)} CI) | k | Notes |`);
  out.push("|---|---|---|---|---|");
  for (const c of a.cases) {
    const r = c.reliability;
    const expect = c.expected ?? "(decoy)";
    let notes = "";
    if (c.verdict === "error") notes = `infra error: ${c.stats.lastError ?? "untrustworthy"}`;
    else if (c.notLoaded) notes = `⛔ runtime never loaded \`${c.expected}\``;
    else if (c.theft.length) notes = `⚠ trigger-theft by ${c.theft.map((s) => `${s} ${c.stats.dist[s]}/${c.stats.n}`).join(", ")}`;
    else if (c.verdict === "inconclusive") notes = `need k≥${kToCertify(a.threshold, r.conf)} to certify`;
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
  const env = environmentLine(d.manifest);
  if (env) out.push(env);
  for (const w of d.warnings ?? []) out.push(`  ⚠ ${w}`);
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
  out.push(`  every condition runs in an identical sandbox (skills + project CLAUDE.md/AGENTS.md) — only the skill set differs`);
  const env = environmentLine(a.manifest);
  if (env) out.push(env);
  for (const w of a.warnings ?? []) out.push(`  ⚠ ${w}`);
  const familyN = a.cases.filter((c) => !c.untrustworthy).length;
  if (familyN > 1) {
    out.push(`  ${familyN} comparisons — interference decided on Benjamini-Hochberg adjusted p<0.05` +
      ` (raw p across a family overcounts)`);
  }
  out.push("");
  const ci = (r: { pHat: number; ciLow: number; ciHigh: number; k: number }) =>
    `${pct(r.pHat)} [${pct(r.ciLow)}, ${pct(r.ciHigh)}] k=${r.k}`;
  for (const c of a.cases) {
    if (c.untrustworthy) {
      out.push(`  [⛔ ERROR]  ${c.expected}  | ${c.prompt}`);
      if (c.loadIssue) {
        out.push(`        the runtime loaded the wrong skill set — comparison NOT trustworthy`);
        out.push(`        ${c.loadIssue}`);
        continue;
      }
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
    out.push(`        Δ ${c.deltaP >= 0 ? "+" : ""}${pct(c.deltaP)} under load   Fisher p=${pval(c.fisherP)}` +
      (familyN > 1 ? ` · BH-adj p=${pval(c.fisherPAdj)}` : ""));
    if (c.interference) {
      const external = new Set(c.externalThieves ?? []);
      const thieves = Object.keys(c.coLoaded.stats.dist)
        .filter((s) => s !== c.expected && s !== "None")
        .map((s) => (external.has(s) ? `${s} (outside the library)` : s));
      out.push(`        ↳ fires reliably alone but is suppressed when the library is co-loaded` +
        (thieves.length ? ` (stolen by: ${thieves.join(", ")})` : ""));
      if (c.ablation) {
        if (c.ablation.length === 0 && external.size) {
          out.push(`        leave-one-out: only skills outside the library stole these probes ` +
            `(${[...external].join(", ")}) — they can't be removed; narrow or rename "${c.expected}" to stop colliding`);
        } else if (c.ablation.length === 0) {
          out.push(`        leave-one-out: no sibling stole these probes (suppressed to None) — ` +
            `dilution, not theft; nothing to ablate`);
        } else {
          out.push(`        leave-one-out (each suspect removed, recovery vs co-loaded):`);
          for (const abl of c.ablation) {
            if (abl.untrustworthy) {
              out.push(`          − ${abl.removed}: ${abl.loadIssue ?? "infra errors dominated"} — run not trustworthy`);
              continue;
            }
            const tag = abl.culprit
              ? (abl.rel.pHat >= a.threshold ? "  ← THIEF (full recovery)" : "  ← THIEF (partial recovery)")
              : "";
            out.push(`          − ${abl.removed} removed → ${ci(abl.rel)}  ` +
              `Δ${abl.deltaVsCoLoaded >= 0 ? "+" : ""}${pct(abl.deltaVsCoLoaded)}  ` +
              `p=${pval(abl.fisherP)} · adj ${pval(abl.fisherPAdj)}${tag}`);
          }
          if (!c.ablation.some((abl) => abl.culprit)) {
            out.push(`          no single culprit confirmed — interference may be combinatorial`);
          }
        }
      }
    }
  }
  if (a.skipped.length) {
    out.push("");
    out.push(`  skipped ${a.skipped.length} decoy case(s) — no single skill to isolate.`);
  }
  out.push("");
  const interfN = a.cases.filter((c) => c.interference).length;
  const errN = a.cases.filter((c) => c.untrustworthy).length;
  const culprits = [...new Set(a.cases.flatMap((c) =>
    (c.ablation ?? []).filter((abl) => abl.culprit).map((abl) => abl.removed)))];
  out.push(`Result: ${interfN} interference / ${a.cases.length} measured` +
    (errN ? ` / ${errN} error` : "") +
    (culprits.length ? `  |  thieves named: ${culprits.join(", ")}` : "") +
    `  |  exit ${a.exitCode}` +
    (showCost ? `  |  cost $${a.totalCost.toFixed(4)}` : ""));
  return out.join("\n");
}

/** regression gate vs a saved baseline: only significant (BH-corrected) drops fail the build. */
export function renderBaseline(cmp: BaselineComparison): string {
  const out: string[] = [];
  out.push(`Baseline gate — vs baseline saved ${cmp.baselineDate} (skill-probe ${cmp.baselineVersion})`);
  for (const m of cmp.mismatches) out.push(`  ⚠ ${m}`);
  for (const r of cmp.cases) {
    if (r.untrustworthy) {
      out.push(`  [⛔ NOT COMPARABLE]  ${r.expected ?? "(decoy)"}  | ${r.prompt} — a side has no valid probes`);
      continue;
    }
    if (!r.regressed && !r.improved) continue; // stable cases are summarized, not listed
    const flag = r.regressed ? "▼ REGRESSED" : "▲ improved";
    out.push(`  [${flag}]  ${r.expected ?? "(decoy)"}  | ${r.prompt}`);
    out.push(`        ${pct(r.before.pHat)} (${r.before.hits}/${r.before.n}) → ${pct(r.after.pHat)} ` +
      `(${r.after.hits}/${r.after.n})   Δ${r.delta >= 0 ? "+" : ""}${pct(r.delta)}   ` +
      `p=${pval(r.fisherP)} · adj ${pval(r.fisherPAdj)}`);
  }
  const extras: string[] = [];
  if (cmp.newCases.length) extras.push(`${cmp.newCases.length} new case(s) not in baseline (measured, not gated)`);
  if (cmp.missingCases.length) extras.push(`${cmp.missingCases.length} baseline case(s) missing from this run`);
  if (extras.length) out.push(`  ${extras.join(" · ")}`);
  out.push(cmp.regressions
    ? `Gate: ▼ FAIL — ${cmp.regressions} significant regression(s)` +
      (cmp.improvements ? `, ${cmp.improvements} improvement(s)` : "")
    : `Gate: ✅ no significant regressions (${cmp.cases.length} gated` +
      (cmp.improvements ? `, ${cmp.improvements} improved — consider re-saving the baseline` : "") + `)`);
  return out.join("\n");
}

export function renderFix(f: FixResult): string {
  const out: string[] = [];
  out.push(`skill-probe fix — skill: ${f.skill}`);
  out.push("");
  out.push(`  old: ${f.oldDesc}`);
  out.push(`  new: ${f.newDesc}`);
  out.push("");
  if (f.n > 0 || f.errors > 0) {
    out.push(`  before: ${pct(f.before.pHat)} [${pct(f.before.ciLow)}, ${pct(f.before.ciHigh)}]  ` +
      `after: ${pct(f.after.pHat)} [${pct(f.after.ciLow)}, ${pct(f.after.ciHigh)}]  ` +
      `(${f.n} paired runs${f.errors ? `, ${f.errors} dropped to infra errors` : ""})` +
      (f.totalCost ? `  cost $${f.totalCost.toFixed(4)}` : ""));
    out.push(`  P(rewrite improved reliability) = ${pct(f.pImprove)}   ` +
      `Δ = ${f.deltaMean >= 0 ? "+" : ""}${pct(f.deltaMean)} [${pct(f.deltaCi[0])}, ${pct(f.deltaCi[1])}]`);
    out.push("");
  }
  if (f.note) {
    out.push(`  ↩ NOT APPLIED — ${f.note}. Description unchanged.`);
  } else if (f.applied) {
    out.push(`  ✅ APPLIED — P(improvement) ${pct(f.pImprove)} ≥ bar ${pct(f.applyBar)} and Δ>0.`);
    out.push(`     original backed up to: ${f.backupPath}`);
  } else {
    out.push(`  ↩ NOT APPLIED — not enough evidence the rewrite helps ` +
      `(need P(improvement) ≥ ${pct(f.applyBar)} and Δ>0). Description unchanged.`);
  }
  return out.join("\n");
}
