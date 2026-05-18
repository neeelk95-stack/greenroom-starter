/**
 * The Deal Builder recommendation engine.
 *
 * Given an artist + deal type + venue, returns recommended values for every
 * numeric term, each accompanied by its provenance (source data references).
 *
 * Implements:
 *   BR-01  Net-first split for all deal types
 *   BR-02  Venue breakeven floor at p50 projected gross
 *   BR-03  Expense cap derived from artist history (or deal-type avg for new)
 *   BR-04  Door deals: net basis, breakeven-target
 *   BR-05  Walkout / bonus net-first, breakeven-locked
 *   BR-06  Pct-of-gross: % capped so venue >= 0 at p50; low-confidence ceiling
 *
 * Recommendations are deterministic — same inputs always produce the same
 * outputs. This is intentional: deal math must be reproducible/defensible.
 * The AI surface is freetext reconciliation (see lib/freetextReconciliation),
 * not the math itself.
 */

import type { Deal } from "@/db/schema";
import type { ArtistHistory } from "@/lib/artistHistory";
import type { getDealTypeAggregates } from "@/lib/artistHistory";
import type { DealTerms } from "@/lib/dealMathV2";
import { computeBreakevenGross } from "@/lib/dealMathV2";

export type DealTypeAggregates = Awaited<ReturnType<typeof getDealTypeAggregates>>;

export type Provenance = {
  // Plain-English explanation rendered to both Mariana and the agent.
  summary: string;
  // Machine-readable source data — power's the "Why this?" panel.
  source:
    | { kind: "artist_history"; showIds: string[]; metric: string; value: number }
    | { kind: "deal_type_aggregate"; dealType: Deal["dealType"]; metric: string; value: number; sampleSize: number }
    | { kind: "policy"; rule: string }
    | { kind: "computed"; from: string };
  confidence: "high" | "medium" | "low";
};

export type RecommendedField<T = number> = {
  value: T;
  // Acceptable band the user can adjust within without override. Outside this
  // band requires an override reason (FR-M-10).
  band?: { min: T; max: T };
  provenance: Provenance;
  // Hard policy block: certain values can never be saved regardless of override
  // without GM approval (e.g. door deal on gross). Captured here so the UI
  // can disable rather than rely on the engine returning an invalid value.
  hardBlocked?: { reason: string }[];
};

export type Recommendation = {
  dealType: Deal["dealType"];
  guarantee: RecommendedField | null;
  artistPercentage: RecommendedField | null;
  percentageBasis: "net" | "gross";
  expenseCap: RecommendedField;
  hospitalityCap: RecommendedField;
  // Walkout pot recommendation. Null when not permitted (e.g. low projected gross).
  walkout: RecommendedField<{ netThreshold: number; allowed: boolean }> | null;
  projectedGross: { p25: number; p50: number; p75: number };
  projectedExpenses: number;
  breakeven: { gross: number; net: number };
  // Confidence tier for the whole recommendation, based on artist history depth.
  overallConfidence: "high" | "medium" | "low";
  // Number of prior shows the recommendation drew from (0 for first-timer).
  basedOnPriorShows: number;
};

// Industry-typical default percentages, used as starting points when history
// is silent. Calibrated to current Greenroom data.
const DEFAULT_PCT_OF_NET = 0.85; // artist gets 85% of net
const DEFAULT_VS_PCT = 0.85;
const DEFAULT_PCT_OF_GROSS_CEILING = 0.6; // hard ceiling under low confidence (BR-06)
const FEE_RATE = 0.1;

// BR-05c thresholds.
const WALKOUT_100_MIN_ATTENDANCE_PCT = 0.9;
const WALKOUT_100_MIN_GROSS = 20_000;

