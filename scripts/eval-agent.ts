/**
 * Eval harness: run the same test sets against any models and compare.
 *
 *   npm run eval                                   # rules + every model you can reach
 *   npm run eval -- --models rules,gemma-local     # free, offline
 *   npm run eval -- --models gemma-local,haiku-5.5,sonnet-5.5 --suite readings
 *   npm run eval -- --n 10                         # fewer extraction cases (faster)
 *
 * Each model runs alone (no routing or escalation), so the scorecard measures
 * the model plus the task's own code checks. For two readings it reports both:
 * what the model flagged, and what survived the checks in flagChecks.ts.
 *
 * Writes data/eval/latest.json and data/eval/report.md; the /agent page shows
 * the latest scorecard. A run of one suite (e.g. --suite readings) updates only
 * that suite's numbers and keeps the rest from the previous run, with dates.
 */

import "../lib/loadEnv";
import fs from "node:fs/promises";
import path from "node:path";
import { client } from "../db/index";
import { MODELS, MODEL_KEYS, availability, isModelKey, type ModelKey } from "../lib/agent/models";
import { runTask, type TaskRun } from "../lib/agent/router";
import { extractTerms, type DealTerms } from "../lib/agent/tasks/extractTerms";
import { findTwoReadings, READING_TYPES, type ReadingsOutput } from "../lib/agent/tasks/findTwoReadings";
import { quoteAppears } from "../lib/agent/verify";
import { buildExtractCases, buildReadingsCases, buildNewWordingCases, buildDisputedCases, type ExtractCase, type ReadingsCase } from "../lib/agent/evalData";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

const pctile = (xs: number[], p: number) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};

type Usage = { latencies: number[]; inputTokens: number; outputTokens: number; costUsd: number; failures: number; calls: number; firstError?: string };
const newUsage = (): Usage => ({ latencies: [], inputTokens: 0, outputTokens: 0, costUsd: 0, failures: 0, calls: 0 });

