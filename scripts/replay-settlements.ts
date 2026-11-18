/**
 * Replay test: run every past settlement through the new engine and compare
 * with what was actually paid.
 *
 *   npm run replay
 *
 * For each settled show:
 *   1. Settle as written (default readings).
 *   2. If that matches the recorded payout (within $1) → "matches as written".
 *   3. Otherwise, settle again under "past practice" (every as-written switch
 *      off). If THAT matches, the difference is explained by how the venue
 *      used to settle — and we attribute the dollars to each practice by
 *      turning the switches on one at a time.
 *   4. Anything still different is "needs review" — usually a data problem
 *      (edited receipts, renegotiated terms, a concession made after the fact).
 *
 * Writes data/replay-report.md.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";
import { db, client } from "../db/index";
import { shows, deals, ticketSales, expenses, comps, settlements, venues } from "../db/schema";
import type { Recoup } from "../db/schema";
import {
  settle,
  settleWithDecisions,
  AS_WRITTEN,
  DEFAULT_READINGS,
  type Practice,
  type SettlementInput,
} from "../lib/settlementEngine";

const PAST_PRACTICE: Practice = {
  countCompsTowardGross: false,
  chargeRecoups: false,
  vsGrossWithoutExpenses: false,
  payStackingBonuses: false,
  applyRatchets: false,
  payOtherBonuses: false,
  doorFeesOffTop: false,
};

const PRACTICE_LABELS: Record<keyof Practice, string> = {
  countCompsTowardGross: "Comps flagged to count toward gross were left out",
  chargeRecoups: "Agreed recoups and advances weren't charged",
  vsGrossWithoutExpenses: "Vs-gross deals were settled on net (expenses taken out)",
  payStackingBonuses: "Stacking bonuses were only paid when the % beat the guarantee",
  applyRatchets: "Ratchets (higher % above a sales tier) weren't applied",
  payOtherBonuses: "Sellout / attendance bonuses weren't paid",
  doorFeesOffTop: "Door deals were split before ticketing fees (one of two readings, flagged as a decision)",
};

const fmt = (n: number) => (n < 0 ? "−$" : "$") + Math.abs(Math.round(n)).toLocaleString("en-US");

async function main() {
  const rows = await db
    .select({ show: shows, deal: deals, settlement: settlements, venue: venues })
    .from(shows)
    .innerJoin(deals, eq(deals.showId, shows.id))
    .innerJoin(settlements, eq(settlements.showId, shows.id))
    .leftJoin(venues, eq(venues.id, shows.venueId))
    .where(eq(shows.status, "settled"));

  const [allTs, allExp, allComps] = await Promise.all([
    db.select().from(ticketSales),
    db.select().from(expenses),
    db.select().from(comps),
  ]);
  const group = <T extends { showId: string }>(xs: T[]) => {
    const m = new Map<string, T[]>();
    for (const x of xs) m.set(x.showId, [...(m.get(x.showId) ?? []), x]);
    return m;
  };
  const tsBy = group(allTs);
  const expBy = group(allExp);
  const compBy = group(allComps);

  type Row = {
    showId: string;
    date: string;
    dealType: string;
    recorded: number;
    asWritten: number;
    outcome: "match" | "explained" | "review";
    reasons: { label: string; dollars: number }[];
    decisions: number;
    status: string;
  };
  const out: Row[] = [];
  let skipped = 0;

  for (const r of rows) {
    if (r.settlement.status === "voided" || r.settlement.totalToArtist == null) {
      skipped++;
      continue;
    }
    let recoups: Recoup[] = [];
    try {
      recoups = r.settlement.recoupsJson ? JSON.parse(r.settlement.recoupsJson) : [];
    } catch {
      recoups = [];
    }
    const input: SettlementInput = {
      deal: r.deal,
      ticketSales: tsBy.get(r.show.id) ?? [],
      expenses: expBy.get(r.show.id) ?? [],
      comps: compBy.get(r.show.id) ?? [],
      recoups,
      venueCapacity: r.venue?.capacity ?? null,
    };
    const recorded = r.settlement.totalToArtist;
    const full = settleWithDecisions(input);
    const asWritten = full.totalToArtist;

    let outcome: Row["outcome"] = "review";
    const reasons: Row["reasons"] = [];
    if (Math.abs(asWritten - recorded) <= 1) {
      outcome = "match";
    } else {
      const past = settle(input, DEFAULT_READINGS, PAST_PRACTICE).totalToArtist;
      if (Math.abs(past - recorded) <= 1) {
        outcome = "explained";
        // Attribute: walk from past practice to as-written, one switch at a time.
        let cur: Practice = { ...PAST_PRACTICE };
        let prev = past;
        for (const k of Object.keys(PRACTICE_LABELS) as (keyof Practice)[]) {
          cur = { ...cur, [k]: AS_WRITTEN[k] };
          const next = settle(input, DEFAULT_READINGS, cur).totalToArtist;
          if (Math.abs(next - prev) > 0.5) reasons.push({ label: PRACTICE_LABELS[k], dollars: next - prev });
          prev = next;
        }
      }
    }
    out.push({
      showId: r.show.id,
      date: r.show.date,
      dealType: r.deal.dealType,
      recorded,
      asWritten,
      outcome,
      reasons,
      decisions: full.decisions.length,
      status: r.settlement.status,
    });
  }

  // ---------- summarize
  const total = out.length;
  const by = (o: Row["outcome"]) => out.filter((x) => x.outcome === o);
  const match = by("match");
  const explained = by("explained");
  const review = by("review");
  const types = ["flat", "percentage_of_gross", "percentage_of_net", "vs", "door"];
  const oldEngineSupported = out.filter((x) => x.dealType === "flat" || x.dealType === "percentage_of_gross").length;

  const reasonTotals = new Map<string, { shows: number; dollars: number; under: number; over: number }>();
  for (const x of explained) {
    for (const rr of x.reasons) {
      const t = reasonTotals.get(rr.label) ?? { shows: 0, dollars: 0, under: 0, over: 0 };
      t.shows++;
      t.dollars += rr.dollars;
      if (rr.dollars > 0) t.under += rr.dollars;
      else t.over += -rr.dollars;
      reasonTotals.set(rr.label, t);
    }
  }
  const netDiff = explained.reduce((s, x) => s + (x.asWritten - x.recorded), 0);
  const withDecisions = out.filter((x) => x.decisions > 0);

  const lines: string[] = [];
  lines.push("# Settlement replay report");
  lines.push("");
  lines.push(`Generated by \`npm run replay\` on ${new Date().toISOString().slice(0, 10)}. Every past settled show (${total}; ${skipped} voided skipped) run through \`lib/settlementEngine.ts\` and compared with the payout recorded at the time.`);
  lines.push("");
  lines.push("## Headline");
  lines.push("");
  lines.push(`| Result | Shows | Share |`);
  lines.push(`|---|---:|---:|`);
  lines.push(`| Settled by the new engine (all five deal types) | ${total} | 100% |`);
  lines.push(`| …the old engine could settle (flat, % of gross) | ${oldEngineSupported} | ${Math.round((oldEngineSupported / total) * 100)}% |`);
  lines.push(`| Matches the recorded payout exactly, as written | ${match.length} | ${Math.round((match.length / total) * 100)}% |`);
  lines.push(`| Differs, fully explained by past settlement practice | ${explained.length} | ${Math.round((explained.length / total) * 100)}% |`);
  lines.push(`| Differs, needs human review (data or after-the-fact changes) | ${review.length} | ${Math.round((review.length / total) * 100)}% |`);
  lines.push(`| Have at least one term that can be read two ways (a decision) | ${withDecisions.length} | ${Math.round((withDecisions.length / total) * 100)}% |`);
  lines.push("");
  lines.push("## Where past practice departed from the written deal");
  lines.push("");
  lines.push(`Net effect on artist pay across the explained shows: ${fmt(netDiff)} (positive = artists were paid less than the deal as written, using the default reading of each ambiguous term).`);
  lines.push("");
  lines.push("| Practice | Shows | Artist underpaid | Artist overpaid |");
  lines.push("|---|---:|---:|---:|");
  for (const [label, t] of [...reasonTotals.entries()].sort((a, b) => Math.abs(b[1].dollars) - Math.abs(a[1].dollars))) {
    lines.push(`| ${label} | ${t.shows} | ${fmt(t.under)} | ${fmt(t.over)} |`);
  }
  lines.push("");
  lines.push("## By deal type");
  lines.push("");
  lines.push("| Deal type | Shows | Match | Explained | Review |");
  lines.push("|---|---:|---:|---:|---:|");
  for (const t of types) {
    const xs = out.filter((x) => x.dealType === t);
    lines.push(`| ${t} | ${xs.length} | ${xs.filter((x) => x.outcome === "match").length} | ${xs.filter((x) => x.outcome === "explained").length} | ${xs.filter((x) => x.outcome === "review").length} |`);
  }
  lines.push("");
  lines.push("## Needs review");
  lines.push("");
  lines.push("| Show | Date | Deal | Recorded | Engine (as written) | Difference | Settlement status |");
  lines.push("|---|---|---|---:|---:|---:|---|");
  for (const x of review.sort((a, b) => Math.abs(b.asWritten - b.recorded) - Math.abs(a.asWritten - a.recorded))) {
    lines.push(`| ${x.showId} | ${x.date} | ${x.dealType} | ${fmt(x.recorded)} | ${fmt(x.asWritten)} | ${fmt(x.asWritten - x.recorded)} | ${x.status} |`);
  }
  lines.push("");

  const report = lines.join("\n");
  await fs.writeFile(path.join(process.cwd(), "data", "replay-report.md"), report, "utf-8");
  console.log(report.split("## By deal type")[0]);
  client.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
