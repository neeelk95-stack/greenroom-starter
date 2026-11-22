/**
 * Eval harness: run the same test sets against any models and compare.
 *
 *   npm run eval                                   # rules + every model you can reach
 *   npm run eval -- --models rules,gemma-local     # free, offline
 *   npm run eval -- --models gemma-local,haiku-5.5,sonnet-5.5 --suite readings
 *   npm run eval -- --n 10                         # fewer extraction cases (faster)
 *
 * Each model runs alone (no routing or escalation), so the scorecard measures
 * the model itself. Writes data/eval/latest.json and data/eval/report.md;
 * the /agent page shows the latest scorecard.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { client } from "../db/index";
import { MODELS, MODEL_KEYS, availability, isModelKey, type ModelKey } from "../lib/agent/models";
import { runTask, type TaskRun } from "../lib/agent/router";
import { extractTerms, type DealTerms } from "../lib/agent/tasks/extractTerms";
import { findTwoReadings, READING_TYPES, type ReadingsOutput } from "../lib/agent/tasks/findTwoReadings";
import { quoteAppears } from "../lib/agent/verify";
import { buildExtractCases, buildReadingsCases, buildDisputedCases, type ExtractCase, type ReadingsCase } from "../lib/agent/evalData";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

const pctile = (xs: number[], p: number) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};

type Usage = { latencies: number[]; inputTokens: number; outputTokens: number; costUsd: number; failures: number };
const newUsage = (): Usage => ({ latencies: [], inputTokens: 0, outputTokens: 0, costUsd: 0, failures: 0 });

async function runOne<I, O>(def: Parameters<typeof runTask<I, O>>[0], input: I, model: ModelKey, u: Usage): Promise<O | null> {
  try {
    const r: TaskRun<O> = await runTask(def, input, { profile: "rules", onlyModel: model });
    const a = r.attempts[r.attempts.length - 1];
    u.latencies.push(r.totals.latencyMs);
    u.inputTokens += r.totals.inputTokens;
    u.outputTokens += r.totals.outputTokens;
    u.costUsd += r.totals.costUsd;
    if (a.status === "error" || a.status === "skipped") {
      u.failures++;
      return null;
    }
    return r.output;
  } catch {
    u.failures++;
    return null;
  }
}

async function pool<T>(items: T[], limit: number, fn: (x: T) => Promise<void>) {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) await fn(items[i++]);
    }),
  );
}

const close = (a: number | null, b: number | null, tol: number) => (a == null || b == null ? a == b : Math.abs(a - b) <= tol);

async function evalExtract(cases: ExtractCase[], model: ModelKey) {
  const u = newUsage();
  let graded = 0, correct = 0, dealsAllRight = 0, filledMoney = 0, verified = 0;
  const bySuite: Record<string, { graded: number; correct: number }> = {};
  const misses: string[] = [];
  await pool(cases, MODELS[model].local ? 1 : 4, async (c) => {
    const out = (await runOne(extractTerms, { email: c.email }, model, u)) as DealTerms | null;
    let allRight = true;
    const s = (bySuite[c.suite] ??= { graded: 0, correct: 0 });
    for (const f of c.truth.gradable) {
      const truth = c.truth[f];
      const got = out ? (out[f] as number | string | null) : null;
      const ok = f === "dealType" ? got === truth : close(got as number | null, truth as number | null, f === "percentage" ? 0.005 : 1);
      graded++; s.graded++;
      if (ok) { correct++; s.correct++; } else { allRight = false; if (misses.length < 12) misses.push(`${c.id} ${f}: expected ${truth}, got ${got}`); }
    }
    if (allRight) dealsAllRight++;
    if (out) {
      for (const f of ["guaranteeAmount", "percentage", "expenseCap", "hospitalityCap"] as const) {
        if (out[f] == null) continue;
        filledMoney++;
        if (quoteAppears(c.email, out.citations[f])) verified++;
      }
    }
  });
  return {
    fieldAccuracy: graded ? correct / graded : 0,
    dealsFullyCorrect: cases.length ? dealsAllRight / cases.length : 0,
    citationsVerified: filledMoney ? verified / filledMoney : 1,
    bySuite: Object.fromEntries(Object.entries(bySuite).map(([k, v]) => [k, v.graded ? v.correct / v.graded : 0])),
    misses,
    usage: u,
  };
}

async function evalReadings(cases: ReadingsCase[], model: ModelKey) {
  const u = newUsage();
  let tp = 0, fp = 0, fn = 0, cleanCases = 0, cleanFlagged = 0;
  const perType: Record<string, { tp: number; fn: number; fp: number }> = Object.fromEntries(READING_TYPES.map((t) => [t, { tp: 0, fn: 0, fp: 0 }]));
  const misses: string[] = [];
  await pool(cases, MODELS[model].local ? 1 : 4, async (c) => {
    const out = (await runOne(findTwoReadings, { email: c.email }, model, u)) as ReadingsOutput | null;
    const predicted = new Set((out?.flags ?? []).filter((f) => quoteAppears(c.email, f.quote)).map((f) => f.type));
    const truth = new Set(c.truth);
    for (const t of truth) {
      if (predicted.has(t)) { tp++; perType[t].tp++; } else { fn++; perType[t].fn++; if (misses.length < 12) misses.push(`${c.id}: missed ${t}`); }
    }
    for (const t of predicted) if (!truth.has(t)) { fp++; perType[t].fp++; if (misses.length < 12) misses.push(`${c.id}: false flag ${t}`); }
    if (truth.size === 0) { cleanCases++; if (predicted.size) cleanFlagged++; }
  });
  return {
    recall: tp + fn ? tp / (tp + fn) : 1,
    precision: tp + fp ? tp / (tp + fp) : 1,
    falseFlagRateOnClear: cleanCases ? cleanFlagged / cleanCases : 0,
    positives: tp + fn,
    perType,
    misses,
    usage: u,
  };
}

const fmtPct = (x: number) => `${Math.round(x * 1000) / 10}%`;
const usageRow = (u: Usage, n: number) => ({
  p50ms: pctile(u.latencies, 50),
  p95ms: pctile(u.latencies, 95),
  inputTokens: u.inputTokens,
  outputTokens: u.outputTokens,
  costUsd: Math.round(u.costUsd * 1e6) / 1e6,
  costPer100: n ? Math.round((u.costUsd / n) * 100 * 1e4) / 1e4 : 0,
  failures: u.failures,
});

async function main() {
  const suite = arg("suite") ?? "all";
  const n = Number(arg("n") ?? 25);
  const requested = (arg("models") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const models: ModelKey[] = requested.length
    ? requested.filter(isModelKey)
    : MODEL_KEYS.filter((m) => m === "rules" || m === "gemma-local" || availability(m).ok);

  const extractCases = suite === "all" || suite === "extract" ? await buildExtractCases(n) : [];
  const readingCases = suite === "all" || suite === "readings" ? await buildReadingsCases() : [];
  const disputed = suite === "all" || suite === "readings" ? await buildDisputedCases() : [];
  const disputedWithClause = disputed.filter((c) => c.truth.length).length;

  console.log(`\nEval: ${extractCases.length} extraction cases, ${readingCases.length} two-readings cases, ${disputed.length} disputed settlements`);
  console.log(`Models: ${models.map((m) => MODELS[m].label).join(", ")}\n`);

  const results: Record<string, unknown>[] = [];
  for (const m of models) {
    process.stdout.write(`  ${MODELS[m].label} … `);
    const ex = extractCases.length ? await evalExtract(extractCases, m) : null;
    const rd = readingCases.length ? await evalReadings(readingCases, m) : null;
    const dp = disputed.length ? await evalReadings(disputed, m) : null;
    const unreachable = [ex?.usage, rd?.usage, dp?.usage].every((u) => !u || u.failures >= (u.latencies.length || 1));
    console.log(unreachable && m !== "rules" ? "not reachable (skipped)" : "done");
    if (unreachable && m !== "rules") continue;
    results.push({
      model: m,
      label: MODELS[m].label,
      local: MODELS[m].local,
      extract: ex && { fieldAccuracy: ex.fieldAccuracy, dealsFullyCorrect: ex.dealsFullyCorrect, citationsVerified: ex.citationsVerified, bySuite: ex.bySuite, misses: ex.misses, ...usageRow(ex.usage, extractCases.length) },
      readings: rd && { recall: rd.recall, precision: rd.precision, falseFlagRateOnClear: rd.falseFlagRateOnClear, perType: rd.perType, misses: rd.misses, ...usageRow(rd.usage, readingCases.length) },
      disputed: dp && { recall: dp.recall, precision: dp.precision, positives: dp.positives, misses: dp.misses, ...usageRow(dp.usage, disputed.length) },
    });
  }

  const gates = { extractFieldAccuracy: 0.98, citationsVerified: 1, readingsRecall: 0.9, falseFlagRateOnClear: 0.1 };
  const report = {
    generatedAt: new Date().toISOString(),
    cases: { extract: extractCases.length, readings: readingCases.length, disputed: disputed.length, disputedWithClause },
    gates,
    results,
  };
  const dir = path.join(process.cwd(), "data", "eval");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "latest.json"), JSON.stringify(report, null, 2));

  const lines: string[] = [];
  lines.push(`# Agent eval scorecard`, ``, `Generated ${report.generatedAt}. ${extractCases.length} extraction cases (half real deal notes, half paraphrased), ${readingCases.length} two-readings cases, ${disputed.length} disputed settlements (${disputedWithClause} involve a clause the engine or text can verify).`, ``);
  lines.push(`| Model | Field accuracy | Citations verified | Two-readings recall | False flags on clear emails | Disputed: recall | p50 / p95 latency (extract) | Cost per 100 extractions |`);
  lines.push(`|---|---|---|---|---|---|---|---|`);
  for (const r of results as {
    label: string;
    extract: { fieldAccuracy: number; citationsVerified: number; p50ms: number; p95ms: number; costPer100: number } | null;
    readings: { recall: number; falseFlagRateOnClear: number } | null;
    disputed: { recall: number } | null;
  }[]) {
    lines.push(
      `| ${r.label} | ${r.extract ? fmtPct(r.extract.fieldAccuracy) : "—"} | ${r.extract ? fmtPct(r.extract.citationsVerified) : "—"} | ${r.readings ? fmtPct(r.readings.recall) : "—"} | ${r.readings ? fmtPct(r.readings.falseFlagRateOnClear) : "—"} | ${r.disputed ? fmtPct(r.disputed.recall) : "—"} | ${r.extract ? `${r.extract.p50ms} / ${r.extract.p95ms} ms` : "—"} | ${r.extract ? `$${r.extract.costPer100.toFixed(4)}` : "—"} |`,
    );
  }
  lines.push(``, `Release gates: field accuracy ≥ ${fmtPct(gates.extractFieldAccuracy)}, citations ${fmtPct(gates.citationsVerified)}, two-readings recall ≥ ${fmtPct(gates.readingsRecall)}, false flags on clear emails ≤ ${fmtPct(gates.falseFlagRateOnClear)}.`);
  for (const r of results as { label: string; extract: { misses: string[] } | null; readings: { misses: string[] } | null }[]) {
    const miss = [...(r.extract?.misses ?? []), ...(r.readings?.misses ?? [])];
    if (miss.length) lines.push(``, `**${r.label}, sample misses:**`, ...miss.slice(0, 10).map((m) => `- ${m}`));
  }
  await fs.writeFile(path.join(dir, "report.md"), lines.join("\n") + "\n");
  console.log(`\n${lines.slice(4, 6 + results.length).join("\n")}\n\nWrote data/eval/report.md and data/eval/latest.json`);
  client.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
