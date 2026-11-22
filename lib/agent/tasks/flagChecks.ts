/**
 * Deterministic checks on every two-readings flag, whichever model raised it.
 *
 * The model proposes; code checks what can be known from the email alone.
 * A flag survives only if:
 *
 *   1. quote:     its quoted words are really in the email;
 *   2. readings:  it states two readings, and they're different;
 *   3. money:     the quoted sentence is about pay (an amount, a %, or a
 *                 settlement term), not logistics;
 *   4. clause:    the email contains what that kind of ambiguity needs to
 *                 exist at all. A recoup-vs-cap question needs a cap and
 *                 something the venue takes back; a ratchet needs two rates;
 *                 a walkout needs a threshold; and so on;
 *   5. answered:  the email doesn't already settle it ("included in the
 *                 expense cap", "after ticketing fees", "on all of net").
 *
 * Why not "drop it if both readings pay the same"? At booking time there are
 * no ticket sales yet, and a term in the email may be missing from the deal
 * record, so the engine can't always price it. Dropping on a $0 difference
 * would hide exactly the risk Ethan needs to see. The engine still prices
 * every flag it can, so the ones that move money are shown first.
 *
 * These are necessary conditions written from what each flag type means,
 * not from the eval's wording. The eval's new-wording suite checks that.
 */

import type { Flag, ReadingType } from "./findTwoReadings";
import { quoteAppears, sentenceWithQuote } from "../verify";

export type DropReason = "quote" | "readings" | "money" | "clause" | "answered";
export type DroppedFlag = Flag & { reason: DropReason; detail: string };

const MONEY = /\$\s?\d|\d\s?%|\bpercent|\bguarantee|\bgross\b|\bnet\b|\bbonus|\bexpense|\bcosts?\b|\bfees?\b|recoup|\bsplit\b|\bdoor\b|box office|\bgate\b|\bcap\b|capped|walkout|overage|merch|deduct|reimburs|comes? back|takes? back|ticket (revenue|sales|receipts)|tickets? sold|\bpaid\b|\bpot\b/i;

