/**
 * Eval datasets, built deterministically from the venue's own history.
 *
 *  - extract-real:        the deal notes as written, wrapped as an email. Truth = the structured deal record.
 *  - extract-paraphrased: the same deals written in different words, to test generalization.
 *  - readings:            emails with known two-reading clauses (and explicit, unambiguous versions as negatives).
 *  - disputed-real:       the 24 disputed settlements' deal notes. Truth = what the engine can verify.
 */

import { eq } from "drizzle-orm";
import { db } from "@/db";
import { shows, deals, settlements, artists, ticketSales, expenses, comps, venues } from "@/db/schema";
import { settleWithDecisions, runChecks } from "@/lib/settlementEngine";
import type { DealType } from "./tasks/extractTerms";
import type { ReadingType } from "./tasks/findTwoReadings";

export type TruthTerms = {
  dealType: DealType;
  guaranteeAmount: number | null;
  percentage: number | null;
  expenseCap: number | null;
  hospitalityCap: number | null;
  /** Fields that can be graded from the email text (a value must be stated to be extractable). */
  gradable: ("dealType" | "guaranteeAmount" | "percentage" | "expenseCap" | "hospitalityCap")[];
};

export type ExtractCase = { id: string; suite: "extract-real" | "extract-paraphrased"; email: string; truth: TruthTerms };
export type ReadingsCase = { id: string; suite: "readings" | "disputed-real"; email: string; truth: ReadingType[]; note?: string };

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const usd = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;
const pct = (p: number) => Math.round(p * 100);
const wrap = (artist: string, body: string, sender = "Sam") => `Hi Mariana,\n\nConfirming ${artist} at The Crescent.\n\n${body}\n\nThanks,\n${sender}`;

function numberAppears(text: string, value: number): boolean {
  const variants = [Math.round(value).toLocaleString("en-US"), String(Math.round(value))];
  if (value >= 1000 && value % 100 === 0) variants.push(`${value / 1000}k`);
  return variants.some((v) => new RegExp(`(^|[^\\d.,])\\$?${v.replace(/[.$]/g, "\\$&")}(?![\\d,])`, "i").test(text));
}

function percentAppears(text: string, p: number): boolean {
  const n = pct(p);
  return new RegExp(`\\b${n}\\s*(%|/|percent)`, "i").test(text);
}

