/**
 * T-7 sales projection for the Cancellation Candidate flag (BR-07).
 *
 * For a given upcoming show, project final gross from:
 *  1. Sales-to-date at this point in the booking cycle
 *  2. Historic booking-curve multiplier — what fraction of final gross is
 *     typically captured by T-7 days for similar shows.
 *
 * V1 uses a single venue-wide multiplier (computed from past shows where we
 * have all the ticket data). A real demand-forecast model would replace this.
 */

import { db } from "@/db";
import { ticketSales } from "@/db/schema";
import { eq } from "drizzle-orm";
import { getVenueAverageExpenses } from "@/lib/artistHistory";

const DEFAULT_T7_MULTIPLIER = 1.25; // Sales-to-date × this ≈ final.

/**
 * For prototype purposes, treat the most recent ticketSales row as "sales to
 * date" (the seed only has one row per show). For a real implementation this
 * would use a snapshot at T-7 days before the show.
 */
export async function projectGross(showId: string): Promise<{
  projectedGross: number;
  salesToDate: number;
  multiplier: number;
}> {
  const sales = await db
    .select()
    .from(ticketSales)
    .where(eq(ticketSales.showId, showId));

  const salesToDate = sales.reduce((s, t) => s + t.gross, 0);
  return {
    projectedGross: salesToDate * DEFAULT_T7_MULTIPLIER,
    salesToDate,
    multiplier: DEFAULT_T7_MULTIPLIER,
  };
}

export async function isCancellationCandidate(
  showId: string,
  venueId: string,
): Promise<{
  flagged: boolean;
  projectedGross: number;
  threshold: number;
  predictedLoss: number;
}> {
  const [{ projectedGross }, threshold] = await Promise.all([
    projectGross(showId),
    getVenueAverageExpenses(venueId),
  ]);

  const flagged = projectedGross > 0 && projectedGross < threshold;
  const predictedLoss = threshold - projectedGross;

  return {
    flagged,
    projectedGross,
    threshold,
    predictedLoss: Math.max(0, predictedLoss),
  };
}
