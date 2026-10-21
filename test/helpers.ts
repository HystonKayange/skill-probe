/** Shared test helpers (not a test file: the runner only picks up *.test.ts). */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const made: string[] = [];
process.on("exit", () => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

/** A temp dir that is removed when the test process exits. */
export function tempDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  made.push(d);
  return d;
}