const CHANGE_MARKERS = /renegotiat|updated|structured field|\(was |confirm before|was \d/i;

type DealRow = { showId: string; artist: string; deal: typeof deals.$inferSelect };

async function loadDeals(): Promise<DealRow[]> {
  const rows = await db
    .select({ show: shows, deal: deals, artist: artists })
    .from(shows)
    .innerJoin(deals, eq(deals.showId, shows.id))
    .leftJoin(artists, eq(artists.id, shows.artistId));
  return rows.map((r) => ({ showId: r.show.id, artist: r.artist?.name ?? "the artist", deal: r.deal })).sort((a, b) => a.showId.localeCompare(b.showId));
}

function stratified<T extends { deal: { dealType: string } }>(rows: T[], n: number, rand: () => number): T[] {
  const types = ["vs", "flat", "percentage_of_net", "percentage_of_gross", "door"];
  const per = Math.ceil(n / types.length);
  const out: T[] = [];
  for (const t of types) {
    const pool = rows.filter((r) => r.deal.dealType === t);
    const shuffled = [...pool].sort(() => rand() - 0.5);
    out.push(...shuffled.slice(0, per));
  }
  return out.slice(0, n);
}

export async function buildExtractCases(n = 25, seed = 7): Promise<ExtractCase[]> {
  const rand = rng(seed);
  const all = await loadDeals();
  const usable = all.filter((r) => r.deal.dealNotesFreetext && !CHANGE_MARKERS.test(r.deal.dealNotesFreetext) && !r.showId.includes("dispute"));
  const real = stratified(usable, n, rand).map((r): ExtractCase => {
    const notes = r.deal.dealNotesFreetext!;
    const d = r.deal;
    const gradable: TruthTerms["gradable"] = ["dealType"];
    const grade = (field: "guaranteeAmount" | "expenseCap" | "hospitalityCap") => {
      const v = d[field];
      if (v == null || numberAppears(notes, v)) gradable.push(field);
    };
    grade("guaranteeAmount");
    grade("expenseCap");
    grade("hospitalityCap");
    if (d.percentage == null || percentAppears(notes, d.percentage)) gradable.push("percentage");
    return {
      id: `real:${r.showId}`,
      suite: "extract-real",
      email: wrap(r.artist, notes),
      truth: { dealType: d.dealType, guaranteeAmount: d.guaranteeAmount, percentage: d.dealType === "door" ? null : d.percentage, expenseCap: d.expenseCap, hospitalityCap: d.hospitalityCap, gradable },
    };
  });

  const para = stratified(usable.filter((r) => !real.some((x) => x.id === `real:${r.showId}`)), n, rand).map((r): ExtractCase => {
    const d = r.deal;
    const pick = <T,>(xs: T[]) => xs[Math.floor(rand() * xs.length)];
    const parts: string[] = [];
    const g = d.guaranteeAmount != null ? usd(d.guaranteeAmount) : "";
    const p = d.percentage != null ? pct(d.percentage) : 0;
    switch (d.dealType) {
      case "vs":
        parts.push(
          d.percentageBasis === "gross"
            ? pick([`We'll pay the greater of ${g} or ${p}% of the gross, with no expenses deducted.`, `${g} floor against ${p}% of gross box office, whichever comes out higher. No expenses come out.`])
            : pick([`We'll pay the greater of ${g} or ${p}% of net receipts after show costs.`, `${g} guarantee against ${p}% of the net, whichever comes out higher.`, `A ${g} floor versus a ${p}/${100 - p} split of net.`]),
        );
        break;
      case "flat":
        parts.push(pick([`Flat fee of ${g}, all in, no backend.`, `${g} flat. That's the whole deal.`, `A straight ${g} buyout.`]));
        break;
      case "percentage_of_net":
        parts.push(pick([`Straight ${p}/${100 - p} split of net after show costs. No guarantee.`, `The artist takes ${p}% of net once expenses come out. No floor.`]));
        break;
      case "percentage_of_gross":
        parts.push(pick([`${p}% of gross box office to the artist. No expenses deducted.`, `The band gets ${p}% of the gross, off the top.`]));
        break;
      case "door":
        parts.push(pick([`Door deal: the band keeps ticket receipts less show costs.`, `It's a door deal. Artist takes the door after expenses.`]));
        break;
    }
    if (d.expenseCap != null && d.dealType !== "flat" && d.dealType !== "percentage_of_gross" && !(d.dealType === "vs" && d.percentageBasis === "gross")) {
      parts.push(pick([`Show costs capped at ${usd(d.expenseCap)}.`, `Expenses not to exceed ${usd(d.expenseCap)}.`, `Expense cap of ${usd(d.expenseCap)}.`]));
    }
    if (d.hospitalityCap != null) parts.push(pick([`Hospitality up to ${usd(d.hospitalityCap)}.`, `Rider and catering capped at ${usd(d.hospitalityCap)} (hospitality).`, `Hospitality cap ${usd(d.hospitalityCap)}.`]));
    const email = wrap(r.artist, parts.join(" "));
    const cap = parts.some((x) => /capped at|not to exceed|Expense cap of/.test(x) && !/hospitality/i.test(x)) ? d.expenseCap : null;
    return {
      id: `para:${r.showId}`,
      suite: "extract-paraphrased",
      email,
      truth: {
        dealType: d.dealType,
        guaranteeAmount: d.dealType === "door" || d.dealType === "percentage_of_net" || d.dealType === "percentage_of_gross" ? null : d.guaranteeAmount,
        percentage: d.dealType === "door" || d.dealType === "flat" ? null : d.percentage,
        expenseCap: cap,
        hospitalityCap: d.hospitalityCap,
        gradable: ["dealType", "guaranteeAmount", "percentage", "expenseCap", "hospitalityCap"],
      },
    };
  });
  return [...real, ...para];
}

export async function buildReadingsCases(seed = 11): Promise<ReadingsCase[]> {
  const rand = rng(seed);
  const all = await loadDeals();
  const base = all.filter((r) => r.deal.dealType === "vs" && r.deal.percentageBasis === "net" && r.deal.expenseCap != null).sort(() => rand() - 0.5);
  const doors = all.filter((r) => r.deal.dealType === "door").sort(() => rand() - 0.5);
  const flats = all.filter((r) => r.deal.dealType === "flat").sort(() => rand() - 0.5);
  let i = 0;
  const next = () => base[i++ % base.length];
  const core = (r: DealRow) => `${usd(r.deal.guaranteeAmount ?? 0)} vs ${pct(r.deal.percentage ?? 0.8)}% of net after expenses, whichever greater. Expenses capped at ${usd(r.deal.expenseCap ?? 1000)}.`;
  const cases: ReadingsCase[] = [];
  const add = (id: string, email: string, truth: ReadingType[], note?: string) => cases.push({ id, suite: "readings", email, truth, note });

  const recoup = [
    (n: number) => `Marketing recoup of ${usd(n)} against gross.`,
    (n: number) => `We'll recoup ${usd(n)} in ad spend from the box office.`,
    (n: number) => `Plus a ${usd(n)} radio and social spend that comes back to the venue.`,
  ];
  recoup.forEach((f, k) => {
    const r = next();
    add(`recoup-${k}`, wrap(r.artist, `${core(r)} ${f(600 + k * 150)}`), ["recoup_vs_cap"]);
  });
  [
    (n: number) => `Marketing recoup of ${usd(n)}, included in the expense cap.`,
    (n: number) => `Marketing recoup of ${usd(n)} in addition to the expense cap.`,
  ].forEach((f, k) => {
    const r = next();
    add(`recoup-explicit-${k}`, wrap(r.artist, `${core(r)} ${f(700)}`), [], "explicit: should not be flagged");
  });

  [
    `Door deal. Artist gets ticket revenue minus expenses (capped $900).`,
    `It's a door split: the band keeps the door after costs, costs capped at $1,200.`,
    `Artist takes the box office less show expenses, capped at $800. Door deal.`,
  ].forEach((t, k) => add(`door-${k}`, wrap(doors[k].artist, t), ["door_fees"]));
  add("door-explicit-0", wrap(doors[3].artist, `Door deal. Artist gets ticket revenue after ticketing fees and expenses (capped $1,000).`), [], "explicit: should not be flagged");

  [
    (t: number) => `Walkout pot: 100% of gross above ${usd(t)}.`,
    (t: number) => `And everything over ${usd(t)} in gross goes to the artist.`,
    (t: number) => `Walkout above breakeven: all incremental gross past ${usd(t)} is the band's.`,
  ].forEach((f, k) => {
    const r = next();
    add(`walkout-${k}`, wrap(r.artist, `${core(r)} ${f(9000 + k * 1500)}`), ["walkout_amount"]);
  });

  [
    `Ratchets to 85% over 80% of capacity.`,
    `The rate steps up to 90% once we pass 75% of tickets sold.`,
    `Escalator: moves to 85% after 400 tickets.`,
  ].forEach((t, k) => {
    const r = next();
    add(`ratchet-${k}`, wrap(r.artist, `${core(r)} ${t}`), ["ratchet_scope"]);
  });

  [
    `Update after our call: the bonus threshold is now $6,000 (was $11,000).`,
    `Renegotiated last week: guarantee moves up to $3,900.`,
    `Quick change from the original offer: hospitality goes to $600.`,
  ].forEach((t, k) => {
    const r = next();
    add(`changed-${k}`, wrap(r.artist, `${core(r)} ${t}`), ["changed_after_booking"]);
  });

  [
    `Performance bonuses per the deal memo (see email thread).`,
    `Sellout bonus as discussed on the phone.`,
    `Plus the usual merch terms we agreed last tour.`,
  ].forEach((t, k) => {
    const r = next();
    add(`missing-${k}`, wrap(r.artist, `${core(r)} ${t}`), ["missing_terms"]);
  });

  for (let k = 0; k < 4; k++) {
    const r = next();
    add(`clean-vs-${k}`, wrap(r.artist, `${core(r)} Hospitality cap $400.`), []);
  }
  for (let k = 0; k < 3; k++) add(`clean-flat-${k}`, wrap(flats[k].artist, `Flat guarantee ${usd(flats[k].deal.guaranteeAmount ?? 1500)}. No upside.`), []);

  add(
    "coastal-spell-real",
    wrap("Coastal Spell", "$5,000 vs 80% of net after expenses, whichever greater. Expenses capped at $2,500, marketing recoup of $900 against gross. Hospitality cap $500. +$1,000 bonus if gross exceeds $25,000.", "Andrea"),
    ["recoup_vs_cap"],
    "the real clause behind the Coastal Spell dispute",
  );
  return cases;
}

const KEY_TO_TYPE: Record<string, ReadingType | undefined> = {
  walkout: "walkout_amount",
  doorFees: "door_fees",
  ratchet: "ratchet_scope",
  recoupPlacement: "recoup_vs_cap",
};

/** The 24 disputed settlements. Truth is only what the engine can verify from the deal itself. */
export async function buildDisputedCases(): Promise<ReadingsCase[]> {
  const rows = await db
    .select({ show: shows, deal: deals, s: settlements, artist: artists, v: venues })
    .from(shows)
    .innerJoin(deals, eq(deals.showId, shows.id))
    .innerJoin(settlements, eq(settlements.showId, shows.id))
    .leftJoin(artists, eq(artists.id, shows.artistId))
    .leftJoin(venues, eq(venues.id, shows.venueId))
    .where(eq(settlements.status, "disputed"));
  const out: ReadingsCase[] = [];
  for (const r of rows) {
    const [ts, ex, cp] = await Promise.all([
      db.select().from(ticketSales).where(eq(ticketSales.showId, r.show.id)),
      db.select().from(expenses).where(eq(expenses.showId, r.show.id)),
      db.select().from(comps).where(eq(comps.showId, r.show.id)),
    ]);
    const recoups = r.s.recoupsJson ? JSON.parse(r.s.recoupsJson) : [];
    const input = { deal: r.deal, ticketSales: ts, expenses: ex, comps: cp, recoups, venueCapacity: r.v?.capacity ?? null };
    const full = settleWithDecisions(input);
    const truth = new Set<ReadingType>();
    for (const d of full.decisions) {
      const t = KEY_TO_TYPE[d.key];
      if (t) truth.add(t);
    }
    if (runChecks(input, []).some((c) => /term changed/i.test(c.title))) truth.add("changed_after_booking");
    const notes = (r.deal.dealNotesFreetext ?? "").replace(/\s*\(Note added[^)]*\)\s*/gi, " ").trim();
    // Clauses that are ambiguous on their face, even when this show's numbers made both readings pay the same.
    if (r.deal.expenseCap != null && /recoup/i.test(notes)) truth.add("recoup_vs_cap");
    if (/per the (deal memo|email)|see email thread/i.test(notes)) truth.add("missing_terms");
    if (/ratchet|escalator/i.test(notes)) truth.add("ratchet_scope");
    if (/100% of gross above|walkout/i.test(notes)) truth.add("walkout_amount");
    if (r.deal.dealType === "door" && !/fees/i.test(notes)) truth.add("door_fees");
    out.push({ id: `disputed:${r.show.id}`, suite: "disputed-real", email: wrap(r.artist?.name ?? "the artist", notes), truth: [...truth] });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}
