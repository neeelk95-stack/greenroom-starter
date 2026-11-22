import type { Deal } from "@/db/schema";
import type { TaskDef } from "./types";
import { asNumber, asObject, asString } from "./types";
import { quoteAppears, quoteSupportsNumber } from "../verify";

export type DealType = Deal["dealType"];
export type BonusKind = "gross_threshold" | "sellout" | "attendance_threshold" | "tier_ratchet" | "walkout" | "other";
export type CitedField = "dealType" | "guaranteeAmount" | "percentage" | "percentageBasis" | "expenseCap" | "hospitalityCap";

export const MONEY_FIELDS: CitedField[] = ["dealType", "guaranteeAmount", "percentage", "expenseCap", "hospitalityCap"];

export type DealTerms = {
  dealType: DealType | null;
  guaranteeAmount: number | null;
  percentage: number | null;
  percentageBasis: "gross" | "net" | null;
  expenseCap: number | null;
  hospitalityCap: number | null;
  bonuses: { label: string; kind: BonusKind; threshold: number | null; amount: number | null }[];
  recoups: { label: string; amount: number | null }[];
  citations: Partial<Record<CitedField, string>>;
  confidence: "high" | "medium" | "low";
};

export type ExtractInput = { email: string };

const DEAL_TYPES: DealType[] = ["flat", "percentage_of_gross", "percentage_of_net", "vs", "door"];
const BONUS_KINDS: BonusKind[] = ["gross_threshold", "sellout", "attendance_threshold", "tier_ratchet", "walkout", "other"];

function normDealType(v: unknown): DealType | null {
  const s = asString(v).toLowerCase().replace(/[\s-]+/g, "_");
  if (!s || s === "null" || s === "none" || s === "unknown") return null;
  if ((DEAL_TYPES as string[]).includes(s)) return s as DealType;
  if (/versus|^vs|guarantee_vs|vs_/.test(s)) return "vs";
  if (/door/.test(s)) return "door";
  if (/gross/.test(s)) return "percentage_of_gross";
  if (/net|percent/.test(s)) return "percentage_of_net";
  if (/flat|buyout|guarantee/.test(s)) return "flat";
  return null;
}

function normPercentage(v: unknown): number | null {
  const n = asNumber(v);
  if (n == null || n <= 0) return null;
  const p = n > 1 ? n / 100 : n;
  return p > 0 && p <= 1 ? Math.round(p * 1000) / 1000 : null;
}

export const extractTerms: TaskDef<ExtractInput, DealTerms> = {
  name: "extract_terms",
  maxTokens: 900,
  prompt: ({ email }) => ({
    system:
      "You extract deal terms from a booking email for a music venue's settlement system. Reply with JSON only. " +
      "Never invent a number: every number must come from the email. For every field you fill, copy the exact words " +
      "from the email that support it into `citations`. If the email doesn't state a field, use null.",
    user: `Email:\n<<<\n${email}\n>>>\n\nReply with this JSON shape:\n{\n  "dealType": "flat" | "percentage_of_gross" | "percentage_of_net" | "vs" | "door" | null,\n  "guaranteeAmount": number | null,\n  "percentage": number | null,\n  "percentageBasis": "gross" | "net" | null,\n  "expenseCap": number | null,\n  "hospitalityCap": number | null,\n  "bonuses": [{"label": string, "kind": "gross_threshold" | "sellout" | "attendance_threshold" | "tier_ratchet" | "walkout" | "other", "threshold": number | null, "amount": number | null}],\n  "recoups": [{"label": string, "amount": number | null}],\n  "citations": {"dealType": "<exact words>", "guaranteeAmount": "<exact words>", "...": "only for fields you filled"},\n  "confidence": "high" | "medium" | "low"\n}\n\nDefinitions:\n- vs: a guarantee versus a percentage, whichever is greater.\n- door: the artist gets the door / ticket revenue minus expenses.\n- flat: a fixed fee with no percentage.\n- A percentage with no guarantee is percentage_of_net or percentage_of_gross.\n- percentage is the artist's share as a decimal: 80% or an 80/20 split is 0.8.\n- percentageBasis is "net" when expenses come out first, "gross" when they don't.`,
  }),
  parse: (json) => {
    const o = asObject(json);
    const bonusesRaw = Array.isArray(o.bonuses) ? o.bonuses : [];
    const recoupsRaw = Array.isArray(o.recoups) ? o.recoups : [];
    const citationsRaw = o.citations && typeof o.citations === "object" ? (o.citations as Record<string, unknown>) : {};
    const basis = asString(o.percentageBasis).toLowerCase();
    const conf = asString(o.confidence).toLowerCase();
    const citations: DealTerms["citations"] = {};
    for (const [k, v] of Object.entries(citationsRaw)) {
      if (typeof v === "string" && v.trim()) citations[k as CitedField] = v.trim();
    }
    return {
      dealType: normDealType(o.dealType),
      guaranteeAmount: asNumber(o.guaranteeAmount),
      percentage: normPercentage(o.percentage),
      percentageBasis: basis === "gross" || basis === "net" ? basis : null,
      expenseCap: asNumber(o.expenseCap),
      hospitalityCap: asNumber(o.hospitalityCap),
      bonuses: bonusesRaw.map((b) => {
        const x = (b && typeof b === "object" ? b : {}) as Record<string, unknown>;
        const kind = asString(x.kind) as BonusKind;
        return {
          label: asString(x.label),
          kind: BONUS_KINDS.includes(kind) ? kind : "other",
          threshold: asNumber(x.threshold),
          amount: asNumber(x.amount),
        };
      }),
      recoups: recoupsRaw.map((r) => {
        const x = (r && typeof r === "object" ? r : {}) as Record<string, unknown>;
        return { label: asString(x.label), amount: asNumber(x.amount) };
      }),
      citations,
      confidence: conf === "high" || conf === "medium" || conf === "low" ? conf : "medium",
    };
  },
  check: (t, { email }) => checkTerms(t, email),
  rules: ({ email }) => rulesExtract(email),
};

