/**
 * The record of the room: what was decided at the settlement table.
 *
 * Every save writes an immutable, timestamped JSON snapshot under
 * `data/settlementRecords/` (same pattern as Deal Builder rationales — no
 * migration needed to run the repo). In production this is a table with the
 * settlement id as a foreign key.
 *
 * What gets recorded:
 *  - which reading was chosen for every ambiguous term, and what it was worth
 *  - what the venue absorbed (over the cap) and what was held open (disputed recoups)
 *  - what was questioned and what was agreed, in plain words
 *  - the total both sides saw, and who signed
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { Readings } from "@/lib/settlementEngine";

const RECORDS_DIR = path.join(process.cwd(), "data", "settlementRecords");

export type SettlementRecord = {
  showId: string;
  readings: Readings;
  totalToArtist: number;
  venueResult: number;
  decisions: { key: string; title: string; chosen: string; chosenLabel: string; impact: number }[];
  venueAbsorbedOverCap: number;
  recoupsHeld: number;
  questioned: string;
  agreed: string;
  signedBy: string;
  summary: string;
  savedAt: string;
  version: 1;
};

export async function saveSettlementRecord(record: SettlementRecord): Promise<void> {
  await fs.mkdir(RECORDS_DIR, { recursive: true });
  const file = path.join(RECORDS_DIR, `${record.showId}__${Date.now()}.json`);
  await fs.writeFile(file, JSON.stringify(record, null, 2), "utf-8");
}

export async function getLatestSettlementRecord(showId: string): Promise<SettlementRecord | null> {
  try {
    const files = (await fs.readdir(RECORDS_DIR))
      .filter((f) => f.startsWith(`${showId}__`) && f.endsWith(".json"))
      .sort()
      .reverse();
    if (!files.length) return null;
    return JSON.parse(await fs.readFile(path.join(RECORDS_DIR, files[0]), "utf-8")) as SettlementRecord;
  } catch {
    return null;
  }
}
