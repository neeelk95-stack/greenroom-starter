/**
 * The agent's tools. Everything here is read-only or deterministic.
 *
 * Note what is NOT here: nothing approves a settlement, releases a payout or
 * sends an email. The agent can't do those things however it's prompted,
 * because the capability doesn't exist on its side.
 */

import { getShowById, type ShowWithRelations } from "@/lib/queries";
import {
  settle,
  settleWithDecisions,
  DEFAULT_READINGS,
  type FullSettlement,
  type Readings,
  type SettlementInput,
} from "@/lib/settlementEngine";

export const AGENT_TOOLS = [
  "get_show",
  "compute_settlement",
  "price_two_readings",
  "run_checks",
  "save_terms_proposal",
  "save_draft_message",
] as const;

/** Capabilities deliberately withheld from the agent. Tested in scripts/test-agent.ts. */
export const WITHHELD_FROM_AGENT = ["approve_settlement", "release_payout", "send_email"] as const;

export type ShowContext = {
  data: ShowWithRelations;
  input: SettlementInput;
};

export async function getShow(showId: string): Promise<ShowContext | null> {
  const data = await getShowById(showId);
  if (!data || !data.deal) return null;
  const { deal } = data;
  const input: SettlementInput = {
    deal: {
      dealType: deal.dealType,
      guaranteeAmount: deal.guaranteeAmount,
      percentage: deal.percentage,
      percentageBasis: deal.percentageBasis,
      expenseCap: deal.expenseCap,
      hospitalityCap: deal.hospitalityCap,
      bonusesJson: deal.bonusesJson,
      dealNotesFreetext: deal.dealNotesFreetext,
    },
    ticketSales: data.ticketSales.map((t) => ({ id: t.id, qty: t.qty, gross: t.gross, fees: t.fees })),
    expenses: data.expenses.map((e) => ({
      id: e.id,
      category: e.category,
      amount: e.amount,
      description: e.description,
      approved: e.approved,
      absorbedByVenue: e.absorbedByVenue,
    })),
    comps: data.comps.map((c) => ({
      id: c.id,
      category: c.category,
      count: c.count,
      faceValue: c.faceValue,
      countsTowardGross: c.countsTowardGross,
      notes: c.notes,
    })),
    recoups: data.recoups,
    venueCapacity: data.venue?.capacity ?? null,
  };
  return { data, input };
}

export function computeSettlement(input: SettlementInput, readings: Partial<Readings> = {}): FullSettlement {
  return settleWithDecisions(input, readings);
}

const OPTIONS: Partial<Record<keyof Readings, { value: string; label: string }[]>> = {
  recoupPlacement: [
    { value: "outside_cap", label: "On top of the cap" },
    { value: "inside_cap", label: "Inside the cap" },
  ],
  doorFees: [
    { value: "off_top", label: "After ticketing fees" },
    { value: "not_deducted", label: "Before ticketing fees" },
  ],
  ratchet: [
    { value: "whole_net", label: "Higher % on all of net" },
    { value: "above_tier", label: "Higher % only above the tier" },
  ],
  walkout: [
    { value: "fixed_amount", label: "Fixed amount on the record" },
    { value: "full_overage", label: "100% of the overage" },
  ],
};

export type PricedReading = {
  options: { value: string; label: string; totalToArtist: number }[];
  impact: number;
};

export type FlagPrice = {
  engineKey: keyof Readings;
  /** At this show's actual numbers. */
  actual: PricedReading;
  /** If receipts had reached the expense cap (what booking-time risk looks like). */
  atCap?: PricedReading;
};

function price(input: SettlementInput, key: keyof Readings): PricedReading {
  const opts = OPTIONS[key] ?? [];
  const options = opts.map((o) => ({
    ...o,
    totalToArtist: settle(input, { ...DEFAULT_READINGS, disputedRecoups: "deduct", [key]: o.value } as Readings).totalToArtist,
  }));
  const totals = options.map((o) => o.totalToArtist);
  return { options, impact: totals.length ? Math.round((Math.max(...totals) - Math.min(...totals)) * 100) / 100 : 0 };
}

/**
 * What each reading pays, computed by the engine. Recoups are priced as agreed
 * (the booking-time view). For recoup flags we also price the case where
 * receipts reach the cap, because at booking nobody knows the receipts yet.
 */
export function priceTwoReadings(
  input: SettlementInput,
  key: keyof Readings,
  extractedRecoups: { label: string; amount: number | null }[] = [],
): FlagPrice | null {
  if (!OPTIONS[key]) return null;
  let base: SettlementInput = { ...input, recoups: input.recoups.map((r) => (r.status === "disputed" ? { ...r, status: "agreed" as const } : r)) };
  if (key === "recoupPlacement" && !base.recoups.some((r) => r.status !== "withdrawn" && r.category !== "prior_advance")) {
    const fromEmail = extractedRecoups.filter((r) => r.amount != null && r.amount > 0);
    if (fromEmail.length) {
      base = {
        ...base,
        recoups: fromEmail.map((r, i) => ({ id: `email_recoup_${i}`, category: "other" as const, label: r.label || "Recoup from the email", amount: r.amount!, status: "agreed" as const })),
      };
    }
  }
  const actual = price(base, key);
  let atCap: PricedReading | undefined;
  if (key === "recoupPlacement" && base.deal.expenseCap != null) {
    const passThrough = base.expenses.filter((e) => e.approved && !e.absorbedByVenue).reduce((s, e) => s + e.amount, 0);
    const topUp = base.deal.expenseCap - passThrough;
    const stressed: SettlementInput = topUp > 0
      ? { ...base, expenses: [...base.expenses, { id: "what_if_receipts_at_cap", category: "production", amount: topUp, description: "What if receipts reach the cap", approved: true, absorbedByVenue: false }] }
      : base;
    atCap = price(stressed, key);
  }
  return { engineKey: key, actual, atCap };
}