async function runOne<I, O>(def: Parameters<typeof runTask<I, O>>[0], input: I, model: ModelKey, u: Usage): Promise<O | null> {
  u.calls++;
  try {
    const r: TaskRun<O> = await runTask(def, input, { profile: "rules", onlyModel: model });
    const a = r.attempts[r.attempts.length - 1];
    u.latencies.push(r.totals.latencyMs);
    u.inputTokens += r.totals.inputTokens;
    u.outputTokens += r.totals.outputTokens;
    u.costUsd += r.totals.costUsd;
    if (a.status === "error" || a.status === "skipped") {
      u.failures++;
      u.firstError ??= a.reason;
      return null;
    }
    return r.output;
  } catch (err) {
    u.failures++;
    const e = err as Error & { attempts?: { reason?: string }[] };
    u.firstError ??= e.attempts?.find((x) => x.reason)?.reason ?? e.message;
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

type FlagNote = { case: string; type: string; quote: string; dropped?: string };

async function evalReadings(cases: ReadingsCase[], model: ModelKey) {
  const u = newUsage();
  const tally = () => ({ tp: 0, fp: 0, fn: 0, cleanCases: 0, cleanFlagged: 0 });
  const after = tally(); // what the agent acts on
  const before = tally(); // what the model flagged (quote in the email), before the other checks
  const perType: Record<string, { tp: number; fn: number; fp: number }> = Object.fromEntries(READING_TYPES.map((t) => [t, { tp: 0, fn: 0, fp: 0 }]));
  const misses: string[] = [];
  const falseFlags: FlagNote[] = [];
  const droppedTruePositives: FlagNote[] = [];
  const score = (t: ReturnType<typeof tally>, predicted: Set<string>, truth: Set<string>, track: boolean, c: ReadingsCase) => {
    for (const x of truth) {
      if (predicted.has(x)) { t.tp++; if (track) perType[x].tp++; }
      else { t.fn++; if (track) { perType[x].fn++; if (misses.length < 12) misses.push(`${c.id}: missed ${x}`); } }
    }
    for (const x of predicted) if (!truth.has(x)) { t.fp++; if (track) { perType[x].fp++; if (misses.length < 12) misses.push(`${c.id}: false flag ${x}`); } }
    if (truth.size === 0) { t.cleanCases++; if (predicted.size) t.cleanFlagged++; }
  };
  await pool(cases, MODELS[model].local ? 1 : 4, async (c) => {
    const out = (await runOne(findTwoReadings, { email: c.email }, model, u)) as ReadingsOutput | null;
    const kept = (out?.flags ?? []).filter((f) => quoteAppears(c.email, f.quote));
    const checkedOut = (out?.dropped ?? []).filter((f) => f.reason !== "quote");
    const truth = new Set<string>(c.truth);
    score(after, new Set(kept.map((f) => f.type)), truth, true, c);
    score(before, new Set([...kept, ...checkedOut].map((f) => f.type)), truth, false, c);
    for (const f of kept) if (!truth.has(f.type)) falseFlags.push({ case: c.id, type: f.type, quote: f.quote.slice(0, 90) });
    for (const f of checkedOut) {
      if (!truth.has(f.type)) falseFlags.push({ case: c.id, type: f.type, quote: f.quote.slice(0, 90), dropped: f.detail });
      else if (!kept.some((k) => k.type === f.type)) droppedTruePositives.push({ case: c.id, type: f.type, quote: f.quote.slice(0, 90), dropped: f.detail });
    }
  });
  const rates = (t: ReturnType<typeof tally>) => ({
    recall: t.tp + t.fn ? t.tp / (t.tp + t.fn) : 1,
    precision: t.tp + t.fp ? t.tp / (t.tp + t.fp) : 1,
    falseFlagRateOnClear: t.cleanCases ? t.cleanFlagged / t.cleanCases : 0,
    caught: t.tp,
    positives: t.tp + t.fn,
    clearFlagged: t.cleanFlagged,
    clear: t.cleanCases,
  });
  return { ...rates(after), beforeChecks: rates(before), perType, misses, falseFlags, droppedTruePositives, usage: u };
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

type Section = Record<string, unknown> & { ranAt?: string };
type Result = { model: string; label: string; local: boolean; extract: Section | null; readings: Section | null; readingsNew: Section | null; disputed: Section | null };
type Report = {
  generatedAt: string;
  cases: { extract: number; readings: number; readingsNew: number; disputed: number; disputedWithClause: number };
  gates: Record<string, number>;
  results: Result[];
};

async function loadPrevious(file: string): Promise<Report | null> {
  try {
    return JSON.parse(await fs.readFile(file, "utf-8")) as Report;
  } catch {
    return null;
  }
}

/** Keep each model's sections from the previous run when this run didn't cover that suite. */
function merge(prev: Report | null, next: Report): Report {
  if (!prev) return next;
  const SECTIONS = ["extract", "readings", "readingsNew", "disputed"] as const;
  const byModel = new Map(next.results.map((r) => [r.model, r]));
  for (const p of prev.results) {
    const n = byModel.get(p.model);
    if (!n) {
      // A model this run didn't include: keep its row as it was.
      byModel.set(p.model, { ...p, readingsNew: p.readingsNew ?? null });
      for (const k of SECTIONS) if (p[k] && !p[k]!.ranAt) p[k]!.ranAt = prev.generatedAt;
      continue;
    }
    for (const k of SECTIONS) if (!n[k] && p[k]) n[k] = { ...p[k]!, ranAt: p[k]!.ranAt ?? prev.generatedAt };
  }
  const cases = { ...next.cases };
  for (const k of ["extract", "readings", "readingsNew", "disputed", "disputedWithClause"] as const) if (!cases[k] && prev.cases?.[k]) cases[k] = prev.cases[k];
  return { ...next, cases, results: [...byModel.values()] };
}

async function main() {
  const suite = arg("suite") ?? "all";
  const n = Number(arg("n") ?? 25);
  const requested = (arg("models") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const models: ModelKey[] = requested.length
    ? requested.filter(isModelKey)
    : MODEL_KEYS.filter((m) => m === "rules" || m === "gemma-local" || availability(m).ok);

  const doReadings = suite === "all" || suite === "readings";
  const extractCases = suite === "all" || suite === "extract" ? await buildExtractCases(n) : [];
  const readingCases = doReadings ? await buildReadingsCases() : [];
  const newWording = doReadings ? buildNewWordingCases() : [];
  const disputed = doReadings ? await buildDisputedCases() : [];
  const disputedWithClause = disputed.filter((c) => c.truth.length).length;

  console.log(`\nEval: ${extractCases.length} extraction cases, ${readingCases.length} two-readings cases, ${newWording.length} in new wording, ${disputed.length} disputed settlements`);
  console.log(`Models: ${models.map((m) => MODELS[m].label).join(", ")}\n`);

  const now = new Date().toISOString();
  const results: Result[] = [];
  for (const m of models) {
    process.stdout.write(`  ${MODELS[m].label} … `);
    const ex = extractCases.length ? await evalExtract(extractCases, m) : null;
    const rd = readingCases.length ? await evalReadings(readingCases, m) : null;
    const nw = newWording.length ? await evalReadings(newWording, m) : null;
    const dp = disputed.length ? await evalReadings(disputed, m) : null;
    const usages = [ex?.usage, rd?.usage, nw?.usage, dp?.usage].filter((u): u is Usage => !!u);
    const unreachable = usages.every((u) => u.failures >= (u.calls || 1));
    const failed = usages.reduce((s, u) => s + u.failures, 0);
    const calls = usages.reduce((s, u) => s + u.calls, 0);
    const firstError = usages.find((u) => u.firstError)?.firstError;
    console.log(unreachable && m !== "rules" ? "not reachable (skipped)" : "done");
    if (failed && m !== "rules") console.log(`    ${failed} of ${calls} calls failed. First error: ${(firstError ?? "unknown").slice(0, 240)}`);
    if (unreachable && m !== "rules") continue;
    const readingsSection = (r: NonNullable<typeof rd>, count: number) => {
      const { usage, ...rest } = r;
      return { ...rest, ...usageRow(usage, count), ranAt: now };
    };
    results.push({
      model: m,
      label: MODELS[m].label,
      local: MODELS[m].local,
      extract: ex && { fieldAccuracy: ex.fieldAccuracy, dealsFullyCorrect: ex.dealsFullyCorrect, citationsVerified: ex.citationsVerified, bySuite: ex.bySuite, misses: ex.misses, ...usageRow(ex.usage, extractCases.length), ranAt: now },
      readings: rd && readingsSection(rd, readingCases.length),
      readingsNew: nw && readingsSection(nw, newWording.length),
      disputed: dp && { recall: dp.recall, precision: dp.precision, positives: dp.positives, misses: dp.misses, beforeChecks: dp.beforeChecks, droppedTruePositives: dp.droppedTruePositives, ...usageRow(dp.usage, disputed.length), ranAt: now },
    });
  }

  const gates = { extractFieldAccuracy: 0.98, citationsVerified: 1, readingsRecall: 0.9, falseFlagRateOnClear: 0.1 };
  const dir = path.join(process.cwd(), "data", "eval");
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, "latest.json");
  const report = merge(await loadPrevious(file), {
    generatedAt: now,
    cases: { extract: extractCases.length, readings: readingCases.length, readingsNew: newWording.length, disputed: disputed.length, disputedWithClause },
    gates,
    results,
  });
  await fs.writeFile(file, JSON.stringify(report, null, 2));

  type R = { recall: number; falseFlagRateOnClear: number; p50ms?: number; p95ms?: number; costPer100?: number; caught?: number; positives?: number; clearFlagged?: number; clear?: number; beforeChecks?: { recall: number; falseFlagRateOnClear: number; caught?: number; positives?: number; clearFlagged?: number; clear?: number }; falseFlags?: FlagNote[]; droppedTruePositives?: FlagNote[]; ranAt?: string };
  type E = { fieldAccuracy: number; citationsVerified: number; p50ms: number; p95ms: number; costPer100: number; misses: string[]; ranAt?: string };
  const day = (iso?: string) => (iso ? iso.slice(0, 10) : "");
  const frac = (a?: number, b?: number) => (a != null && b != null ? ` (${a} of ${b})` : "");
  const c = report.cases;
  const lines: string[] = [];
  lines.push(`# Agent eval scorecard`, ``, `Updated ${report.generatedAt}. ${c.extract} extraction cases (half real deal notes, half paraphrased), ${c.readings} two-readings cases, ${c.readingsNew ?? 0} in new wording, ${c.disputed} disputed settlements (${c.disputedWithClause} involve a clause the engine or text can verify).`, ``);
  lines.push(`| Model | Field accuracy | Citations verified | Two-readings recall | False flags on clear emails | Disputed: recall | p50 / p95 latency (extract) | Cost per 100 extractions |`);
  lines.push(`|---|---|---|---|---|---|---|---|`);
  for (const r of report.results) {
    const ex = r.extract as E | null, rd = r.readings as R | null, dp = r.disputed as R | null;
    lines.push(
      `| ${r.label} | ${ex ? fmtPct(ex.fieldAccuracy) : "—"} | ${ex ? fmtPct(ex.citationsVerified) : "—"} | ${rd ? fmtPct(rd.recall) + frac(rd.caught, rd.positives) : "—"} | ${rd ? fmtPct(rd.falseFlagRateOnClear) + frac(rd.clearFlagged, rd.clear) : "—"} | ${dp ? fmtPct(dp.recall) : "—"} | ${ex ? `${ex.p50ms} / ${ex.p95ms} ms` : "—"} | ${ex ? `$${ex.costPer100.toFixed(4)}` : "—"} |`,
    );
  }
  lines.push(``, `Release gates: field accuracy ≥ ${fmtPct(gates.extractFieldAccuracy)}, citations ${fmtPct(gates.citationsVerified)}, two-readings recall ≥ ${fmtPct(gates.readingsRecall)}, false flags on clear emails ≤ ${fmtPct(gates.falseFlagRateOnClear)}.`);

  lines.push(``, `## Two readings: the model, then the checks`, ``);
  lines.push(`"Model" counts every flag whose quote is in the email. "After checks" is what the agent acts on (lib/agent/tasks/flagChecks.ts).`, ``);
  lines.push(`| Model | Recall: model → after checks | False flags on clear: model → after checks | New wording: recall | New wording: false flags | True flags the checks dropped | p50 / p95 per case | Cost per 100 cases | Run |`);
  lines.push(`|---|---|---|---|---|---|---|---|---|`);
  for (const r of report.results) {
    const rd = r.readings as R | null, nw = r.readingsNew as R | null, dp = r.disputed as R | null;
    if (!rd) continue;
    const b = rd.beforeChecks;
    const lost = (rd.droppedTruePositives?.length ?? 0) + (nw?.droppedTruePositives?.length ?? 0) + (dp?.droppedTruePositives?.length ?? 0);
    lines.push(
      `| ${r.label} | ${b ? `${fmtPct(b.recall)} → ` : ""}${fmtPct(rd.recall)} | ${b ? `${fmtPct(b.falseFlagRateOnClear)}${frac(b.clearFlagged, b.clear)} → ` : ""}${fmtPct(rd.falseFlagRateOnClear)}${frac(rd.clearFlagged, rd.clear)} | ${nw ? fmtPct(nw.recall) + frac(nw.caught, nw.positives) : "—"} | ${nw ? fmtPct(nw.falseFlagRateOnClear) + frac(nw.clearFlagged, nw.clear) : "—"} | ${b ? lost : "—"} | ${rd.p50ms != null ? `${(rd.p50ms / 1000).toFixed(1)} / ${((rd.p95ms ?? 0) / 1000).toFixed(1)} s` : "—"} | ${rd.costPer100 != null ? `$${rd.costPer100.toFixed(4)}` : "—"} | ${day(rd.ranAt)} |`,
    );
  }
  for (const r of report.results) {
    const all = (["readings", "readingsNew", "disputed"] as const).flatMap((k) => ((r[k] as R | null)?.ranAt === now ? (r[k] as R) : null) ?? []);
    const ff = all.flatMap((x) => x.falseFlags ?? []);
    const lost = all.flatMap((x) => x.droppedTruePositives ?? []);
    if (ff.length) {
      lines.push(``, `**${r.label}, every false flag this run:**`);
      for (const f of ff) lines.push(`- ${f.case}: ${f.type} on "${f.quote}"${f.dropped ? ` (dropped: ${f.dropped})` : " (kept)"}`);
    }
    if (lost.length) {
      lines.push(``, `**${r.label}, real flags the checks dropped (recall the checks cost):**`);
      for (const f of lost) lines.push(`- ${f.case}: ${f.type} on "${f.quote}" (${f.dropped})`);
    }
  }
  for (const r of report.results) {
    const ex = r.extract as E | null, rd = r.readings as R & { misses?: string[] } | null;
    const miss = [...(ex?.ranAt === now ? ex.misses ?? [] : []), ...(rd?.ranAt === now ? rd.misses ?? [] : [])];
    if (miss.length) lines.push(``, `**${r.label}, sample misses:**`, ...miss.slice(0, 10).map((m) => `- ${m}`));
  }
  await fs.writeFile(path.join(dir, "report.md"), lines.join("\n") + "\n");
  const detailStart = lines.indexOf(`## Two readings: the model, then the checks`);
  console.log(`\n${lines.slice(4, 6 + report.results.length).join("\n")}\n\n${lines.slice(detailStart + 4, detailStart + 6 + report.results.length).join("\n")}\n\nWrote data/eval/report.md and data/eval/latest.json`);
  client.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
