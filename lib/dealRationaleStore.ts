/**
 * Persistence for Deal Builder rationale snapshots (FR-X-01 / BR-08).
 *
 * In production this would be a column on the `deals` table or its own table.
 * For the prototype we write one JSON file per saved deal under
 * `data/dealRationales/`. Reasons:
 *
 *  - No DB migration friction for the hiring team — repo runs as-is.
 *  - Snapshots are immutable by convention (we write timestamped filenames).
 *  - Demo flow is "save → file appears → open agent preview to verify it
 *    matches" — visible, inspectable artifact.
 */

import fs from "node:fs/promises";
import path from "node:path";

const RATIONALES_DIR = path.join(process.cwd(), "data", "dealRationales");

export type DealRationale = {
  showId: string;
  dealType: string;
  // Snapshot of every recommended/saved term with its provenance.
  terms: {
    field: string;
    recommendedValue: unknown;
    finalValue: unknown;
    overridden: boolean;
    overrideReason?: string;
    overrideVisibility?: "public" | "internal";
    provenance: {
      summary: string;
      source: unknown;
      confidence: string;
    };
  }[];
  // Plain-English breakeven explanation for the agent-facing sheet (FR-A-02).
  breakevenGross: number;
  // Projected venue earnings band saved at deal time (so settlement can show
  // the agent what was expected vs what happened).
  projectedScenarios: unknown;
  freetextContradictions: unknown[];
  // Audit metadata.
  savedAt: string;
  savedBy: string;
  version: 1;
};

export async function saveRationale(rationale: DealRationale): Promise<string> {
  await fs.mkdir(RATIONALES_DIR, { recursive: true });
  const filename = `${rationale.showId}__${Date.now()}.json`;
  const filepath = path.join(RATIONALES_DIR, filename);
  await fs.writeFile(filepath, JSON.stringify(rationale, null, 2), "utf-8");
  return filepath;
}

export async function getLatestRationale(
  showId: string,
): Promise<DealRationale | null> {
  try {
    const files = await fs.readdir(RATIONALES_DIR);
    const matches = files
      .filter((f) => f.startsWith(`${showId}__`) && f.endsWith(".json"))
      .sort()
      .reverse();
    if (matches.length === 0) return null;
    const content = await fs.readFile(
      path.join(RATIONALES_DIR, matches[0]),
      "utf-8",
    );
    return JSON.parse(content) as DealRationale;
  } catch {
    return null;
  }
}
