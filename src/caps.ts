/** Capability-tag parsing and matching, shared by balancer, CLI, and simulator. */

import { invalidTask } from "./errors.js";

/** Trim, lowercase, de-duplicate, and sort capability tags. Validates input. */
export function normalizeCaps(caps: string[] | undefined): string[] {
  if (caps === undefined) return [];
  if (!Array.isArray(caps)) throw invalidTask("capabilities must be an array of strings");
  const seen = new Set<string>();
  for (const cap of caps) {
    if (typeof cap !== "string" || cap.trim().length === 0) {
      throw invalidTask("capabilities must be non-empty strings");
    }
    seen.add(cap.trim().toLowerCase());
  }
  return [...seen].sort();
}

/** True when the agent's capability set covers every required tag. */
export function hasCaps(agentCaps: string[], required: string[]): boolean {
  const owned = new Set(agentCaps);
  return required.every((cap) => owned.has(cap));
}
