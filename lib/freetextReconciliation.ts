/**
 * Freetext-vs-structured contradiction detector (BR-10).
 *
 * This is the natural place for an LLM in the Deal Builder — agents communicate
 * deal updates by email/phone, Mariana captures the nuance in the freetext
 * field, and the structured fields drift from reality. Today's data has
 * concrete examples: "bonus threshold dropped to $6,000. Note: structured
 * field still reflects original $11,000 — confirm before settlement."
 *
 * V1 implementation is deterministic — regex extraction of dollar amounts and
 * percentages, with a contradiction heuristic that compares them to structured
 * fields. Designed so the LLM upgrade is a drop-in replacement of `detect()`.
 *
 * Why mock first (per BR scope):
 *  1. Prototype must run for the hiring team without API keys.
 *  2. Deterministic detection demoes predictably on the seed data.
 *  3. The product contract — "contradiction found at field X with value Y" —
 *     stays identical whether the implementation is regex or Haiku.
 *
 * When upgraded to LLM (claude-haiku-4-5), the same `Contradiction` shape is
 * returned with higher precision/recall on prose patterns this mock can't
 * see (semantic phrases like "we settled on", "agent confirmed", "ignore the
 * field that says X").
 */

import type { Deal } from "@/db/schema";

export type Contradiction = {
  field: "guaranteeAmount" | "percentage" | "expenseCap" | "hospitalityCap" | "walkoutThreshold" | "bonusAmount";
  structuredValue: number;
  freetextValue: number;
  freetextSnippet: string;
  confidence: "high" | "medium" | "low";
  // Human-readable explanation rendered to Mariana.
  explanation: string;
};

const DOLLAR_REGEX = /\$([\d,]+(?:\.\d+)?)\s*([kK])?/g;

function parseDollar(match: RegExpMatchArray): number {
  const num = parseFloat(match[1].replace(/,/g, ""));
  if (match[2]) return num * 1000;
  return num;
}

/**
 * Extract dollar amounts mentioned in freetext, along with a small surrounding
 * context window for explanation.
 */
function extractDollarMentions(
  text: string,
): { value: number; snippet: string; keywords: string[] }[] {
  const results: { value: number; snippet: string; keywords: string[] }[] = [];
  const matches = Array.from(text.matchAll(DOLLAR_REGEX));
  for (const m of matches) {
    const value = parseDollar(m);
    const idx = m.index ?? 0;
    const before = text.slice(Math.max(0, idx - 40), idx);
    const after = text.slice(idx + m[0].length, Math.min(text.length, idx + m[0].length + 40));
    const snippet = (before + m[0] + after).replace(/\s+/g, " ").trim();
    const keywords = extractKeywords(before + " " + after);
    results.push({ value, snippet, keywords });
  }
  return results;
}

function extractKeywords(window: string): string[] {
  const lower = window.toLowerCase();
  const keywords: string[] = [];
  if (/\b(g(?:ua)?r?(?:antee)?)\b/.test(lower)) keywords.push("guarantee");
  if (/\bcap\b/.test(lower)) keywords.push("cap");
  if (/\bexpense/.test(lower)) keywords.push("expense");
  if (/\bhosp/.test(lower)) keywords.push("hospitality");
  if (/\bwalkout|walk out|walk-out/.test(lower)) keywords.push("walkout");
  if (/\bbonus|incentive|threshold/.test(lower)) keywords.push("bonus");
  if (/\bgross\b/.test(lower)) keywords.push("gross");
  if (/\bnet\b/.test(lower)) keywords.push("net");
  if (/\bupdate|change|dropped|raised|reduce/.test(lower)) keywords.push("update");
  return keywords;
}

/**
 * Compare structured fields to freetext mentions. Returns a list of likely
 * contradictions.
 */
