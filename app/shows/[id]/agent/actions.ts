"use server";

import { revalidatePath } from "next/cache";
import { runAgent, askAssistant } from "@/lib/agent/agent";
import { approve, confirmTerms, releasePayout } from "@/lib/agent/approvals";
import { getLatestRun, saveRun } from "@/lib/agent/runStore";
import { isProfile } from "@/lib/agent/routing";

type Result = { ok: true } | { ok: false; error: string };

const done = (showId: string): Result => {
  revalidatePath(`/shows/${showId}/agent`);
  return { ok: true };
};

export async function runAgentAction(input: { showId: string; email: string; from: string; firstName: string; profile: string }): Promise<Result> {
  try {
    if (!isProfile(input.profile)) return { ok: false, error: "Unknown profile" };
    const run = await runAgent(input.showId, input.email, input.from, input.firstName, input.profile);
    await saveRun(run);
    return done(input.showId);
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export async function askAction(showId: string, question: string): Promise<Result> {
  try {
    const run = await getLatestRun(showId);
    if (!run) return { ok: false, error: "Run the agent first." };
    const qa = await askAssistant(run, question);
    await saveRun({ ...run, version: run.version + 1, qa: [...run.qa, qa] });
    return done(showId);
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/** People-only actions. The agent never calls these. */
export async function confirmTermsAction(showId: string): Promise<Result> {
  const run = await getLatestRun(showId);
  if (!run) return { ok: false, error: "No run" };
  await saveRun(confirmTerms(run, "Mariana"));
  return done(showId);
}

export async function approveAction(showId: string, who: "booker" | "tourManager"): Promise<Result> {
  const run = await getLatestRun(showId);
  if (!run) return { ok: false, error: "No run" };
  await saveRun(approve(run, who, who === "booker" ? "Mariana" : "Tour manager"));
  return done(showId);
}

export async function releasePayoutAction(showId: string): Promise<Result> {
  try {
    const run = await getLatestRun(showId);
    if (!run) return { ok: false, error: "No run" };
    await saveRun(releasePayout(run));
    return done(showId);
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
