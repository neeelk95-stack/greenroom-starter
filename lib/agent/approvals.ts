/**
 * The people-only steps. These functions are called from the UI by a person,
 * never by the agent (they aren't in AGENT_TOOLS). Each returns a new version
 * of the run, so the audit trail keeps every decision.
 */

import type { AgentRun } from "./agent";

const bump = (run: AgentRun): AgentRun => ({ ...run, version: run.version + 1 });

export function confirmTerms(run: AgentRun, by: string): AgentRun {
  if (run.termsStatus !== "waiting_for_booker") return run;
  return { ...bump(run), termsStatus: "confirmed_by_booker", gate: { ...run.gate, reasons: [...run.gate.reasons, `Confirmed by ${by} at ${new Date().toISOString()}`] } };
}

export function approve(run: AgentRun, who: "booker" | "tourManager", by: string): AgentRun {
  return { ...bump(run), approvals: { ...run.approvals, [who]: { by, at: new Date().toISOString() } } };
}

export function canReleasePayout(run: AgentRun): { ok: boolean; reason?: string } {
  if (run.termsStatus === "waiting_for_booker") return { ok: false, reason: "Ethan hasn't confirmed the deal terms yet." };
  if (!run.approvals.booker) return { ok: false, reason: "Ethan hasn't approved the settlement." };
  if (!run.approvals.tourManager) return { ok: false, reason: "Drake hasn't accepted the settlement." };
  if (run.payout.released) return { ok: false, reason: "Already released." };
  return { ok: true };
}

/** A plain rule, not a model: release only after both people have signed off. */
export function releasePayout(run: AgentRun): AgentRun {
  const check = canReleasePayout(run);
  if (!check.ok) throw new Error(check.reason);
  return {
    ...bump(run),
    payout: {
      released: true,
      at: new Date().toISOString(),
      note: `Released by rule after approval by ${run.approvals.booker!.by} and acceptance by ${run.approvals.tourManager!.by}. Not an agent action.`,
    },
  };
}
