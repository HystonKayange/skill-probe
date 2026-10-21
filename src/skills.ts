/** Reading and writing SKILL.md frontmatter. One parser for every command — gen, diagnose, doctor,
 * context and fix all used to grep `description:` with a single-line regex, which read a YAML block
 * scalar (`description: >-` followed by indented lines) as the literal text ">-": doctor passed it,
 * diagnose's forced choice was shown ">-" as the skill's description, and fix refused the skill.
 *
 * Scope: the YAML subset SKILL.md files use for top-level string keys — plain scalars (including
 * indented continuation lines), single- and double-quoted scalars (possibly multi-line), and
 * literal/folded block scalars with chomping indicators. Nested mappings are skipped. */
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export interface SkillInfo {
  /** the skill's folder name under .claude/skills/ — its identity everywhere in skill-probe */
  name: string;
  /** description, whitespace-normalized to one line ("" if missing) */
  description: string;
  /** `name:` from the frontmatter, if present (may differ from the folder name) */
  frontmatterName?: string;
}

interface FieldSpan {
  key: string; value: string; start: number; end: number;
  /** an unterminated quoted scalar — the span's extent is unknowable, so it must not be rewritten */
  broken?: boolean;
}

export interface Frontmatter {
  /** false when the file doesn't open with a `---` frontmatter block */
  ok: boolean;
  fields: Record<string, string>;
  /** line spans of each top-level key's entry (for in-place rewriting) */
  spans: FieldSpan[];
  lines: string[];
  /** index of the closing `---` line */
  close: number;
  eol: string;
  /** offsets[i] = where line i starts in the BOM-stripped text; offsets[lines.length] = its length */
  offsets: number[];
}

