/**
 * Agent runs are saved as immutable JSON snapshots under data/agentRuns/
 * (the same pattern as settlement records). Each change, such as the booker
 * confirming terms or an approval, writes a new version. That's the audit
 * trail: every step, every model call, every human decision.
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { AgentRun } from "./agent";

const DIR = path.join(process.cwd(), "data", "agentRuns");

export async function saveRun(run: AgentRun): Promise<void> {
  await fs.mkdir(DIR, { recursive: true });
  const file = path.join(DIR, `${run.showId}__${run.id}__v${String(run.version).padStart(3, "0")}.json`);
  await fs.writeFile(file, JSON.stringify(run, null, 2), "utf-8");
}

export async function getLatestRun(showId: string): Promise<AgentRun | null> {
  try {
    const files = (await fs.readdir(DIR)).filter((f) => f.startsWith(`${showId}__`) && f.endsWith(".json"));
    if (!files.length) return null;
    const stats = await Promise.all(files.map(async (f) => ({ f, t: (await fs.stat(path.join(DIR, f))).mtimeMs })));
    stats.sort((a, b) => b.t - a.t || b.f.localeCompare(a.f));
    return JSON.parse(await fs.readFile(path.join(DIR, stats[0].f), "utf-8")) as AgentRun;
  } catch {
    return null;
  }
}
