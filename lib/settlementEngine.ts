/**
 * Settlement engine — settles every deal type as written, and shows its work.
 *
 * The old engine (`lib/dealMath.ts`) handled flat and %-of-gross deals only.
 * Everything else (vs deals, % of net, door deals, ratchets, walkouts,
 * comps that count toward gross, recoups) fell back to a spreadsheet.
 *
 * Design rules:
 *
 *  1. Deterministic. Same inputs + same readings → same number, every time.
 *     Both sides of the table have to be able to reproduce the math.
 *  2. Every line traces to its source rows (ticket reports, receipts, comps,
 *     recoups, deal fields). No unexplained totals.
 *  3. Where the deal can honestly be read two ways, the engine does NOT pick
 *     silently. It returns a `Decision` with both readings and what each pays,
 *     so the booker and tour manager decide in the room and the choice is
 *     recorded.
 *  4. Pure TypeScript, no server imports — runs on the server, in the browser
 *     (live recompute as decisions change), and in the replay script.
 */

import type { Deal, TicketSale, Expense, Comp, Recoup, Bonus } from "@/db/schema";

// ---------------------------------------------------------------- types

export type SettlementInput = {
  deal: Pick<
    Deal,
    | "dealType"
    | "guaranteeAmount"
    | "percentage"
    | "percentageBasis"
    | "expenseCap"
    | "hospitalityCap"
    | "bonusesJson"
    | "dealNotesFreetext"
  >;
  ticketSales: Pick<TicketSale, "id" | "qty" | "gross" | "fees">[];
  expenses: Pick<
    Expense,
    "id" | "category" | "amount" | "description" | "approved" | "absorbedByVenue"
  >[];
  comps: Pick<Comp, "id" | "category" | "count" | "faceValue" | "countsTowardGross" | "notes">[];
  recoups: Recoup[];
  venueCapacity: number | null;
};

/** How to read the parts of a deal that can honestly be read two ways. */
export type Readings = {
  /** A recoup that isn't already a receipt: inside the expense cap, or on top of it? */
  recoupPlacement: "outside_cap" | "inside_cap";
  /** A recoup the artist team is contesting: deduct tonight, or hold it open? */
  disputedRecoups: "hold" | "deduct";
  /** Door deal: do ticketing fees come off before the artist's share? */
  doorFees: "off_top" | "not_deducted";
  /** Ratchet: does the higher % apply to all of net, or only tickets above the tier? */
  ratchet: "whole_net" | "above_tier";
  /** "100% of gross above $X": the fixed amount in the deal record, or the full overage? */
  walkout: "fixed_amount" | "full_overage";
  /** Notes and structured field disagree on the artist %: which is the deal? */
  percentageSource: "field" | "notes";
};

export const DEFAULT_READINGS: Readings = {
  recoupPlacement: "outside_cap",
  disputedRecoups: "hold",
  doorFees: "off_top",
  ratchet: "whole_net",
  walkout: "fixed_amount",
  percentageSource: "field",
};

/**
 * Switches for "settle as written" vs how a venue has historically settled in
 * its spreadsheet. Defaults are all `true` (as written). The replay script
 * turns them off one at a time to explain why past settlements differ.
 */
export type Practice = {
  countCompsTowardGross: boolean;
  chargeRecoups: boolean;
  vsGrossWithoutExpenses: boolean;
  payStackingBonuses: boolean;
  applyRatchets: boolean;
  payOtherBonuses: boolean;
  doorFeesOffTop: boolean;
};

export const AS_WRITTEN: Practice = {
  countCompsTowardGross: true,
  chargeRecoups: true,
  vsGrossWithoutExpenses: true,
  payStackingBonuses: true,
  applyRatchets: true,
  payOtherBonuses: true,
  doorFeesOffTop: true,
};

export type SourceRef = {
  kind: "ticket_sales" | "expense" | "comp" | "recoup" | "deal" | "notes";
  id?: string;
  label: string;
  amount?: number;
};

export type Line = {
  key: string;
  group: "revenue" | "costs" | "split" | "bonus" | "adjustment" | "total";
  label: string;
  /** Signed contribution, or the subtotal value for kind = subtotal/total. */
  amount: number;
  kind: "add" | "subtract" | "subtotal" | "info" | "total";
  detail?: string;
  sources: SourceRef[];
};

export type DecisionOption = {
  value: string;
  label: string;
  description: string;
  totalToArtist: number;
};

export type Decision = {
  key: keyof Readings;
  title: string;
  question: string;
  options: DecisionOption[];
  chosen: string;
  /** Largest difference between options, in dollars to the artist. */
  impact: number;
  sourceText?: string;
};

export type Check = {
  level: "warning" | "info";
  title: string;
  detail: string;
  sources: SourceRef[];
};