export function recommend(args: {
  dealType: Deal["dealType"];
  artistHistory: ArtistHistory;
  dealTypeAggregates: DealTypeAggregates;
  venueCapacity: number;
  // Optional override of agent's proposed guarantee (for flat/vs validation).
  proposedGuarantee?: number;
  proposedArtistPercentage?: number;
}): Recommendation {
  const {
    dealType,
    artistHistory,
    dealTypeAggregates,
    venueCapacity,
    proposedGuarantee,
    proposedArtistPercentage,
  } = args;

  const isRepeat = artistHistory.priorShows.length >= 3;
  const overallConfidence = artistHistory.confidence;

  // ---- Projected gross (BR-02 anchor)
  const projectedGross = isRepeat
    ? {
        p25: artistHistory.gross.p25,
        p50: artistHistory.gross.p50,
        p75: artistHistory.gross.p75,
      }
    : {
        p25: dealTypeAggregates[dealType].gross.p25,
        p50: dealTypeAggregates[dealType].gross.p50,
        p75: dealTypeAggregates[dealType].gross.p75,
      };

  // ---- Projected expenses (BR-03 cap derivation)
  const projectedExpenses = isRepeat
    ? artistHistory.expenses.mean
    : dealTypeAggregates[dealType].expenses.mean;

  // ---- BR-03: expense cap = max(p75 of artist history, deal-type p50) for repeat
  //              deal-type p50 + 10% buffer for new
  const expenseCapValue = isRepeat
    ? Math.max(
        artistHistory.expenses.p75,
        dealTypeAggregates[dealType].expenses.p50,
      )
    : Math.round(dealTypeAggregates[dealType].expenses.p50 * 1.1);

  const expenseCap: RecommendedField = {
    value: roundTo50(expenseCapValue),
    band: {
      min: roundTo50(expenseCapValue * 0.85),
      max: roundTo50(expenseCapValue * 1.25),
    },
    provenance: isRepeat
      ? {
          summary: `Based on ${artistHistory.priorShows.length} prior show${artistHistory.priorShows.length === 1 ? "" : "s"} at this venue (p75 of actuals).`,
          source: {
            kind: "artist_history",
            showIds: artistHistory.expenses.sourceShowIds,
            metric: "expenses.p75",
            value: artistHistory.expenses.p75,
          },
          confidence: overallConfidence,
        }
      : {
          summary: `Based on ${dealTypeAggregates[dealType].sampleSize} prior ${friendlyDealType(dealType)} deals at this venue (deal-type median + 10% buffer).`,
          source: {
            kind: "deal_type_aggregate",
            dealType,
            metric: "expenses.p50 + 10%",
            value: dealTypeAggregates[dealType].expenses.p50,
            sampleSize: dealTypeAggregates[dealType].sampleSize,
          },
          confidence: "low",
        },
  };

  // ---- Hospitality cap: typically ~25% of expense cap or $500 floor
  const hospitalityCap: RecommendedField = {
    value: roundTo50(Math.max(500, expenseCap.value * 0.25)),
    provenance: {
      summary:
        "25% of the expense cap or $500, whichever is higher — typical venue split between hospitality and the rest of production.",
      source: { kind: "policy", rule: "Hospitality ≈ 25% of expense cap, floor $500." },
      confidence: "medium",
    },
  };

  // ---- Per-deal-type calculation of guarantee + percentage + walkout
  let guarantee: RecommendedField | null = null;
  let artistPercentage: RecommendedField | null = null;
  let percentageBasis: "net" | "gross" = "net";
  let walkout: Recommendation["walkout"] = null;

  const projectedFees = projectedGross.p50 * FEE_RATE;
  const projectedNetP50 =
    projectedGross.p50 - projectedFees - expenseCap.value;

  switch (dealType) {
    case "flat": {
      // BR-02 + BR-03: guarantee must leave venue >= 0 at p50 net.
      // Recommend guarantee at projectedNetP50 * 0.5 (split with venue), then
      // validate the agent's proposed guarantee against that ceiling.
      const guaranteeCeiling = Math.max(0, projectedNetP50);
      const recommended = roundTo50(
        Math.min(
          guaranteeCeiling * 0.5,
          // Anchor: if the artist's historical avg payout is lower, use that as a starting point
          artistHistory.priorShows.length > 0
            ? mean(artistHistory.priorShows.map((s) => s.totalToArtist)) * 0.9
            : guaranteeCeiling * 0.5,
        ),
      );
      guarantee = {
        value: Math.max(0, recommended),
        band: { min: 0, max: roundTo50(guaranteeCeiling) },
        provenance: {
          summary: `Guarantee capped so venue earnings ≥ $0 at projected p50 gross. Net at p50 ≈ ${money(projectedNetP50)}; recommended split keeps venue ahead at p25.`,
          source: { kind: "computed", from: "net_p50 × 50%" },
          confidence: overallConfidence,
        },
      };
      break;
    }

    case "door": {
      // BR-04: door on net basis, 100% to artist after venue recovers cap.
      // Venue earnings = $0 at breakeven by design.
      percentageBasis = "net";
      artistPercentage = {
        value: 1.0,
        band: { min: 0.85, max: 1.0 },
        provenance: {
          summary:
            "Door deals are computed on net (after fees and capped expenses). 100% of net goes to the artist — venue recovers fees + expenses off the top, no margin on box office (bar covers the rest).",
          source: { kind: "policy", rule: "BR-04: door deals net-basis, breakeven target." },
          confidence: "high",
        },
      };
      // Walkout disabled by default on door deals.
      break;
    }

    case "percentage_of_net": {
      percentageBasis = "net";
      const proposed = proposedArtistPercentage ?? DEFAULT_PCT_OF_NET;
      // Sanity check: at this %, does venue clear $0 at p50?
      // venue = net * (1 - pct). Always >= 0 if net >= 0.
      // The risk is when net is small — caller sees this in projection panel.
      artistPercentage = {
        value: proposed,
        band: { min: 0.75, max: 0.9 },
        provenance: {
          summary: `Industry-typical ${(proposed * 100).toFixed(0)}/${((1 - proposed) * 100).toFixed(0)} net split. Venue earnings positive at any net > $0 — focus is on the expense cap.`,
          source: { kind: "policy", rule: "% of net split, anchor 85/15." },
          confidence: overallConfidence,
        },
      };
      break;
    }

    case "percentage_of_gross": {
      // BR-06: % set so venue ≥ 0 at p50 projected gross.
      // venue = gross(1 - fee) - exp - pct*gross >= 0
      // pct <= (gross(1-fee) - exp) / gross = (1 - fee) - exp/gross
      percentageBasis = "gross";
      const maxPct =
        projectedGross.p50 > 0
          ? (1 - FEE_RATE) - expenseCap.value / projectedGross.p50
          : 0;
      const ceilingFromConfidence =
        overallConfidence === "low" ? DEFAULT_PCT_OF_GROSS_CEILING : 0.75;
      const recommended = Math.max(
        0,
        Math.min(maxPct - 0.05, ceilingFromConfidence),
      );
      artistPercentage = {
        value: roundPctTo1(recommended),
        band: {
          min: roundPctTo1(Math.max(0, recommended - 0.05)),
          max: roundPctTo1(Math.min(maxPct, ceilingFromConfidence)),
        },
        provenance: {
          summary: `Maximum % that lands venue at $0 at projected p50 gross: ${(maxPct * 100).toFixed(0)}%. ${overallConfidence === "low" ? `Low-confidence ceiling: ${(DEFAULT_PCT_OF_GROSS_CEILING * 100).toFixed(0)}%.` : ""}`,
          source: { kind: "computed", from: "(1 - fee) - cap/gross_p50" },
          confidence: overallConfidence,
        },
        hardBlocked:
          overallConfidence === "low" && recommended > DEFAULT_PCT_OF_GROSS_CEILING
            ? [
                {
                  reason: `Low-confidence artists capped at ${(DEFAULT_PCT_OF_GROSS_CEILING * 100).toFixed(0)}% of gross (BR-06). GM approval required to exceed.`,
                },
              ]
            : undefined,
      };
      break;
    }

    case "vs": {
      // Vs: guarantee vs % of net, whichever greater. Both on net.
      // Recommend guarantee at p25 net (defensible floor) and % at 85 (industry norm).
      const projectedNetP25 = Math.max(
        0,
        projectedGross.p25 - projectedGross.p25 * FEE_RATE - expenseCap.value,
      );
      percentageBasis = "net";
      guarantee = {
        value: roundTo50(projectedNetP25 * 0.5),
        band: { min: 0, max: roundTo50(projectedNetP25) },
        provenance: {
          summary: `Guarantee anchored to 50% of projected net at p25 gross — keeps venue above breakeven even on a soft show.`,
          source: { kind: "computed", from: "net_p25 × 50%" },
          confidence: overallConfidence,
        },
      };
      artistPercentage = {
        value: proposedArtistPercentage ?? DEFAULT_VS_PCT,
        band: { min: 0.75, max: 0.9 },
        provenance: {
          summary: "Industry-typical 85/15 net split on the upside leg of the vs.",
          source: { kind: "policy", rule: "Vs deal upside leg: 85/15 of net." },
          confidence: overallConfidence,
        },
      };
      break;
    }
  }

  // ---- Walkout pot (BR-05): only on flat / vs / pct_of_net deals.
  // Threshold = breakeven net + safety margin. 100%-walkout requires high projected gross + capacity fill (BR-05c).
  if (dealType === "flat" || dealType === "vs" || dealType === "percentage_of_net") {
    const breakevenNet = 0; // by definition with net-first math
    const walkoutThreshold = Math.max(breakevenNet, projectedNetP50 * 1.2);
    const projectedAttendanceP50 = projectedGross.p50 / 40; // implied
    const attendancePct = projectedAttendanceP50 / venueCapacity;
    const eligibleFor100Walkout =
      attendancePct >= WALKOUT_100_MIN_ATTENDANCE_PCT &&
      projectedGross.p50 >= WALKOUT_100_MIN_GROSS;

    walkout = {
      value: {
        netThreshold: roundTo50(walkoutThreshold),
        allowed: eligibleFor100Walkout,
      },
      provenance: {
        summary: eligibleFor100Walkout
          ? `100% walkout pot is permitted: projected p50 gross ${money(projectedGross.p50)} ≥ ${money(WALKOUT_100_MIN_GROSS)} and projected attendance ${(attendancePct * 100).toFixed(0)}% ≥ ${WALKOUT_100_MIN_ATTENDANCE_PCT * 100}% of capacity.`
          : `100% walkout pot NOT permitted: requires projected gross ≥ ${money(WALKOUT_100_MIN_GROSS)} AND attendance ≥ 90% of capacity. Current projection: ${money(projectedGross.p50)}, ${(attendancePct * 100).toFixed(0)}% fill.`,
        source: { kind: "policy", rule: "BR-05c: 100% walkout requires high projected gross + attendance." },
        confidence: overallConfidence,
      },
      hardBlocked: eligibleFor100Walkout
        ? undefined
        : [
            {
              reason:
                "100%-walkout requires projected p50 gross ≥ $20,000 AND projected attendance ≥ 90% capacity (BR-05c). GM approval required to enable.",
            },
          ],
    };
  }

  // ---- Breakeven (computed for the final shape with current recommendations)
  const finalTerms: DealTerms = {
    dealType,
    guarantee: guarantee?.value ?? null,
    artistPercentage: artistPercentage?.value ?? null,
    percentageBasis,
    expenseCap: expenseCap.value,
    hospitalityCap: hospitalityCap.value,
    bonuses: [],
    walkout: walkout
      ? { netThreshold: walkout.value.netThreshold }
      : null,
  };

  const breakevenGross = computeBreakevenGross({
    terms: finalTerms,
    feeRate: FEE_RATE,
    projectedExpenses,
  });

  return {
    dealType,
    guarantee,
    artistPercentage,
    percentageBasis,
    expenseCap,
    hospitalityCap,
    walkout,
    projectedGross,
    projectedExpenses,
    breakeven: { gross: breakevenGross, net: 0 },
    overallConfidence,
    basedOnPriorShows: artistHistory.priorShows.length,
  };
}

// ---- helpers

function mean(vals: number[]): number {
  if (vals.length === 0) return 0;
  return vals.reduce((s, v) => s + v, 0) / vals.length;
}

function roundTo50(n: number): number {
  return Math.round(n / 50) * 50;
}

function roundPctTo1(n: number): number {
  return Math.round(n * 100) / 100;
}

function money(n: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(n);
}

function friendlyDealType(t: Deal["dealType"]): string {
  return {
    flat: "flat",
    percentage_of_gross: "% of gross",
    percentage_of_net: "% of net",
    vs: "vs",
    door: "door",
  }[t];
}
