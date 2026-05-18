/**
 * Artist-level historical aggregates used by the Deal Builder recommender.
 *
 * Reads only *settled* past shows at the same venue. Designed to feed
 * provenance (each aggregate carries the show IDs that fed it) so that the
 * recommender's "Why this?" affordance is one query away.
 *
 * Cold-start: if an artist has fewer than 3 prior shows at this venue, the
 * caller falls back to deal-type aggregates (see `getDealTypeAggregates`).
 */

import { db } from "@/db";
import { shows, deals, ticketSales, expenses, settlements } from "@/db/schema";
import { and, eq, lte, sql } from "drizzle-orm";
import type { Deal } from "@/db/schema";

export type ShowAggregateRow = {
  showId: string;
  date: string;
  dealType: Deal["dealType"];
  gross: number;
  fees: number;
  totalExpenses: number;
  totalToArtist: number;
  attendance: number;
};

export type ArtistHistory = {
  artistId: string;
  artistName: string | null;
  venueId: string;
  priorShows: ShowAggregateRow[];
  // Aggregates across ALL prior shows for this artist at this venue.
  expenses: {
    p25: number;
    p50: number;
    p75: number;
    mean: number;
    sourceShowIds: string[];
  };
  gross: {
    p25: number;
    p50: number;
    p75: number;
    mean: number;
    sourceShowIds: string[];
  };
  attendance: {
    p50: number;
    sourceShowIds: string[];
  };
  confidence: "high" | "medium" | "low";
};

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.floor(p * (sorted.length - 1))),
  );
  return sorted[idx];
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

function todayIso(): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString().slice(0, 10);
}

/**
 * Fetch a single artist's prior settled shows at this venue, plus aggregates.
 */
export async function getArtistHistory(
  artistId: string,
  venueId: string,
  excludeShowId?: string,
): Promise<ArtistHistory> {
  const today = todayIso();

  const rows = await db
    .select({
      showId: shows.id,
      date: shows.date,
      dealType: deals.dealType,
      gross: sql<number>`coalesce(${ticketSales.gross}, 0)`,
      fees: sql<number>`coalesce(${ticketSales.fees}, 0)`,
      attendance: sql<number>`coalesce(${ticketSales.qty}, 0)`,
      totalToArtist: sql<number>`coalesce(${settlements.totalToArtist}, 0)`,
    })
    .from(shows)
    .leftJoin(deals, eq(deals.showId, shows.id))
    .leftJoin(ticketSales, eq(ticketSales.showId, shows.id))
    .leftJoin(settlements, eq(settlements.showId, shows.id))
    .where(
      and(
        eq(shows.artistId, artistId),
        eq(shows.venueId, venueId),
        lte(shows.date, today),
      ),
    );

  // Per-show expense totals (separate aggregate query — cleaner than nesting).
  const expenseRows = await db
    .select({
      showId: expenses.showId,
      total: sql<number>`coalesce(sum(${expenses.amount}), 0)`,
    })
    .from(expenses)
    .groupBy(expenses.showId);
  const expenseByShow = new Map(expenseRows.map((r) => [r.showId, r.total]));

  const priorShows: ShowAggregateRow[] = rows
    .filter(
      (r) =>
        r.showId &&
        r.dealType &&
        r.showId !== excludeShowId,
    )
    .map((r) => ({
      showId: r.showId,
      date: r.date,
      dealType: r.dealType as Deal["dealType"],
      gross: Number(r.gross),
      fees: Number(r.fees),
      totalExpenses: Number(expenseByShow.get(r.showId) ?? 0),
      totalToArtist: Number(r.totalToArtist),
      attendance: Number(r.attendance),
    }))
    .sort((a, b) => b.date.localeCompare(a.date));

  const expenseVals = priorShows.map((s) => s.totalExpenses);
  const grossVals = priorShows.map((s) => s.gross);
  const attendanceVals = priorShows.map((s) => s.attendance);

  const confidence: ArtistHistory["confidence"] =
    priorShows.length >= 5
      ? "high"
      : priorShows.length >= 3
        ? "medium"
        : "low";

  return {
    artistId,
    artistName: null,
    venueId,
    priorShows,
    expenses: {
      p25: percentile(expenseVals, 0.25),
      p50: percentile(expenseVals, 0.5),
      p75: percentile(expenseVals, 0.75),
      mean: mean(expenseVals),
      sourceShowIds: priorShows.map((s) => s.showId),
    },
    gross: {
      p25: percentile(grossVals, 0.25),
      p50: percentile(grossVals, 0.5),
      p75: percentile(grossVals, 0.75),
      mean: mean(grossVals),
      sourceShowIds: priorShows.map((s) => s.showId),
    },
    attendance: {
      p50: percentile(attendanceVals, 0.5),
      sourceShowIds: priorShows.map((s) => s.showId),
    },
    confidence,
  };
}