export function detect(deal: Pick<
  Deal,
  | "guaranteeAmount"
  | "percentage"
  | "expenseCap"
  | "hospitalityCap"
  | "bonusesJson"
  | "dealNotesFreetext"
>): Contradiction[] {
  if (!deal.dealNotesFreetext) return [];
  const text = deal.dealNotesFreetext;
  const mentions = extractDollarMentions(text);
  const contradictions: Contradiction[] = [];

  // Guarantee
  if (deal.guaranteeAmount != null) {
    const guaranteeMentions = mentions.filter((m) =>
      m.keywords.includes("guarantee"),
    );
    for (const m of guaranteeMentions) {
      if (
        Math.abs(m.value - deal.guaranteeAmount) > 50 &&
        m.value > 0
      ) {
        contradictions.push({
          field: "guaranteeAmount",
          structuredValue: deal.guaranteeAmount,
          freetextValue: m.value,
          freetextSnippet: m.snippet,
          confidence: m.keywords.includes("update") ? "high" : "medium",
          explanation: `Freetext mentions a guarantee of $${m.value.toLocaleString()} but the structured field has $${deal.guaranteeAmount.toLocaleString()}. ${m.keywords.includes("update") ? "Freetext explicitly references an update — likely the more recent value." : "Worth confirming which is authoritative before save."}`,
        });
      }
    }
  }

  // Expense cap
  if (deal.expenseCap != null) {
    const capMentions = mentions.filter(
      (m) =>
        m.keywords.includes("cap") &&
        (m.keywords.includes("expense") || !m.keywords.includes("hospitality")),
    );
    for (const m of capMentions) {
      if (Math.abs(m.value - deal.expenseCap) > 50 && m.value > 0) {
        contradictions.push({
          field: "expenseCap",
          structuredValue: deal.expenseCap,
          freetextValue: m.value,
          freetextSnippet: m.snippet,
          confidence: m.keywords.includes("update") ? "high" : "medium",
          explanation: `Freetext mentions an expense cap of $${m.value.toLocaleString()} but the structured field has $${deal.expenseCap.toLocaleString()}.`,
        });
      }
    }
  }

  // Hospitality cap
  if (deal.hospitalityCap != null) {
    const hospMentions = mentions.filter((m) =>
      m.keywords.includes("hospitality"),
    );
    for (const m of hospMentions) {
      if (Math.abs(m.value - deal.hospitalityCap) > 25 && m.value > 0) {
        contradictions.push({
          field: "hospitalityCap",
          structuredValue: deal.hospitalityCap,
          freetextValue: m.value,
          freetextSnippet: m.snippet,
          confidence: "medium",
          explanation: `Freetext mentions a hospitality cap of $${m.value.toLocaleString()} but the structured field has $${deal.hospitalityCap.toLocaleString()}.`,
        });
      }
    }
  }

  // Bonuses: parse `bonusesJson` and compare amounts/thresholds against text.
  if (deal.bonusesJson) {
    try {
      const bonuses = JSON.parse(deal.bonusesJson);
      if (Array.isArray(bonuses)) {
        for (const b of bonuses) {
          if (b.threshold != null) {
            const matches = mentions.filter(
              (m) => m.keywords.includes("bonus") && m.value !== b.threshold,
            );
            for (const m of matches) {
              if (
                Math.abs(m.value - b.threshold) > 500 &&
                m.value > 1000 &&
                m.keywords.includes("update")
              ) {
                contradictions.push({
                  field: "bonusAmount",
                  structuredValue: b.threshold,
                  freetextValue: m.value,
                  freetextSnippet: m.snippet,
                  confidence: "high",
                  explanation: `Freetext references a bonus threshold update to $${m.value.toLocaleString()}; structured bonus "${b.label}" still has threshold $${b.threshold.toLocaleString()}.`,
                });
              }
            }
          }
        }
      }
    } catch {
      // Malformed JSON — ignore, this is a different bug than the contradictions we're after.
    }
  }

  return contradictions;
}

/**
 * For the prototype, expose whether the LLM path is available. Always false
 * in V1; the upgrade lands when ANTHROPIC_API_KEY is wired up.
 */
export function isLlmEnabled(): boolean {
  return false;
}
