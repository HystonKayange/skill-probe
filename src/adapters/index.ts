/** Adapter registry — adding a runtime = registering one adapter here. */
import type { RuntimeAdapter } from "../types.ts";
import { claudeCodeAdapter } from "./claudeCode.ts";
import { openCodeAdapter } from "./openCode.ts";

export const ADAPTERS: Record<string, RuntimeAdapter> = {
  [claudeCodeAdapter.name]: claudeCodeAdapter,
  [openCodeAdapter.name]: openCodeAdapter,
};

export function getAdapter(name: string): RuntimeAdapter {
  const a = ADAPTERS[name];
  if (!a) {
    throw new Error(
      `unknown runtime '${name}'. available: ${Object.keys(ADAPTERS).join(", ")}`,
    );
  }
  return a;
}
