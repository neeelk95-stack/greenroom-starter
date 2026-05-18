/**
 * Canonical net-first settlement math (BR-01).
 *
 * Used by both the Deal Builder (for projected earnings as Mariana edits)
 * and the agent-facing preview (for the breakeven explanation on the deal
 * sheet). Single source of truth; never re-implement these formulas elsewhere.
 *
 * Formula:
 *   net          = gross - fees - min(actual_expenses, expense_cap)
 *   artist_pay   = computed by deal-type rule, ON NET
 *   venue_earn   = net - artist_pay + bonuses_overflow_to_artist
 *
 * Every deal type runs through the same kernel. Door deals back-solve to
 * venue=0 (BR-04). Walkouts and bonuses trigger only after net is positive
 * (BR-05).
 */

import type { Deal, Bonus } from "@/db/schema";

export type DealTerms = {
  dealType: Deal["dealType"];
  guarantee: number | null;
  // For pct_of_net / vs / pct_of_gross: the artist's share (0–1).
  // For door: defaults to 1.0 (100% of net to artist) per BR-04.
  artistPercentage: number | null;
  // The basis the percentage applies against. Door & pct_of_net & vs use net.
  // pct_of_gross uses gross.
  percentageBasis: "net" | "gross";
  expenseCap: number;
  hospitalityCap: number | null;
  // Bonuses, with the constraint that triggers are now net-based (BR-05d).
  bonuses: BonusV2[];
  // Walkout pot: artist gets 100% of net above this threshold.
  // Threshold is on NET (BR-05a), and must be >= breakeven (BR-05b).
  walkout: { netThreshold: number } | null;
};

export type BonusV2 =
  | {
      type: "net_threshold";
      label: string;
      // Threshold is on net, not gross (BR-05d rewrite).
      netThreshold: number;
      amount: number;
    }
  | {
      type: "attendance_threshold";
      label: string;
      threshold: number; // ticket count
      amount: number;
    }
  | {
      type: "sellout";
      label: string;
      amount: number;
    }
  | {
      type: "tier_ratchet";
      label: string;
      // Tiers are on NET — first tier `from` >= breakeven net.
      tiers: { fromNet: number; toNet: number | null; percentage: number }[];
    };

export type ProjectedScenario = {
  label: "p25" | "p50" | "p75";
  gross: number;
  fees: number;
  expenses: number;
  net: number;
  artistPay: number;
  bonusesPaid: { label: string; amount: number; reason: string }[];
  walkoutPaid: number;
  venueEarnings: number;
};

export type DealMathInput = {
  terms: DealTerms;
  projectedGross: { p25: number; p50: number; p75: number };
  // Average fee rate observed historically. Default 10%.
  feeRate?: number;
  // Projected actual expenses. Used to compute `effectiveExpenses = min(this, cap)`.
  projectedExpenses: number;
  venueCapacity: number;
};

const DEFAULT_FEE_RATE = 0.1;

export function computeProjection(input: DealMathInput): ProjectedScenario[] {
  const { terms, projectedGross, projectedExpenses, venueCapacity } = input;
  const feeRate = input.feeRate ?? DEFAULT_FEE_RATE;

  const scenarios: { label: ProjectedScenario["label"]; gross: number }[] = [
    { label: "p25", gross: projectedGross.p25 },
    { label: "p50", gross: projectedGross.p50 },
    { label: "p75", gross: projectedGross.p75 },
  ];

  return scenarios.map(({ label, gross }) => {
    const fees = gross * feeRate;
    const effectiveExpenses = Math.min(projectedExpenses, terms.expenseCap);
    const net = gross - fees - effectiveExpenses;

    const result = computeArtistPay({
      terms,
      gross,
      net,
      capacity: venueCapacity,
      // Attendance approximation: gross / avg-ticket-price-implied. For projection
      // we estimate attendance from gross at the venue's typical average ticket.
      // Mariana never sees this value directly; it only gates sellout bonuses.
      attendance: estimateAttendance(gross, venueCapacity),
    });

    return {
      label,
      gross,
      fees,
      expenses: effectiveExpenses,
      net,
      artistPay: result.artistPay,
      bonusesPaid: result.bonusesPaid,
      walkoutPaid: result.walkoutPaid,
      venueEarnings: net - result.artistPay - result.walkoutPaid,
    };
  });
}

/**
 * Heuristic attendance estimate from gross — used only for sellout bonus
 * evaluation in projections. Assumes ~$40 avg ticket (matches the seed data's
 * implied avg). Caller can supply explicit attendance for actuals.
 */
function estimateAttendance(gross: number, capacity: number): number {
  const avgTicket = 40;
  return Math.min(capacity, Math.round(gross / avgTicket));
}