const KEY_RE = /^([A-Za-z_][\w-]*)\s*:(?:\s+(.*)|\s*)$/;
const BLOCK_RE = /^([|>])([+-]?)([1-9]?)([+-]?)\s*(?:#.*)?$/;
const indentOf = (l: string): number => l.length - l.trimStart().length;
const isBlank = (l: string): boolean => l.trim() === "";

/** Fold YAML flow lines: single newlines become spaces, blank lines become "\n". */
function foldLines(parts: string[]): string {
  let out = "";
  let pendingBreaks = 0;
  for (const p of parts) {
    const t = p.trim();
    if (!t) { pendingBreaks++; continue; }
    if (out) out += pendingBreaks ? "\n".repeat(pendingBreaks) : " ";
    out += t;
    pendingBreaks = 0;
  }
  return out;
}

function unescapeDouble(s: string): string {
  const map: Record<string, string> = {
    "0": "\0", a: "\x07", b: "\b", t: "\t", "\t": "\t", n: "\n", v: "\v", f: "\f", r: "\r",
    e: "\x1b", " ": " ", '"': '"', "/": "/", "\\": "\\", N: "\x85", _: "\xa0",
  };
  return s.replace(/\\(x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|.)/g, (m, e: string) => {
    if (e.length > 1) return String.fromCodePoint(parseInt(e.slice(1), 16));
    return map[e] ?? m;
  });
}

/** Parse the value starting on line i (whose text after `key:` is `first`). Returns the value and
 * the index one past its last line. */
function parseValue(
  lines: string[], i: number, first: string, end: number,
): { value: string; next: number; broken?: boolean } {
  const block = BLOCK_RE.exec(first);
  if (block) {
    const style = block[1]!;
    const chomp = block[2] || block[4] || "";
    let j = i + 1;
    let indent = block[3] ? Number(block[3]) : 0;
    const body: string[] = [];
    while (j < end) {
      const l = lines[j]!;
      if (isBlank(l)) { body.push(""); j++; continue; }
      const ind = indentOf(l);
      if (!indent) indent = ind;
      if (ind < indent || ind === 0) break;
      body.push(l.slice(indent));
      j++;
    }
    let trailing = 0;
    while (body.length && body[body.length - 1] === "") { body.pop(); trailing++; }
    let text: string;
    if (style === "|") text = body.join("\n");
    else {
      // folded: lines joined by spaces, blank lines kept as newlines, more-indented lines kept verbatim
      text = "";
      let prevMoreIndented = false;
      for (let b = 0; b < body.length; b++) {
        const l = body[b]!;
        const moreIndented = /^\s/.test(l);
        if (b === 0) { text = l; prevMoreIndented = moreIndented; continue; }
        if (l === "") { text += "\n"; continue; }
        const prev = body[b - 1]!;
        text += prev === "" || moreIndented || prevMoreIndented ? (prev === "" ? "" : "\n") + l : " " + l;
        prevMoreIndented = moreIndented;
      }
    }
    if (chomp === "+") text += "\n".repeat(trailing + 1);
    else if (chomp !== "-" && text) text += "\n";
    // the block ends at the last non-blank line it consumed
    let next = j;
    while (next > i + 1 && isBlank(lines[next - 1]!)) next--;
    return { value: text, next };
  }

  if (first.startsWith('"') || first.startsWith("'")) {
    const q = first[0]!;
    const parts: string[] = [];
    let rest = first.slice(1);
    let j = i;
    let terminated = false;
    for (;;) {
      // find the closing quote on this line
      let closeAt = -1;
      for (let c = 0; c < rest.length; c++) {
        if (q === '"' && rest[c] === "\\") { c++; continue; }
        if (rest[c] === q) {
          if (q === "'" && rest[c + 1] === "'") { c++; continue; }
          closeAt = c; break;
        }
      }
      if (closeAt >= 0) { parts.push(rest.slice(0, closeAt)); terminated = true; break; }
      parts.push(rest);
      j++;
      if (j >= end) break; // unterminated — take what we have
      rest = lines[j]!;
    }
    const folded = foldLines(parts.map((p, idx) => (idx === 0 ? p.trimEnd() : p)));
    const value = q === '"' ? unescapeDouble(folded) : folded.replace(/''/g, "'");
    return terminated ? { value, next: j + 1 } : { value, next: end, broken: true };
  }

  // plain scalar: this line plus any more-indented continuation lines
  const parts = [first.replace(/\s+#.*$/, "")];
  let j = i + 1;
  while (j < end) {
    const l = lines[j]!;
    if (isBlank(l)) { parts.push(""); j++; continue; }
    if (indentOf(l) === 0) break;
    parts.push(l.replace(/\s+#.*$/, ""));
    j++;
  }
  let next = j;
  while (next > i + 1 && isBlank(lines[next - 1]!)) next--;
  return { value: foldLines(parts.slice(0, next - i)), next };
}

export function parseFrontmatter(text: string): Frontmatter {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const body = text.replace(/^\uFEFF/, "");
  const lines: string[] = [];
  const offsets: number[] = [];
  const brk = /\r?\n/g;
  let pos = 0;
  for (let m = brk.exec(body); m; m = brk.exec(body)) {
    offsets.push(pos);
    lines.push(body.slice(pos, m.index));
    pos = m.index + m[0].length;
  }
  offsets.push(pos, body.length);
  lines.push(body.slice(pos));
  const empty: Frontmatter = { ok: false, fields: {}, spans: [], lines, close: -1, eol, offsets };
  if (lines[0]?.trim() !== "---") return empty;
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    const t = lines[i]!.trimEnd();
    if (t === "---" || t === "...") { close = i; break; }
  }
  if (close < 0) return empty;

  const fields: Record<string, string> = {};
  const spans: FieldSpan[] = [];
  let i = 1;
  while (i < close) {
    const line = lines[i]!;
    const m = indentOf(line) === 0 ? KEY_RE.exec(line) : null;
    if (!m) { i++; continue; }
    const { value, next, broken } = parseValue(lines, i, (m[2] ?? "").trim(), close);
    const key = m[1]!;
    if (!(key in fields)) fields[key] = value;
    spans.push({ key, value, start: i, end: next, ...(broken ? { broken } : {}) });
    i = Math.max(next, i + 1);
  }
  return { ok: true, fields, spans, lines, close, eol, offsets };
}

/** One-line form of a description, as a router would read it. */
export function normalizeDescription(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** Format a string as a YAML scalar for a single `key: value` line: plain when unambiguous,
 * otherwise double-quoted (JSON string syntax is valid YAML). */
export function yamlScalar(s: string): string {
  const plainSafe =
    s.length > 0 && s === s.trim() && !/[\n\r\t]/.test(s) &&
    !/^[-?:,[\]{}#&*!|>'"%@`]/.test(s) && !/:(\s|$)/.test(s) && !/\s#/.test(s) &&
    !/^(true|false|yes|no|on|off|null|~|[-+]?(\d[\d_]*)?(\.\d+)?([eE][-+]?\d+)?|\.inf|\.nan)$/i.test(s);
  return plainSafe ? s : JSON.stringify(s);
}

/** Return `text` with its frontmatter `description` replaced by `desc` (written on one line).
 * Every other byte of the file — including each line's own line ending — is preserved. Throws if
 * there is no frontmatter block or the existing description is an unterminated quoted string. */
export function replaceDescription(text: string, desc: string): string {
  const fm = parseFrontmatter(text);
  if (!fm.ok) throw new Error("SKILL.md has no `---` frontmatter block");
  const bom = text.startsWith("\uFEFF") ? "\uFEFF" : "";
  const body = text.slice(bom.length);
  const line = `description: ${yamlScalar(normalizeDescription(desc))}`;
  const lineEnd = (i: number): number => fm.offsets[i]! + fm.lines[i]!.length;
  const span = fm.spans.find((s) => s.key === "description");
  if (span?.broken) {
    throw new Error("the SKILL.md description has an unterminated quote — fix the frontmatter first");
  }
  if (span) {
    // swap the entry's text; the last replaced line keeps its own terminator
    return bom + body.slice(0, fm.offsets[span.start]) + line + body.slice(lineEnd(span.end - 1));
  }
  const nameSpan = fm.spans.find((s) => s.key === "name");
  const at = nameSpan ? nameSpan.end : fm.close;
  const term = body.slice(lineEnd(at - 1), fm.offsets[at]) || fm.eol;
  return bom + body.slice(0, fm.offsets[at]) + line + term + body.slice(fm.offsets[at]);
}

export function readSkillFile(file: string, folder: string): SkillInfo {
  const fm = parseFrontmatter(readFileSync(file, "utf8"));
  const desc = fm.fields["description"];
  const fmName = fm.fields["name"];
  return {
    name: folder,
    description: desc === undefined ? "" : normalizeDescription(desc),
    ...(fmName !== undefined ? { frontmatterName: normalizeDescription(fmName) } : {}),
  };
}

export function skillsRoot(cwd: string): string {
  return join(cwd, ".claude", "skills");
}

export function skillFile(cwd: string, name: string): string {
  return join(skillsRoot(cwd), name, "SKILL.md");
}

/** Every folder under <cwd>/.claude/skills/, following symlinks (a symlinked skill folder is a
 * skill like any other), sorted. Throws if there is no skills dir. */
export function skillFolders(cwd: string): string[] {
  const root = skillsRoot(cwd);
  if (!existsSync(root)) throw new Error(`no .claude/skills/ directory under ${cwd}`);
  const isDir = (p: string): boolean => { try { return statSync(p).isDirectory(); } catch { return false; } };
  return readdirSync(root).filter((n) => isDir(join(root, n))).sort((a, b) => a.localeCompare(b));
}

/** Every skill folder under <cwd>/.claude/skills/ that has a SKILL.md, sorted by name. */
export function listSkills(cwd: string): SkillInfo[] {
  return skillFolders(cwd)
    .filter((n) => existsSync(skillFile(cwd, n)))
    .map((n) => readSkillFile(skillFile(cwd, n), n));
}