/**
 * Cross-artist aggregates by deal type — the cold-start floor for new artists.
 * Cached at module level for the lifetime of a server boot.
 */
type DealTypeAggregates = Record<
  Deal["dealType"],
  {
    expenses: { p25: number; p50: number; p75: number; mean: number };
    gross: { p25: number; p50: number; p75: number; mean: number };
    venueEarningsPct: number; // Of gross, historically. Used for sanity bands.
    sampleSize: number;
  }
>;

let _dealTypeAggregateCache: DealTypeAggregates | null = null;

export async function getDealTypeAggregates(
  venueId: string,
): Promise<DealTypeAggregates> {
  if (_dealTypeAggregateCache) return _dealTypeAggregateCache;

  const today = todayIso();

  const rows = await db
    .select({
      showId: shows.id,
      dealType: deals.dealType,
      gross: sql<number>`coalesce(${ticketSales.gross}, 0)`,
      fees: sql<number>`coalesce(${ticketSales.fees}, 0)`,
      totalToArtist: sql<number>`coalesce(${settlements.totalToArtist}, 0)`,
    })
    .from(shows)
    .leftJoin(deals, eq(deals.showId, shows.id))
    .leftJoin(ticketSales, eq(ticketSales.showId, shows.id))
    .leftJoin(settlements, eq(settlements.showId, shows.id))
    .where(and(eq(shows.venueId, venueId), lte(shows.date, today)));

  const expenseRows = await db
    .select({
      showId: expenses.showId,
      total: sql<number>`coalesce(sum(${expenses.amount}), 0)`,
    })
    .from(expenses)
    .groupBy(expenses.showId);
  const expenseByShow = new Map(expenseRows.map((r) => [r.showId, r.total]));

  const byType = new Map<
    string,
    { expenses: number[]; gross: number[]; venueShares: number[] }
  >();
  for (const r of rows) {
    if (!r.dealType) continue;
    const bucket = byType.get(r.dealType) ?? {
      expenses: [],
      gross: [],
      venueShares: [],
    };
    const exp = Number(expenseByShow.get(r.showId) ?? 0);
    const gross = Number(r.gross);
    const venueEarnings =
      gross - Number(r.fees) - exp - Number(r.totalToArtist);
    bucket.expenses.push(exp);
    bucket.gross.push(gross);
    if (gross > 0) bucket.venueShares.push(venueEarnings / gross);
    byType.set(r.dealType, bucket);
  }

  const result = {} as DealTypeAggregates;
  for (const t of [
    "flat",
    "percentage_of_gross",
    "percentage_of_net",
    "vs",
    "door",
  ] as const) {
    const bucket = byType.get(t) ?? {
      expenses: [],
      gross: [],
      venueShares: [],
    };
    result[t] = {
      expenses: {
        p25: percentile(bucket.expenses, 0.25),
        p50: percentile(bucket.expenses, 0.5),
        p75: percentile(bucket.expenses, 0.75),
        mean: mean(bucket.expenses),
      },
      gross: {
        p25: percentile(bucket.gross, 0.25),
        p50: percentile(bucket.gross, 0.5),
        p75: percentile(bucket.gross, 0.75),
        mean: mean(bucket.gross),
      },
      venueEarningsPct: mean(bucket.venueShares),
      sampleSize: bucket.expenses.length,
    };
  }

  _dealTypeAggregateCache = result;
  return result;
}

/**
 * The venue-wide average total expenses — used as the cancellation flag floor.
 * Per BR-07: if projected gross < this, flag for cancellation.
 */
export async function getVenueAverageExpenses(
  venueId: string,
): Promise<number> {
  const aggs = await getDealTypeAggregates(venueId);
  const all = [
    aggs.flat.expenses.mean,
    aggs.percentage_of_gross.expenses.mean,
    aggs.percentage_of_net.expenses.mean,
    aggs.vs.expenses.mean,
    aggs.door.expenses.mean,
  ].filter((v) => v > 0);
  return all.length > 0 ? mean(all) : 0;
}