/** Every filled money field needs a citation that is really in the email and contains the number. */
export function checkTerms(t: DealTerms, email: string): string[] {
  const problems: string[] = [];
  const need = (field: CitedField, kind: "money" | "percent" | "text", value: number | string | null) => {
    if (value == null) return;
    const q = t.citations[field];
    if (!q) return problems.push(`${field}: no citation`);
    if (!quoteAppears(email, q)) return problems.push(`${field}: citation isn't in the email ("${q.slice(0, 60)}")`);
    if (kind !== "text" && !quoteSupportsNumber(q, value as number, kind)) problems.push(`${field}: citation doesn't contain ${value}`);
  };
  need("dealType", "text", t.dealType);
  need("guaranteeAmount", "money", t.guaranteeAmount);
  need("percentage", "percent", t.percentage);
  need("expenseCap", "money", t.expenseCap);
  need("hospitalityCap", "money", t.hospitalityCap);
  if (t.dealType === "vs" && (t.guaranteeAmount == null || t.percentage == null)) problems.push("vs deal is missing its guarantee or percentage");
  if (t.dealType === "flat" && t.guaranteeAmount == null) problems.push("flat deal is missing its amount");
  if (t.dealType == null) problems.push("deal type not found");
  return problems;
}

// ---------------------------------------------------------------- rules (no AI)

const MONEY = String.raw`\$?\s?(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s*(k\b)?`;
const toNum = (m: RegExpMatchArray | null, i = 1): number | null => {
  if (!m) return null;
  const n = parseFloat(m[i].replace(/,/g, ""));
  return m[i + 1] ? n * 1000 : n;
};

function firstMatch(text: string, patterns: RegExp[]): RegExpMatchArray | null {
  let best: RegExpMatchArray | null = null;
  for (const p of patterns) {
    const m = text.match(p);
    if (m && (best == null || (m.index ?? 0) < (best.index ?? 0))) best = m;
  }
  return best;
}