function computeArtistPay(args: {
  terms: DealTerms;
  gross: number;
  net: number;
  capacity: number;
  attendance: number;
}): {
  artistPay: number;
  bonusesPaid: { label: string; amount: number; reason: string }[];
  walkoutPaid: number;
} {
  const { terms, gross, net, capacity, attendance } = args;

  let basePay = 0;

  switch (terms.dealType) {
    case "flat":
      basePay = terms.guarantee ?? 0;
      break;
    case "door":
      // BR-04: door deals on NET, 100% to artist after venue recovers expenses.
      basePay = Math.max(0, net) * (terms.artistPercentage ?? 1.0);
      break;
    case "percentage_of_net":
      basePay = Math.max(0, net) * (terms.artistPercentage ?? 0);
      break;
    case "percentage_of_gross":
      basePay = gross * (terms.artistPercentage ?? 0);
      break;
    case "vs": {
      // Vs: max(guarantee, % of net). Both anchored to net.
      const guarantee = terms.guarantee ?? 0;
      const pctNet = Math.max(0, net) * (terms.artistPercentage ?? 0);
      basePay = Math.max(guarantee, pctNet);
      break;
    }
  }

  // Bonuses: trigger only after net >= 0 (BR-05d).
  // Walkouts: trigger only above the net threshold (BR-05a-b).
  const bonusesPaid: { label: string; amount: number; reason: string }[] = [];
  let bonusTotal = 0;

  if (net > 0) {
    for (const b of terms.bonuses) {
      if (b.type === "net_threshold" && net >= b.netThreshold) {
        bonusesPaid.push({
          label: b.label,
          amount: b.amount,
          reason: `Net ${money(net)} ≥ ${money(b.netThreshold)}`,
        });
        bonusTotal += b.amount;
      } else if (
        b.type === "attendance_threshold" &&
        attendance >= b.threshold
      ) {
        bonusesPaid.push({
          label: b.label,
          amount: b.amount,
          reason: `Attendance ${attendance} ≥ ${b.threshold}`,
        });
        bonusTotal += b.amount;
      } else if (b.type === "sellout" && attendance >= capacity * 0.95) {
        bonusesPaid.push({
          label: b.label,
          amount: b.amount,
          reason: `${attendance} of ${capacity} (sellout)`,
        });
        bonusTotal += b.amount;
      } else if (b.type === "tier_ratchet") {
        // Tier ratchets re-do the artist pay on net using tiered %.
        // We apply on top of basePay's net portion: ratchet replaces a flat %.
        let ratchetPay = 0;
        for (const tier of b.tiers) {
          if (net <= tier.fromNet) continue;
          const tierTop = tier.toNet ?? net;
          const portion = Math.max(0, Math.min(net, tierTop) - tier.fromNet);
          ratchetPay += portion * tier.percentage;
        }
        if (ratchetPay > 0) {
          bonusesPaid.push({
            label: b.label,
            amount: ratchetPay,
            reason: `Net ${money(net)} ratcheted across ${b.tiers.length} tiers`,
          });
          bonusTotal += ratchetPay;
        }
      }
    }
  }

  // Walkout pot: 100% of net above threshold goes to artist.
  let walkoutPaid = 0;
  if (terms.walkout && net > terms.walkout.netThreshold) {
    walkoutPaid = net - terms.walkout.netThreshold;
  }

  return {
    artistPay: basePay + bonusTotal,
    bonusesPaid,
    walkoutPaid,
  };
}

/**
 * Breakeven gross for a given set of terms: the gross at which venue earnings
 * land at zero. Surfaced on the agent-facing deal sheet (FR-A-02).
 *
 * Closed-form for flat/door/pct_of_net. For pct_of_gross we solve algebraically.
 * For vs we use the guarantee branch (pessimistic — the floor case).
 */
export function computeBreakevenGross(args: {
  terms: DealTerms;
  feeRate?: number;
  projectedExpenses: number;
}): number {
  const { terms, projectedExpenses } = args;
  const feeRate = args.feeRate ?? DEFAULT_FEE_RATE;
  const effectiveExpenses = Math.min(projectedExpenses, terms.expenseCap);

  switch (terms.dealType) {
    case "flat":
      // venue = (gross - fees - exp) - guarantee >= 0
      // gross = (guarantee + exp) / (1 - feeRate)
      return ((terms.guarantee ?? 0) + effectiveExpenses) / (1 - feeRate);
    case "door":
      // Door net-basis at 100% means venue earnings = 0 at breakeven by definition.
      // The "breakeven gross" is the gross at which net = 0.
      // gross - fees - exp = 0  →  gross = exp / (1 - feeRate)
      return effectiveExpenses / (1 - feeRate);
    case "percentage_of_net": {
      // venue = net - artist_pct * net = net * (1 - pct) >= 0
      // net >= 0 → gross = exp / (1 - feeRate)
      return effectiveExpenses / (1 - feeRate);
    }
    case "percentage_of_gross": {
      // venue = gross(1 - feeRate) - exp - pct*gross >= 0
      // gross * (1 - feeRate - pct) >= exp
      // gross >= exp / (1 - feeRate - pct)
      const denom = 1 - feeRate - (terms.artistPercentage ?? 0);
      if (denom <= 0) return Infinity; // unprofitable at any gross
      return effectiveExpenses / denom;
    }
    case "vs": {
      // Use guarantee branch (floor): same as flat.
      return ((terms.guarantee ?? 0) + effectiveExpenses) / (1 - feeRate);
    }
  }
}

function money(n: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(n);
}