/** What each kind of ambiguity needs in the email to exist at all. */
const NEEDS: Record<Exclude<ReadingType, "other">, { test: (email: string) => boolean; why: string }> = {
  recoup_vs_cap: {
    test: (e) =>
      /\bcap\b|capped|not to exceed|\bmax(imum)?\b|ceiling/i.test(e) &&
      /recoup|(marketing|advertising|\bads?|promo\w*|radio|social|print|posters?|media)\s+(spend|buy|costs?|fees?|budget|charge)|\$\s?[\d,.]+k?\s+(for|in|of)\s+[a-z ,&]{0,30}(\bads?\b|advertising|marketing|promo\w*|radio|social|print|posters?)|comes? back|takes? back|took back|taken back|paid back|reimburs|charge ?back|off the top|deduct|withh[eo]ld/i.test(e),
    why: "needs both an expense cap and something the venue takes back",
  },
  door_fees: {
    test: (e) => /\bdoor\b|box office|\bgate\b|ticket (revenue|sales|receipts|money)/i.test(e),
    why: "needs a deal paid from the door or ticket revenue",
  },
  ratchet_scope: {
    test: (e) => new Set([...e.matchAll(/(\d{1,3}(?:\.\d+)?)\s?(%|percent)/gi)].map((m) => Number(m[1]))).size >= 2,
    why: "needs at least two different percentages",
  },
  walkout_amount: {
    test: (e) => /(above|over|past|beyond|exceed\w*|pass(es|ing)?|clear(s|ing)?|tops?|reach(es|ing)?|hits?|more than|north of)\s+(the\s+)?(\$\s?[\d,.]+k?|\d[\d,]*\s?(in\s+)?gross|breakeven|break-even)/i.test(e),
    why: "needs a gross threshold",
  },
  changed_after_booking: {
    test: (e) => /chang|updat|revis|renegotiat|amend|\bnow\b|no longer|instead of|\(was\b|\bwas \$|\bmov(e|es|ed|ing) (up|down|to)|bump|replac|correct|structured field|confirm before/i.test(e),
    why: "needs words saying a term changed",
  },
  missing_terms: {
    test: (e) =>
      /\bper (the|our)\b|as (discussed|agreed|per|before|usual|always)|we (discussed|agreed|talked)|\busual\b|\bstandard\b|same (as|terms|deal)|see (the |our )?(email|thread|memo|attached|contract|rider)|attached|\bmemo\b|deal sheet|on the phone|over the phone|on (our|the) call|last (tour|time|year|run|show|visit)|previous|\bTB[CD]\b|to be (confirmed|determined|agreed)/i.test(e),
    why: "needs a reference to terms stated somewhere else",
  },
};

/** Wording that settles each kind of ambiguity. Checked across the whole email, except walkout (its own clause). */
const SETTLED: Partial<Record<ReadingType, RegExp>> = {
  recoup_vs_cap:
    /(inside|included in|includ(es|ed|ing)|within|part of|counts? (toward|towards|against)|comes? out of|on top of|in addition to|outside( of)?|separate from|excluded from|over and above|apart from) (the |that |this |our )?(expense |expenses |production )?cap\b/i,
  door_fees:
    /(after|before|net of|less|minus|including|excluding|exclusive of|inclusive of|not counting|after deducting|before deducting) (all |the |any )?(ticketing |ticket |box office |service |facility )?fees|fees (come off|are deducted|aren'?t deducted|are not deducted|off the top|stay with|are the venue'?s|are the artist'?s)/i,
  ratchet_scope:
    /(on|to|of|across|applies to) (all|the whole|the entire|every|each) (of )?(the )?(net|dollar|ticket)|only (on|to|for) (the )?(tickets|sales|net|amount|dollars|revenue) (above|over|past|beyond)|only above the (tier|threshold)|retroactive|from the first (ticket|dollar)/i,
  walkout_amount: /\bfixed\b|\bflat\b|100% of the overage|(bonus|walkout) of \$\s?[\d,]+|\$\s?[\d,.]+k? bonus/i,
};

const normReading = (s: string) => s.toLowerCase().replace(/[^a-z0-9%$]+/g, " ").trim();

export function checkFlag(email: string, f: Flag): { ok: true } | { ok: false; reason: DropReason; detail: string } {
  if (!quoteAppears(email, f.quote)) return { ok: false, reason: "quote", detail: "quote isn't in the email" };
  const a = normReading(f.readingA), b = normReading(f.readingB);
  if (f.type === "other" && (!a || !b)) return { ok: false, reason: "readings", detail: "no two readings given" };
  if (a && b && a === b) return { ok: false, reason: "readings", detail: "both readings are the same" };
  const sentence = sentenceWithQuote(email, f.quote);
  if (!MONEY.test(sentence)) return { ok: false, reason: "money", detail: "the quoted sentence isn't about pay" };
  if (f.type !== "other") {
    const need = NEEDS[f.type];
    if (!need.test(email)) return { ok: false, reason: "clause", detail: need.why };
    const settled = SETTLED[f.type];
    const where = f.type === "walkout_amount" ? sentence : email;
    if (settled && settled.test(where)) return { ok: false, reason: "answered", detail: `the email already says: "${where.match(settled)?.[0]}"` };
  }
  return { ok: true };
}

export function verifyFlags(email: string, flags: Flag[]): { flags: Flag[]; dropped: DroppedFlag[] } {
  const kept: Flag[] = [];
  const dropped: DroppedFlag[] = [];
  for (const f of flags) {
    const r = checkFlag(email, f);
    if (r.ok) kept.push(f);
    else dropped.push({ ...f, reason: r.reason, detail: r.detail });
  }
  return { flags: kept, dropped };
}

/** For tests: does the email, on its face, still leave this kind of ambiguity open? */
export function typeIsOpen(email: string, type: ReadingType): boolean {
  if (type === "other") return true;
  if (!NEEDS[type].test(email)) return false;
  const settled = SETTLED[type];
  return !(settled && type !== "walkout_amount" && settled.test(email));
}