export function rulesExtract(email: string): DealTerms {
  const citations: DealTerms["citations"] = {};

  const guaranteeM = firstMatch(email, [
    new RegExp(MONEY + String.raw`\s*(?:g'?tee|guarantee)\b`, "i"),
    new RegExp(String.raw`\$(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s*(k\b)?\s*(?:vs\.?|versus)\b`, "i"),
    new RegExp(String.raw`(?:guarantee|g'?tee)\s*(?:of\s*)?` + MONEY, "i"),
    new RegExp(String.raw`flat(?:\s+guarantee|\s+fee)?(?:\s+of)?\s*` + MONEY, "i"),
  ]);
  const guaranteeAmount = toNum(guaranteeM);
  if (guaranteeM) citations.guaranteeAmount = guaranteeM[0].trim();

  const pctM = firstMatch(email, [/(\d{2,3})\s*%/, /\b(\d{2})\s*\/\s*(\d{2})\b/]);
  let percentage: number | null = null;
  if (pctM) {
    const a = parseInt(pctM[1], 10);
    const isSplit = pctM[0].includes("/");
    if (!isSplit || a + parseInt(pctM[2], 10) === 100) percentage = a >= 30 && a <= 100 ? a / 100 : null;
    if (percentage != null) citations.percentage = pctM[0].trim();
  }

  let percentageBasis: DealTerms["percentageBasis"] = null;
  if (percentage != null && pctM) {
    const after = email.slice((pctM.index ?? 0) + pctM[0].length, (pctM.index ?? 0) + pctM[0].length + 30).toLowerCase();
    if (/gross/.test(after)) percentageBasis = "gross";
    else if (/net/.test(after)) percentageBasis = "net";
    else if (/after expenses/i.test(email)) percentageBasis = "net";
    else if (/no expense/i.test(email)) percentageBasis = "gross";
    else percentageBasis = "net";
  }

  let dealType: DealType | null = null;
  const doorM = email.match(/door deal|door split|the door\b/i);
  const vsM = email.match(/\bvs\.?\b|versus|whichever (?:is )?greater|g'tee with escalator/i);
  const flatM = email.match(/\bflat\b|buyout/i);
  if (doorM) {
    dealType = "door";
    citations.dealType = doorM[0];
  } else if (guaranteeAmount != null && percentage != null) {
    dealType = "vs";
    citations.dealType = (vsM ?? guaranteeM)![0];
  } else if (percentage != null) {
    dealType = percentageBasis === "gross" ? "percentage_of_gross" : "percentage_of_net";
    citations.dealType = pctM![0];
  } else if (guaranteeAmount != null || flatM) {
    dealType = "flat";
    citations.dealType = (flatM ?? guaranteeM)![0];
  }
  if (dealType === "door") {
    percentage = null;
    percentageBasis = null;
    delete citations.percentage;
  }

  const capM = firstMatch(email, [
    new RegExp(String.raw`expenses?\s+(?:are\s+)?capped\s+(?:at\s+)?` + MONEY, "i"),
    new RegExp(String.raw`expense\s+cap\s+(?:of\s+)?` + MONEY, "i"),
    new RegExp(String.raw`expenses?\s+to\s+` + MONEY, "i"),
    new RegExp(String.raw`\(capped\s+` + MONEY, "i"),
    new RegExp(String.raw`expenses?\s+(?:not\s+to\s+exceed|up\s+to)\s+` + MONEY, "i"),
  ]);
  const expenseCap = toNum(capM);
  if (capM) citations.expenseCap = capM[0].trim();

  const hospM = email.match(new RegExp(String.raw`(?:hospitality|hosp)\.?\s*(?:cap\s*)?(?:of\s*)?` + MONEY, "i"));
  const hospitalityCap = toNum(hospM);
  if (hospM) citations.hospitalityCap = hospM[0].trim();

  const bonuses: DealTerms["bonuses"] = [];
  for (const m of email.matchAll(new RegExp(String.raw`\+\s?` + MONEY + String.raw`\s*(?:bonus\s*)?(?:if|over|when)\s*(?:gross\s*)?(?:>|exceeds|over|above)?\s*` + MONEY, "gi"))) {
    bonuses.push({ label: m[0].trim(), kind: "gross_threshold", amount: toNum(m, 1), threshold: toNum(m, 3) });
  }
  const walkM = email.match(new RegExp(String.raw`100%\s+of\s+gross\s+above\s+` + MONEY, "i"));
  if (walkM) bonuses.push({ label: walkM[0], kind: "walkout", threshold: toNum(walkM), amount: null });
  if (/ratchets?\s+to|escalator/i.test(email)) bonuses.push({ label: "Ratchet", kind: "tier_ratchet", threshold: null, amount: null });
  if (/sellout bonus/i.test(email)) bonuses.push({ label: "Sellout bonus", kind: "sellout", threshold: null, amount: null });

  const recoups: DealTerms["recoups"] = [];
  for (const m of email.matchAll(new RegExp(String.raw`(\w+)\s+recoup\s+of\s+` + MONEY, "gi"))) {
    recoups.push({ label: `${m[1]} recoup`, amount: toNum(m, 2) });
  }

  return {
    dealType,
    guaranteeAmount: dealType === "door" ? null : guaranteeAmount,
    percentage,
    percentageBasis,
    expenseCap,
    hospitalityCap,
    bonuses,
    recoups,
    citations,
    confidence: "medium",
  };
}
