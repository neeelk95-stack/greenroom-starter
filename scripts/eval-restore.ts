/**
 * Put an earlier run of one model back on the scorecard (data/eval/latest.json),
 * for example Gemma's first run, from before the code checks existed.
 *
 *   npm run eval:restore -- --model gemma-local
 *       finds the newest committed run of that model made before the checks
 *   npm run eval:restore -- --model gemma-local --from <commit>
 *       uses that commit's results file
 *   npm run eval:restore -- --model gemma-local --recall 17/19 --false-flags 6/10 --disputed-recall 1 --date 2026-11-21
 *       if the run was never committed: enter its printed results by hand
 *
 * The restored row is labeled with its date and "before the code checks", so
 * nobody mistakes it for a run under today's prompt. Afterwards the script
 * refreshes report.md by re-running the instant rules baseline.
 */
import "../lib/loadEnv";
import fs from "node:fs";
import path from "node:path";
import { execSync, spawnSync } from "node:child_process";

type Section = Record<string, unknown> & { ranAt?: string; note?: string; beforeChecks?: unknown; recall?: number };
type Row = { model: string; label: string; local: boolean; extract: Section | null; readings: Section | null; readingsNew?: Section | null; disputed: Section | null };
type Report = { generatedAt: string; results: Row[] } & Record<string, unknown>;

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const FILE = path.join(process.cwd(), "data", "eval", "latest.json");

function fromGit(model: string, commit?: string): { row: Row; generatedAt: string; commit: string } | null {
  const hashes = commit
    ? [commit]
    : execSync(`git log --format=%H -- data/eval/latest.json`, { encoding: "utf-8" }).split("\n").filter(Boolean);
  for (const h of hashes) {
    let report: Report;
    try {
      report = JSON.parse(execSync(`git show ${h}:data/eval/latest.json`, { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }));
    } catch {
      continue;
    }
    const row = report.results?.find((r) => r.model === model);
    // A run from before the code checks has no "beforeChecks" numbers.
    if (row?.readings && typeof row.readings.recall === "number" && (commit || !row.readings.beforeChecks)) {
      return { row, generatedAt: report.generatedAt, commit: h.slice(0, 7) };
    }
  }
  return null;
}

/** "Nov 21", in this machine's time zone. */
const localDay = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });

const frac = (s: string | undefined) => {
  const m = s?.match(/^(\d+)\/(\d+)$/);
  return m ? { k: Number(m[1]), n: Number(m[2]) } : null;
};

function main() {
  const model = arg("model");
  if (!model) {
    console.log("Say which model, e.g. --model gemma-local");
    process.exit(1);
  }
  const current: Report = JSON.parse(fs.readFileSync(FILE, "utf-8"));
  const idx = current.results.findIndex((r) => r.model === model);
  const existing = idx >= 0 ? current.results[idx] : null;

  let restored: Row | null = null;
  const recall = frac(arg("recall"));
  const ff = frac(arg("false-flags"));
  if (recall && ff) {
    const date = arg("date") ?? new Date().toISOString().slice(0, 10);
    const note = `first run (${localDay(`${date}T12:00:00`)}), before the code checks; entered from its printed results`;
    const disputed = arg("disputed-recall");
    restored = {
      model,
      label: existing?.label ?? model,
      local: existing?.local ?? false,
      extract: existing?.extract ?? null,
      readings: { recall: recall.k / recall.n, caught: recall.k, positives: recall.n, falseFlagRateOnClear: ff.k / ff.n, clearFlagged: ff.k, clear: ff.n, costPer100: 0, ranAt: `${date}T12:00:00.000Z`, note },
      readingsNew: null,
      disputed: disputed != null ? { recall: Number(disputed), ranAt: `${date}T12:00:00.000Z`, note } : existing?.disputed ?? null,
    };
    console.log(`Using the numbers you entered: recall ${recall.k} of ${recall.n}, false flags ${ff.k} of ${ff.n}.`);
  } else {
    const found = fromGit(model, arg("from"));
    if (!found) {
      console.log(
        `No committed run of ${model} from before the code checks was found in git history.\n` +
          `If you never committed it, enter its printed results instead, for example:\n` +
          `  npm run eval:restore -- --model ${model} --recall 17/19 --false-flags 6/10 --disputed-recall 1 --date 2026-11-21`,
      );
      process.exit(1);
    }
    const date = (found.row.readings?.ranAt as string | undefined) ?? found.generatedAt;
    const note = `first run (${localDay(date)}), before the code checks`;
    restored = {
      ...found.row,
      extract: existing?.extract ?? found.row.extract,
      readings: { ...found.row.readings!, ranAt: date, note },
      readingsNew: null,
      disputed: found.row.disputed ? { ...found.row.disputed, ranAt: date, note } : existing?.disputed ?? null,
    };
    console.log(`Restored ${found.row.label} from commit ${found.commit} (${localDay(date)}).`);
  }

  if (idx >= 0) current.results[idx] = restored;
  else current.results.push(restored);
  fs.writeFileSync(FILE, JSON.stringify(current, null, 2));
  const r = restored.readings!;
  console.log(`${restored.label}: two-readings recall ${Math.round((r.recall as number) * 1000) / 10}%, false flags ${Math.round((r.falseFlagRateOnClear as number) * 1000) / 10}%.`);

  // Refresh report.md from the merged results (the rules baseline is instant and unchanged).
  console.log("\nRefreshing report.md…");
  spawnSync("npm", ["run", "eval", "--", "--models", "rules", "--suite", "readings"], { stdio: "inherit", shell: process.platform === "win32" });
}

main();
