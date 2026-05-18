"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { saveRationale, type DealRationale } from "@/lib/dealRationaleStore";

export async function saveDealAction(
  showId: string,
  rationale: DealRationale,
) {
  await saveRationale(rationale);
  revalidatePath(`/shows/${showId}`);
  revalidatePath(`/shows/${showId}/deal-builder`);
  redirect(`/shows/${showId}/deal-builder/preview`);
}