export type SettlementResult = {
  dealType: Deal["dealType"];
  dealSummary: string;
  tickets: number;
  ticketGross: number;
  gross: number;
  fees: number;
  netBoxOffice: number;
  passThroughExpenses: number;
  expensesCharged: number;
  venueAbsorbedOverCap: number;
  absorbedByVenue: number;
  recoupsCharged: number;
  recoupsHeld: number;
  dealNet: number | null;
  basePay: number;
  bonusesPaid: number;
  adjustments: number;
  totalToArtist: number;
  venueResult: number;
  lines: Line[];
  bonuses: { label: string; amount: number; paid: boolean; reason: string; includedInSplit?: boolean }[];
  feesCharged: number;
  summary: string;
};

export type FullSettlement = SettlementResult & {
  decisions: Decision[];
  checks: Check[];
  readings: Readings;
};

// ---------------------------------------------------------------- helpers

const round2 = (n: number) => Math.round(n * 100) / 100;

export function money(n: number): string {
  const v = Math.round(n);
  return (v < 0 ? "−$" : "$") + Math.abs(v).toLocaleString("en-US");
}

const pctLabel = (p: number) => `${Math.round(p * 1000) / 10}%`;

function parseBonuses(json: string | null): Bonus[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

const WALKOUT_RE = /100%\s+of\s+gross\s+above/i;

/** Which receipt categories a recoup can be "already covered" by. */
const RECOUP_COVERED_BY: Record<Recoup["category"], Expense["category"][]> = {
  marketing: ["marketing"],
  hospitality_overage: ["hospitality"],
  production_overage: ["production", "sound", "lights", "backline"],
  prior_advance: [],
  damages: [],
  other: [],
};

/** % values mentioned in the deal notes that look like the artist's share. */
function notesPercentages(notes: string | null): number[] {
  if (!notes) return [];
  const out: number[] = [];
  for (const m of notes.matchAll(/(\d{2,3})\s*(?:%|\/\d{1,2})/g)) {
    const v = parseInt(m[1], 10);
    if (v >= 40 && v <= 100) out.push(v / 100);
  }
  return out;
}

/** If the notes name exactly one artist % and it isn't the field's %, return it. */
export function notesPercentageConflict(
  deal: SettlementInput["deal"],
  bonuses: Bonus[],
): number | null {
  if (deal.percentage == null) return null;
  const mentioned = notesPercentages(deal.dealNotesFreetext);
  if (mentioned.length === 0) return null;
  const close = (a: number, b: number) => Math.abs(a - b) < 0.005;
  if (mentioned.some((p) => close(p, deal.percentage!))) return null;
  // Ratchet tiers legitimately mention other %s.
  const tierPcts = bonuses.flatMap((b) =>
    b.type === "tier_ratchet" ? b.tiers.map((t) => t.percentage) : [],
  );
  const candidates = mentioned.filter(
    (p) => !tierPcts.some((t) => close(t, p)) && !close(p, 1 - deal.percentage!),
  );
  const unique = Array.from(new Set(candidates.map((p) => Math.round(p * 100))));
  return unique.length === 1 ? unique[0] / 100 : null;
}

function describeDeal(deal: SettlementInput["deal"], pct: number | null): string {
  const g = deal.guaranteeAmount;
  const cap = deal.expenseCap != null ? `, expenses capped at ${money(deal.expenseCap)}` : "";
  switch (deal.dealType) {
    case "flat":
      return `Flat guarantee of ${money(g ?? 0)}`;
    case "percentage_of_gross":
      return `${pctLabel(pct ?? 0)} of gross`;
    case "percentage_of_net":
      return `${pctLabel(pct ?? 0)} of net${cap}`;
    case "vs":
      return deal.percentageBasis === "gross"
        ? `${money(g ?? 0)} guarantee vs ${pctLabel(pct ?? 0)} of gross, whichever is greater`
        : `${money(g ?? 0)} guarantee vs ${pctLabel(pct ?? 0)} of net, whichever is greater${cap}`;
    case "door":
      return `Door deal: ${pct != null ? pctLabel(pct) : "100%"} of the door after expenses${cap}`;
  }
}

// ---------------------------------------------------------------- core

/** Settle one show under one fixed set of readings. Pure and deterministic. */
export function settle(
  input: SettlementInput,
  readings: Readings = DEFAULT_READINGS,
  practice: Practice = AS_WRITTEN,
): SettlementResult {
  const { deal, ticketSales, expenses, comps, recoups, venueCapacity } = input;
  const bonuses = parseBonuses(deal.bonusesJson);
  const lines: Line[] = [];

  // ---- which % is the deal?
  const notesPct = notesPercentageConflict(deal, bonuses);
  const pct =
    readings.percentageSource === "notes" && notesPct != null ? notesPct : deal.percentage;

  // ---- revenue
  const tickets = ticketSales.reduce((s, t) => s + (t.qty ?? 0), 0);
  const ticketGross = round2(ticketSales.reduce((s, t) => s + t.gross, 0));
  const fees = round2(ticketSales.reduce((s, t) => s + t.fees, 0));
  const countingComps = practice.countCompsTowardGross
    ? comps.filter((c) => c.countsTowardGross)
    : [];
  const compsGross = round2(countingComps.reduce((s, c) => s + c.count * c.faceValue, 0));
  const gross = round2(ticketGross + compsGross);

  lines.push({
    key: "tickets",
    group: "revenue",
    label: `Ticket sales (${tickets.toLocaleString()} tickets)`,
    amount: ticketGross,
    kind: "add",
    sources: ticketSales.map((t) => ({
      kind: "ticket_sales",
      id: t.id,
      label: `Ticket report: ${t.qty} tickets`,
      amount: t.gross,
    })),
  });
  if (compsGross > 0) {
    lines.push({
      key: "comps",
      group: "revenue",
      label: "Comps that count toward gross",
      amount: compsGross,
      kind: "add",
      detail: "These comps are flagged as counting toward the artist's gross.",
      sources: countingComps.map((c) => ({
        kind: "comp",
        id: c.id,
        label: `${c.count} × ${c.category.replace("_", " ")} comps at ${money(c.faceValue)}`,
        amount: c.count * c.faceValue,
      })),
    });
  }
  lines.push({ key: "gross", group: "revenue", label: "Gross", amount: gross, kind: "subtotal", sources: [] });

  // ---- expenses
  const passThrough = expenses.filter((e) => e.approved && !e.absorbedByVenue);
  const absorbed = expenses.filter((e) => e.absorbedByVenue);
  const unapproved = expenses.filter((e) => !e.approved && !e.absorbedByVenue);
  const passThroughTotal = round2(passThrough.reduce((s, e) => s + e.amount, 0));
  const absorbedTotal = round2(absorbed.reduce((s, e) => s + e.amount, 0));
  const cap = deal.expenseCap ?? Infinity;

  // ---- recoups: which are charged, which are already receipts, which are held
  const remainingByCategory = new Map<string, number>();
  for (const e of passThrough) {
    remainingByCategory.set(e.category, (remainingByCategory.get(e.category) ?? 0) + e.amount);
  }
  const expensesChargedToArtist = ["percentage_of_net", "vs", "door"].includes(deal.dealType) &&
    !(deal.dealType === "vs" && deal.percentageBasis === "gross" && practice.vsGrossWithoutExpenses);

  let recoupExtra = 0; // charged on top of receipts (not already an expense row)
  let advance = 0;
  let held = 0;
  const recoupSources: SourceRef[] = [];
  const coveredNotes: string[] = [];
  const heldSources: SourceRef[] = [];
  if (practice.chargeRecoups) {
    for (const r of recoups) {
      if (r.status === "withdrawn") continue;
      if (r.status === "disputed" && readings.disputedRecoups === "hold") {
        held += r.amount;
        heldSources.push({ kind: "recoup", id: r.id, label: `${r.label} (disputed)`, amount: r.amount });
        continue;
      }
      if (r.category === "prior_advance") {
        advance += r.amount;
        continue;
      }
      let uncovered = r.amount;
      if (expensesChargedToArtist) {
        for (const cat of RECOUP_COVERED_BY[r.category]) {
          const avail = remainingByCategory.get(cat) ?? 0;
          const take = Math.min(avail, uncovered);
          if (take > 0) {
            remainingByCategory.set(cat, avail - take);
            uncovered -= take;
          }
        }
        if (uncovered < r.amount) {
          coveredNotes.push(
            `${r.label}: ${money(r.amount - uncovered)} is already in the receipts, so it isn't charged twice.`,
          );
        }
      }
      if (uncovered > 0) {
        recoupExtra += uncovered;
        recoupSources.push({ kind: "recoup", id: r.id, label: r.label, amount: uncovered });
      }
    }
  }
  recoupExtra = round2(recoupExtra);

  // ---- deal math
  let dealNet: number | null = null;
  let expensesCharged = 0;
  let overCap = 0;
  let basePay = 0;
  let pctSide = 0;
  const bonusRows: SettlementResult["bonuses"] = [];
  let bonusTotal = 0;
  let adjustments = 0;
  let feesChargedOut = 0;
  let ratchetPct: number | null = null;

  const netBoxOffice = round2(gross - fees);

  if (expensesChargedToArtist) {
    // Fees
    const feesCharged = deal.dealType === "door" && !(practice.doorFeesOffTop && readings.doorFees === "off_top") ? 0 : fees;
    feesChargedOut = feesCharged;
    lines.push({
      key: "fees",
      group: "revenue",
      label: "Ticketing fees",
      amount: -feesCharged,
      kind: feesCharged ? "subtract" : "info",
      detail: feesCharged ? undefined : `Door deal read as "ticket revenue" before fees — fees of ${money(fees)} not deducted.`,
      sources: ticketSales.map((t) => ({ kind: "ticket_sales", id: t.id, label: "Fees on ticket report", amount: t.fees })),
    });

    lines.push({
      key: "receipts",
      group: "costs",
      label: `Show expenses (${passThrough.length} receipts)`,
      amount: -passThroughTotal,
      kind: "subtract",
      sources: passThrough.map((e) => ({
        kind: "expense",
        id: e.id,
        label: `${e.category}${e.description ? ` — ${e.description}` : ""}`,
        amount: e.amount,
      })),
    });
    if (recoupExtra > 0) {
      lines.push({
        key: "recoups",
        group: "costs",
        label: "Recoups not already in receipts",
        amount: -recoupExtra,
        kind: "subtract",
        detail:
          readings.recoupPlacement === "inside_cap"
            ? "Read as inside the expense cap."
            : "Read as on top of the expense cap.",
        sources: recoupSources,
      });
    }

    const capBase = readings.recoupPlacement === "inside_cap" ? passThroughTotal + recoupExtra : passThroughTotal;
    const capped = Math.min(capBase, cap);
    overCap = round2(capBase - capped);
    expensesCharged = round2(capped + (readings.recoupPlacement === "inside_cap" ? 0 : recoupExtra));
    if (overCap > 0) {
      lines.push({
        key: "over_cap",
        group: "costs",
        label: `Over the ${money(cap)} expense cap — venue covers`,
        amount: overCap,
        kind: "add",
        detail: "Expenses above the cap aren't charged to the artist. Recorded as absorbed by the venue.",
        sources: [{ kind: "deal", label: `Expense cap on the deal record: ${money(cap)}` }],
      });
    }
    dealNet = round2(gross - feesCharged - expensesCharged);
    lines.push({ key: "net", group: "costs", label: "Net", amount: dealNet, kind: "subtotal", sources: [] });

    const p = deal.dealType === "door" ? pct ?? 1 : pct ?? 0;
    pctSide = Math.max(0, dealNet) * p;

    // Ratchet (vs / % of net): tiers are by sell-through.
    const ratchet = bonuses.find((b): b is Extract<Bonus, { type: "tier_ratchet" }> => b.type === "tier_ratchet");
    if (ratchet && practice.applyRatchets && venueCapacity) {
      const sold = tickets / venueCapacity;
      const reached = [...ratchet.tiers].reverse().find((t) => sold >= t.from && t.from > 0);
      if (reached && reached.percentage > p) {
        const ticketsAbove = Math.max(0, tickets - reached.from * venueCapacity);
        const share = tickets > 0 ? ticketsAbove / tickets : 0;
        const ratcheted =
          readings.ratchet === "whole_net"
            ? Math.max(0, dealNet) * reached.percentage
            : Math.max(0, dealNet) * (p + (reached.percentage - p) * share);
        ratchetPct = reached.percentage;
        bonusRows.push({
          label: ratchet.label,
          amount: round2(ratcheted - pctSide),
          paid: true,
          includedInSplit: true,
          reason: `${Math.round(sold * 100)}% sold (${tickets} of ${venueCapacity}) — tier at ${Math.round(reached.from * 100)}% reached; ${readings.ratchet === "whole_net" ? `${pctLabel(reached.percentage)} applies to all of net` : `${pctLabel(reached.percentage)} applies only to tickets above the tier`}.`,
        });
        pctSide = ratcheted;
      } else if (reached == null) {
        bonusRows.push({
          label: ratchet.label,
          amount: 0,
          paid: false,
          includedInSplit: true,
          reason: `${Math.round((tickets / venueCapacity) * 100)}% sold — ratchet tier not reached.`,
        });
      }
    }

    const effPct =
      ratchetPct == null
        ? pctLabel(p)
        : readings.ratchet === "whole_net"
          ? `${pctLabel(ratchetPct)} (ratcheted)`
          : `${pctLabel(p)}–${pctLabel(ratchetPct)} (ratcheted)`;
    if (deal.dealType === "vs") {
      const g = deal.guaranteeAmount ?? 0;
      basePay = Math.max(g, pctSide);
      lines.push({
        key: "split",
        group: "split",
        label: pctSide >= g ? `${effPct} of net beats the ${money(g)} guarantee` : `${money(g)} guarantee beats ${effPct} of net (${money(pctSide)})`,
        amount: round2(basePay),
        kind: "subtotal",
        detail: `Guarantee ${money(g)} vs ${effPct} × ${money(Math.max(0, dealNet))} = ${money(pctSide)}. Artist gets the greater.`,
        sources: [{ kind: "deal", label: describeDeal(deal, p) }],
      });
    } else {
      basePay = pctSide;
      lines.push({
        key: "split",
        group: "split",
        label: `${effPct} of net`,
        amount: round2(basePay),
        kind: "subtotal",
        detail: `${effPct} × ${money(Math.max(0, dealNet))}${dealNet < 0 ? " (net is negative, so the share is $0)" : ""}.`,
        sources: [{ kind: "deal", label: describeDeal(deal, p) }],
      });
    }
  } else {
    // flat, % of gross, vs-gross as written: expenses aren't charged to the artist.
    if (deal.dealType === "flat") {
      basePay = deal.guaranteeAmount ?? 0;
      lines.push({
        key: "split",
        group: "split",
        label: "Flat guarantee",
        amount: basePay,
        kind: "subtotal",
        detail: "Expenses aren't charged to the artist on a flat deal.",
        sources: [{ kind: "deal", label: describeDeal(deal, pct) }],
      });
    } else {
      const offTop = recoupExtraForGrossDeals(recoups, readings, practice);
      const basis = round2(gross - offTop);
      if (offTop > 0) {
        lines.push({
          key: "recoups_gross",
          group: "costs",
          label: "Recoups off the top of gross",
          amount: -offTop,
          kind: "subtract",
          sources: recoups
            .filter((r) => r.category !== "prior_advance")
            .filter((r) => r.status === "agreed" || (r.status === "disputed" && readings.disputedRecoups === "deduct"))
            .map((r) => ({ kind: "recoup", id: r.id, label: r.label, amount: r.amount })),
        });
      }
      pctSide = basis * (pct ?? 0);
      if (deal.dealType === "vs") {
        const g = deal.guaranteeAmount ?? 0;
        basePay = Math.max(g, pctSide);
        lines.push({
          key: "split",
          group: "split",
          label: pctSide >= g ? `${pctLabel(pct ?? 0)} of gross beats the ${money(g)} guarantee` : `${money(g)} guarantee beats ${pctLabel(pct ?? 0)} of gross`,
          amount: round2(basePay),
          kind: "subtotal",
          detail: `Guarantee ${money(g)} vs ${pctLabel(pct ?? 0)} × ${money(basis)} = ${money(pctSide)}. No expense deductions on a gross deal.`,
          sources: [{ kind: "deal", label: describeDeal(deal, pct) }],
        });
      } else {
        basePay = pctSide;
        lines.push({
          key: "split",
          group: "split",
          label: `${pctLabel(pct ?? 0)} of gross`,
          amount: round2(basePay),
          kind: "subtotal",
          detail: `${pctLabel(pct ?? 0)} × ${money(basis)}. No expense deductions on a gross deal.`,
          sources: [{ kind: "deal", label: describeDeal(deal, pct) }],
        });
      }
    }
    // Recoups on deals that don't charge expenses come straight off the payout.
    const direct = recoupExtraForGrossDeals(recoups, readings, practice);
    if (direct > 0 && deal.dealType !== "vs" && deal.dealType !== "percentage_of_gross") {
      adjustments -= direct;
      lines.push({
        key: "recoups_direct",
        group: "adjustment",
        label: "Recoups",
        amount: -direct,
        kind: "subtract",
        sources: recoups
          .filter((r) => r.status === "agreed" || (r.status === "disputed" && readings.disputedRecoups === "deduct"))
          .filter((r) => r.category !== "prior_advance")
          .map((r) => ({ kind: "recoup", id: r.id, label: r.label, amount: r.amount })),
      });
    }
  }

  if (!expensesChargedToArtist && passThroughTotal > 0) {
    lines.push({
      key: "receipts_venue",
      group: "costs",
      label: `Show expenses (${passThrough.length} receipts) — venue's cost on this deal`,
      amount: 0,
      kind: "info",
      detail: `${money(passThroughTotal)} in receipts. This deal type doesn't charge expenses to the artist.`,
      sources: passThrough.map((e) => ({ kind: "expense", id: e.id, label: `${e.category}${e.description ? ` — ${e.description}` : ""}`, amount: e.amount })),
    });
  }

  // ---- bonuses (sellout / attendance / gross threshold / walkout)
  const g = deal.guaranteeAmount ?? 0;
  const pctWins = deal.dealType === "vs" ? pctSide >= g : true;
  for (const b of bonuses) {
    if (b.type === "tier_ratchet") continue;
    const isVsGrossBonus = deal.dealType === "vs" && b.type === "gross_threshold";
    // Past practice only ever paid gross-threshold bonuses on vs deals.
    if (!isVsGrossBonus && !practice.payOtherBonuses) {
      bonusRows.push({ label: b.label, amount: 0, paid: false, reason: "Not applied under past settlement practice." });
      continue;
    }
    let triggered = false;
    let reason = "";
    let amount = 0;
    if (b.type === "gross_threshold") {
      triggered = gross >= b.threshold;
      const isWalkout = WALKOUT_RE.test(b.label);
      amount =
        isWalkout && readings.walkout === "full_overage" ? Math.max(0, gross - b.threshold) : b.amount;
      reason = triggered
        ? `Gross ${money(gross)} ≥ ${money(b.threshold)}`
        : `Gross ${money(gross)} is below ${money(b.threshold)}`;
      if (triggered && deal.dealType === "vs") {
        const stacks = b.stacks === true && practice.payStackingBonuses;
        if (!stacks && !pctWins) {
          triggered = false;
          reason += b.stacks
            ? " — but past practice only paid this when the % beat the guarantee"
            : " — but this bonus doesn't stack on the guarantee, and the guarantee won";
        }
      }
    } else if (b.type === "sellout") {
      triggered = venueCapacity != null && tickets >= venueCapacity * 0.95;
      amount = b.amount;
      reason = venueCapacity != null ? `${tickets} of ${venueCapacity} sold (sellout = 95%+)` : "Capacity unknown";
    } else if (b.type === "attendance_threshold") {
      triggered = tickets >= b.threshold;
      amount = b.amount;
      reason = `${tickets} tickets vs threshold of ${b.threshold}`;
    }
    bonusRows.push({ label: b.label, amount, paid: triggered, reason });
    if (triggered) bonusTotal += amount;
  }
  for (const b of bonusRows) {
    lines.push({
      key: `bonus_${b.label}`,
      group: "bonus",
      label: b.label,
      amount: b.paid && !b.includedInSplit ? b.amount : 0,
      kind: b.paid && !b.includedInSplit ? "add" : "info",
      detail: b.paid ? (b.includedInSplit ? `${b.reason} Included in the split above.` : b.reason) : `Not triggered: ${b.reason}`,
      sources: [{ kind: "deal", label: `Bonus clause on the deal record: ${b.label}` }],
    });
  }

  if (advance > 0) {
    adjustments -= advance;
    lines.push({
      key: "advance",
      group: "adjustment",
      label: "Prior advance already paid",
      amount: -advance,
      kind: "subtract",
      sources: recoups.filter((r) => r.category === "prior_advance").map((r) => ({ kind: "recoup", id: r.id, label: r.label, amount: r.amount })),
    });
  }

  const totalToArtist = round2(Math.max(0, basePay + bonusTotal + adjustments));
  lines.push({ key: "total", group: "total", label: "Total to artist", amount: totalToArtist, kind: "total", sources: [] });

  if (held > 0) {
    lines.push({
      key: "held",
      group: "adjustment",
      label: "Disputed recoups held open (not deducted)",
      amount: 0,
      kind: "info",
      detail: `${money(held)} stays open as a separate item until both sides agree.`,
      sources: heldSources,
    });
  }
  if (absorbedTotal > 0) {
    lines.push({
      key: "absorbed",
      group: "costs",
      label: "Absorbed by the venue (not charged)",
      amount: 0,
      kind: "info",
      detail: `${money(absorbedTotal)} of receipts were marked as venue costs.`,
      sources: absorbed.map((e) => ({ kind: "expense", id: e.id, label: `${e.category}${e.description ? ` — ${e.description}` : ""}`, amount: e.amount })),
    });
  }
  if (unapproved.length) {
    lines.push({
      key: "unapproved",
      group: "costs",
      label: "Unapproved receipts (not charged)",
      amount: 0,
      kind: "info",
      sources: unapproved.map((e) => ({ kind: "expense", id: e.id, label: e.category, amount: e.amount })),
    });
  }
  for (const note of coveredNotes) {
    lines.push({ key: `covered_${note}`, group: "costs", label: "Recoup already in receipts", amount: 0, kind: "info", detail: note, sources: [] });
  }

  const allExpenses = passThroughTotal + absorbedTotal + unapproved.reduce((s, e) => s + e.amount, 0);
  const venueResult = round2(ticketGross - fees - allExpenses - totalToArtist);

  const result: SettlementResult = {
    dealType: deal.dealType,
    dealSummary: describeDeal(deal, pct),
    tickets,
    ticketGross,
    gross,
    fees,
    netBoxOffice,
    passThroughExpenses: passThroughTotal,
    expensesCharged,
    venueAbsorbedOverCap: overCap,
    absorbedByVenue: absorbedTotal,
    recoupsCharged: round2(recoupExtra + advance),
    recoupsHeld: round2(held),
    dealNet,
    basePay: round2(basePay),
    bonusesPaid: round2(bonusTotal),
    adjustments: round2(adjustments),
    totalToArtist,
    venueResult,
    lines,
    bonuses: bonusRows,
    feesCharged: feesChargedOut,
    summary: "",
  };
  result.summary = plainEnglish(result, deal);
  return result;
}

function recoupExtraForGrossDeals(recoups: Recoup[], readings: Readings, practice: Practice): number {
  if (!practice.chargeRecoups) return 0;
  return round2(
    recoups
      .filter((r) => r.category !== "prior_advance")
      .filter((r) => r.status === "agreed" || (r.status === "disputed" && readings.disputedRecoups === "deduct"))
      .reduce((s, r) => s + r.amount, 0),
  );
}

/** Deterministic plain-English summary for the tour manager. */
function plainEnglish(r: SettlementResult, deal: SettlementInput["deal"]): string {
  const parts: string[] = [];
  parts.push(
    `${r.tickets.toLocaleString()} tickets brought in ${money(r.ticketGross)}${r.gross !== r.ticketGross ? `, plus ${money(r.gross - r.ticketGross)} in comps that count toward gross` : ""}.`,
  );
  if (r.dealNet != null) {
    const cost = [`${money(r.feesCharged)} in ticketing fees`, `${money(r.expensesCharged)} in show expenses`];
    parts.push(
      `After ${cost.join(" and ")}${r.venueAbsorbedOverCap > 0 ? ` (the venue covered ${money(r.venueAbsorbedOverCap)} over the cap)` : ""}, net was ${money(r.dealNet)}.`,
    );
  }
  parts.push(`The deal is ${r.dealSummary.charAt(0).toLowerCase() + r.dealSummary.slice(1)}.`);
  const split = r.lines.find((l) => l.key === "split");
  if (split) parts.push(`${split.label}: ${money(split.amount)}.`);
  const paid = r.bonuses.filter((b) => b.paid && b.amount > 0);
  if (paid.length) parts.push(`Bonuses paid: ${paid.map((b) => `${b.label} (${money(b.amount)})`).join("; ")}.`);
  if (r.adjustments < 0) parts.push(`Less ${money(-r.adjustments)} in recoups or advances.`);
  parts.push(`Total to artist: ${money(r.totalToArtist)}.`);
  if (r.recoupsHeld > 0) parts.push(`${money(r.recoupsHeld)} in disputed recoups is held open, not deducted.`);
  void deal;
  return parts.join(" ");
}

// ---------------------------------------------------------------- decisions & checks

type DecisionSpec = {
  key: keyof Readings;
  title: string;
  question: string;
  options: { value: string; label: string; description: string }[];
  applies: (input: SettlementInput, bonuses: Bonus[]) => boolean;
  sourceText?: (input: SettlementInput) => string | undefined;
};

const DECISION_SPECS: DecisionSpec[] = [
  {
    key: "percentageSource",
    title: "The notes and the deal record name different percentages",
    question: "Which percentage is the deal?",
    options: [
      { value: "field", label: "Deal record", description: "Use the percentage in the structured deal field." },
      { value: "notes", label: "Deal notes", description: "Use the percentage written in the deal notes (often the more recent renegotiation)." },
    ],
    applies: (i, b) => notesPercentageConflict(i.deal, b) != null,
    sourceText: (i) => i.deal.dealNotesFreetext ?? undefined,
  },
  {
    key: "recoupPlacement",
    title: "Is the recoup inside the expense cap or on top of it?",
    question: "How should recoups that aren't already receipts be charged?",
    options: [
      { value: "outside_cap", label: "On top of the cap", description: "Expenses are capped; the recoup is charged in addition." },
      { value: "inside_cap", label: "Inside the cap", description: "The cap is a ceiling on everything the venue charges, recoups included." },
    ],
    applies: (i) => i.deal.expenseCap != null && i.recoups.some((r) => r.status !== "withdrawn" && r.category !== "prior_advance"),
    sourceText: (i) => i.deal.dealNotesFreetext ?? undefined,
  },
  {
    key: "disputedRecoups",
    title: "A recoup is disputed by the artist team",
    question: "Deduct it tonight, or settle the undisputed amount and hold it open?",
    options: [
      { value: "hold", label: "Hold it open", description: "Pay the undisputed amount now; the recoup stays a separate open item." },
      { value: "deduct", label: "Deduct it", description: "Charge the recoup in tonight's settlement." },
    ],
    applies: (i) => i.recoups.some((r) => r.status === "disputed"),
  },
  {
    key: "doorFees",
    title: "Door deal: do ticketing fees come off first?",
    question: 'The deal says the artist gets "ticket revenue minus expenses." Is that before or after fees?',
    options: [
      { value: "off_top", label: "After fees", description: "Fees are a cost of selling tickets, so they come off before the split." },
      { value: "not_deducted", label: "Before fees", description: "Ticket revenue means the face value of tickets sold." },
    ],
    applies: (i) => i.deal.dealType === "door",
    sourceText: (i) => i.deal.dealNotesFreetext ?? undefined,
  },
  {
    key: "ratchet",
    title: "Ratchet reached: does the higher % apply to all of net?",
    question: "When sales pass the ratchet tier, what does the higher percentage apply to?",
    options: [
      { value: "whole_net", label: "All of net", description: "Once the tier is reached, the higher % applies to the whole net." },
      { value: "above_tier", label: "Only above the tier", description: "The higher % applies only to the share of tickets sold above the tier." },
    ],
    applies: (i, b) => b.some((x) => x.type === "tier_ratchet"),
    sourceText: (i) => i.deal.dealNotesFreetext ?? undefined,
  },
  {
    key: "walkout",
    title: "Walkout: fixed amount or 100% of the overage?",
    question: 'The bonus says "100% of gross above" a threshold, but the deal record stores a fixed amount.',
    options: [
      { value: "fixed_amount", label: "Fixed amount", description: "Pay the amount stored on the deal record." },
      { value: "full_overage", label: "100% of the overage", description: "Pay every dollar of gross above the threshold, as the clause reads." },
    ],
    applies: (i, b) => b.some((x) => x.type === "gross_threshold" && WALKOUT_RE.test(x.label)),
    sourceText: (i) => i.deal.dealNotesFreetext ?? undefined,
  },
];

/**
 * Settle with the chosen readings, and return every decision whose options
 * actually change the payout, with what each option pays.
 */
export function settleWithDecisions(
  input: SettlementInput,
  chosen: Partial<Readings> = {},
  practice: Practice = AS_WRITTEN,
): FullSettlement {
  const readings: Readings = { ...DEFAULT_READINGS, ...chosen };
  const base = settle(input, readings, practice);
  const bonuses = parseBonuses(input.deal.bonusesJson);

  const decisions: Decision[] = [];
  for (const spec of DECISION_SPECS) {
    if (!spec.applies(input, bonuses)) continue;
    const options = spec.options.map((o) => ({
      ...o,
      totalToArtist: settle(input, { ...readings, [spec.key]: o.value } as Readings, practice).totalToArtist,
    }));
    const totals = options.map((o) => o.totalToArtist);
    const impact = round2(Math.max(...totals) - Math.min(...totals));
    if (impact < 1) continue;
    decisions.push({
      key: spec.key,
      title: spec.title,
      question: spec.question,
      options,
      chosen: readings[spec.key],
      impact,
      sourceText: spec.sourceText?.(input),
    });
  }

  return { ...base, decisions, checks: runChecks(input, bonuses), readings };
}

/** Data problems worth a look before anyone signs. */
export function runChecks(input: SettlementInput, bonuses: Bonus[]): Check[] {
  const checks: Check[] = [];
  const { deal, expenses, comps, recoups } = input;

  // Duplicate receipts: same category and amount entered twice.
  const seen = new Map<string, typeof expenses>();
  for (const e of expenses) {
    const k = `${e.category}|${e.amount}`;
    seen.set(k, [...(seen.get(k) ?? []), e]);
  }
  for (const group of seen.values()) {
    if (group.length > 1) {
      checks.push({
        level: "warning",
        title: `Possible duplicate receipt: ${group[0].category} ${money(group[0].amount)}`,
        detail: `${group.length} receipts with the same category and amount. Confirm both are real before charging them.`,
        sources: group.map((e) => ({ kind: "expense", id: e.id, label: `${e.category}${e.description ? ` — ${e.description}` : ""}`, amount: e.amount })),
      });
    }
  }

  // Hospitality over the rider cap with nothing absorbed or recouped.
  if (deal.hospitalityCap != null) {
    const hosp = expenses.filter((e) => e.category === "hospitality" && !e.absorbedByVenue);
    const total = hosp.reduce((s, e) => s + e.amount, 0);
    if (total > deal.hospitalityCap) {
      const recouped = recoups.some((r) => r.category === "hospitality_overage" && r.status !== "withdrawn");
      checks.push({
        level: recouped ? "info" : "warning",
        title: `Hospitality is ${money(total - deal.hospitalityCap)} over the ${money(deal.hospitalityCap)} rider`,
        detail: recouped
          ? "There's a hospitality-overage recoup on file; it's already inside these receipts, so it isn't charged twice."
          : "The overage is being charged as a normal expense. Decide whether the venue absorbs it or it's agreed as a recoup.",
        sources: hosp.map((e) => ({ kind: "expense", id: e.id, label: `hospitality${e.description ? ` — ${e.description}` : ""}`, amount: e.amount })),
      });
    }
  }

  // Comps: note says they count, flag says they don't (or vice versa).
  for (const c of comps) {
    if (c.notes && /count/i.test(c.notes) && !c.countsTowardGross) {
      checks.push({
        level: "warning",
        title: `Comp note says these count toward gross, but the flag is off`,
        detail: `"${c.notes}" — ${c.count} ${c.category.replace("_", " ")} comps at ${money(c.faceValue)} (${money(c.count * c.faceValue)} of gross).`,
        sources: [{ kind: "comp", id: c.id, label: `${c.count} × ${c.category}`, amount: c.count * c.faceValue }],
      });
    }
  }

  // Deal type in notes vs record.
  const notes = deal.dealNotesFreetext ?? "";
  if (deal.dealType !== "vs" && /\bvs\.?\b|g'tee vs|guarantee vs/i.test(notes)) {
    checks.push({
      level: "warning",
      title: "The notes describe a vs deal, but the deal record says otherwise",
      detail: `Deal record type: ${deal.dealType.replaceAll("_", " ")}. Confirm the deal type before settling.`,
      sources: [{ kind: "notes", label: notes }],
    });
  }

  // Notes mention a threshold update the record doesn't have.
  if (/structured field still|confirm before settlement|updated .* via phone|renegotiat/i.test(notes)) {
    checks.push({
      level: "warning",
      title: "The notes say a term changed after the deal was entered",
      detail: "The deal record may not reflect the latest agreement. Confirm with the agent before signing.",
      sources: [{ kind: "notes", label: notes }],
    });
  }

  // Disputed recoups (summary).
  const disputed = recoups.filter((r) => r.status === "disputed");
  if (disputed.length) {
    checks.push({
      level: "info",
      title: `${disputed.length} recoup${disputed.length === 1 ? "" : "s"} disputed by the artist team`,
      detail: "See the decision above. Whatever you choose is saved with the settlement record.",
      sources: disputed.map((r) => ({ kind: "recoup", id: r.id, label: r.label, amount: r.amount })),
    });
  }

  void bonuses;
  return checks;
}
