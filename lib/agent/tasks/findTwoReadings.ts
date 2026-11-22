import type { Readings } from "@/lib/settlementEngine";
import type { TaskDef } from "./types";
import { asObject, asString } from "./types";
import { quoteAppears } from "../verify";

export const READING_TYPES = [
  "recoup_vs_cap",
  "door_fees",
  "ratchet_scope",
  "walkout_amount",
  "changed_after_booking",
  "missing_terms",
  "other",
] as const;
export type ReadingType = (typeof READING_TYPES)[number];

/** Flags the settlement engine can price: both readings, and what each pays. */
export const ENGINE_KEY: Partial<Record<ReadingType, keyof Readings>> = {
  recoup_vs_cap: "recoupPlacement",
  door_fees: "doorFees",
  ratchet_scope: "ratchet",
  walkout_amount: "walkout",
};

export const READING_LABELS: Record<ReadingType, string> = {
  recoup_vs_cap: "Recoup inside or on top of the expense cap",
  door_fees: "Door deal: do ticketing fees come off first",
  ratchet_scope: "Ratchet: higher % on all of net or only above the tier",
  walkout_amount: "Walkout: fixed amount or 100% of the overage",
  changed_after_booking: "A term changed after booking",
  missing_terms: "Terms referred to but not stated",
  other: "Other ambiguity",
};

export type Flag = { type: ReadingType; quote: string; question: string; readingA: string; readingB: string };
export type ReadingsInput = { email: string };
export type ReadingsOutput = { flags: Flag[] };

export const findTwoReadings: TaskDef<ReadingsInput, ReadingsOutput> = {
  name: "find_two_readings",
  maxTokens: 1200,
  prompt: ({ email }) => ({
    system:
      "You review a music venue's booking email for terms that two reasonable people could read in two different ways, " +
      "where the reading changes what the artist is paid. You never calculate anything. Reply with JSON only.",
    user: `Email:\n<<<\n${email}\n>>>\n\nLook for these patterns. Use the type names exactly:\n- recoup_vs_cap: a recoup or deduction (for example marketing) is mentioned alongside an expense cap, and the email doesn't say whether it sits inside the cap or on top of it.\n- door_fees: a door deal gives the artist the door or ticket revenue minus expenses, and doesn't say whether ticketing fees come off first.\n- ratchet_scope: the percentage steps up past a sales tier, and doesn't say whether the higher % applies to all of net or only above the tier.\n- walkout_amount: the artist gets 100% (or all) of gross above a threshold.\n- changed_after_booking: the email says a term was changed, renegotiated or updated after the original deal.\n- missing_terms: the email refers to terms that aren't actually stated (for example "bonuses per the deal memo").\n- other: any other ambiguity that changes the payout.\n\nIf the email states the answer explicitly (for example "recoup included in the expense cap" or "after ticketing fees"), do not flag it.\n\nReply {"flags": [{"type": "<type>", "quote": "<exact words from the email>", "question": "<one short question to ask the agent>", "readingA": "<first reading>", "readingB": "<second reading>"}]}\nReply {"flags": []} if every term is clear.`,
  }),
  parse: (json) => {
    const o = asObject(json);
    const raw = Array.isArray(o.flags) ? o.flags : [];
    const flags: Flag[] = [];
    for (const f of raw) {
      const x = (f && typeof f === "object" ? f : {}) as Record<string, unknown>;
      const type = asString(x.type).toLowerCase() as ReadingType;
      flags.push({
        type: (READING_TYPES as readonly string[]).includes(type) ? type : "other",
        quote: asString(x.quote),
        question: asString(x.question),
        readingA: asString(x.readingA),
        readingB: asString(x.readingB),
      });
    }
    return { flags: dedupe(flags) };
  },
  check: ({ flags }, { email }) =>
    flags.filter((f) => !quoteAppears(email, f.quote)).map((f) => `${f.type}: quote isn't in the email ("${f.quote.slice(0, 60)}")`),
  rules: ({ email }) => ({ flags: rulesReadings(email) }),
};

function dedupe(flags: Flag[]): Flag[] {
  const seen = new Set<string>();
  return flags.filter((f) => {
    const k = f.type === "other" ? `${f.type}|${f.quote}` : f.type;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function sentenceAround(text: string, index: number, length: number): string {
  const start = Math.max(text.lastIndexOf(".", index - 1) + 1, text.lastIndexOf("\n", index - 1) + 1, 0);
  const endDot = text.indexOf(".", index + length);
  const endNl = text.indexOf("\n", index + length);
  const ends = [endDot, endNl].filter((e) => e !== -1);
  const end = ends.length ? Math.min(...ends) : text.length;
  return text.slice(start, end).trim();
}

/** The v1 regex detector: only the exact phrasings it knows. */
export function rulesReadings(email: string): Flag[] {
  const flags: Flag[] = [];
  const add = (type: ReadingType, m: RegExpMatchArray | null, question: string, a: string, b: string) => {
    if (!m) return;
    flags.push({ type, quote: sentenceAround(email, m.index ?? 0, m[0].length), question, readingA: a, readingB: b });
  };
  const hasCap = /expenses?\s+(?:are\s+)?capped|expense cap|expenses to\s|\(capped/i.test(email);
  const recoup = email.match(/recoup/i);
  if (hasCap && recoup && !/(inside|included in|within|on top of|in addition to) (the )?(expense )?cap/i.test(email)) {
    add("recoup_vs_cap", recoup, "Is the recoup inside the expense cap or on top of it?", "Inside the cap", "On top of the cap");
  }
  if (/door deal/i.test(email) && !/fees/i.test(email)) {
    add("door_fees", email.match(/minus expenses|door deal/i), "Do ticketing fees come off before the artist's share?", "After fees", "Before fees");
  }
  add("ratchet_scope", email.match(/ratchets?\s+to|escalator/i), "Does the higher % apply to all of net, or only above the tier?", "All of net", "Only above the tier");
  add("walkout_amount", email.match(/100%\s+of\s+gross\s+above/i), "Is the walkout a fixed amount or 100% of the overage?", "Fixed amount", "100% of the overage");
  add("changed_after_booking", email.match(/structured field still|confirm before settlement|updated .{0,40}via phone|renegotiat/i), "Which version of the term is the agreed one?", "Original term", "Updated term");
  add("missing_terms", email.match(/per the (deal memo|email)|see email thread/i), "Can you send the exact bonus terms?", "Terms as in the memo", "No bonus until stated");
  return flags;
}
