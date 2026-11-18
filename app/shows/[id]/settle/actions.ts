"use server";

import { revalidatePath } from "next/cache";
import { saveSettlementRecord, type SettlementRecord } from "@/lib/settlementRecordStore";

export async function saveSettlementRecordAction(record: SettlementRecord) {
  await saveSettlementRecord({ ...record, savedAt: new Date().toISOString(), version: 1 });
  revalidatePath(`/shows/${record.showId}/settle`);
  revalidatePath(`/shows/${record.showId}/settle/share`);
  return { ok: true as const };
}
