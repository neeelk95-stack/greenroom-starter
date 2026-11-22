import type { TaskDef } from "./types";
import { asObject, asString } from "./types";
import { ungroundedNumbers } from "../verify";

export type WhatIfChange =
  | { kind: "reading"; key: string; value: string }
  | { kind: "comps_count"; value: boolean };

export type AssistantContext = {
  dealSummary: string;
  totalToArtist: number;
  lines: { label: string; amount: number }[];
  decisions: { key: string; title: string; chosen: string; options: { value: string; label: string; totalToArtist: number }[] }[];
  compsCount: number;
};

export type AnswerInput = {
  question: string;
  context: AssistantContext;
  /** Set on the second step, after the engine computed a what-if. */
  whatIf?: { description: string; oldTotal: number; newTotal: number };
  allowedNumbers: number[];
};

export type AnswerOutput = { action: "answer"; answer: string } | { action: "what_if"; change: WhatIfChange };

const money = (n: number) => `${n < 0 ? "−" : ""}$${Math.abs(Math.round(n)).toLocaleString("en-US")}`;

function contextBlock(c: AssistantContext): string {
  const decisions = c.decisions.length
    ? c.decisions
        .map((d) => `- ${d.key}: ${d.title} Currently "${d.chosen}". Options: ${d.options.map((o) => `"${o.value}" (${o.label}) pays ${money(o.totalToArtist)}`).join("; ")}`)
        .join("\n")
    : "- none";
  return `Deal: ${c.dealSummary}\nLines:\n${c.lines.map((l) => `- ${l.label}: ${money(l.amount)}`).join("\n")}\nTotal to artist: ${money(c.totalToArtist)}\nTerms with two readings:\n${decisions}\nComp tickets on file: ${c.compsCount}`;
}

export const answerQuestion: TaskDef<AnswerInput, AnswerOutput> = {
  name: "answer_question",
  maxTokens: 600,
  prompt: (i) => {
    if (i.whatIf) {
      return {
        system: "You answer questions at a music venue's settlement table. Use only the numbers given. Reply with JSON only.",
        user: `${contextBlock(i.context)}\n\nQuestion: ${i.question}\nThe settlement engine computed: ${i.whatIf.description}. Total to artist changes from ${money(i.whatIf.oldTotal)} to ${money(i.whatIf.newTotal)}.\n\nAnswer in 2 to 3 sentences. Reply {"action": "answer", "answer": "..."}`,
      };
    }
    return {
      system:
        "You answer questions at a music venue's settlement table, for Ethan (the venue) and Drake (the artist's side). You never calculate: " +
        "the settlement engine does. Use only numbers from the data. Reply with JSON only.",
      user: `${contextBlock(i.context)}\n\nQuestion: ${i.question}\n\nIf the question asks what would happen under a different reading, ask the engine instead of answering:\n- {"action": "what_if", "change": {"kind": "reading", "key": "<one of the keys above>", "value": "<one of its option values>"}}\n- {"action": "what_if", "change": {"kind": "comps_count", "value": true}} if they ask about comps counting toward gross.\nOtherwise answer in 2 to 4 sentences: {"action": "answer", "answer": "..."}`,
    };
  },
  parse: (json) => {
    const o = asObject(json);
    if (o.action === "what_if" && o.change && typeof o.change === "object") {
      const c = o.change as Record<string, unknown>;
      if (c.kind === "comps_count") return { action: "what_if", change: { kind: "comps_count", value: c.value !== false } };
      if (c.kind === "reading" && typeof c.key === "string" && typeof c.value === "string") {
        return { action: "what_if", change: { kind: "reading", key: c.key, value: c.value } };
      }
      throw new Error("Unrecognised what-if");
    }
    const answer = asString(o.answer).trim();
    if (!answer) throw new Error("Empty answer");
    return { action: "answer", answer };
  },
  check: (out, i) => {
    if (out.action === "what_if") {
      const change = out.change;
      if (change.kind === "reading") {
        const d = i.context.decisions.find((x) => x.key === change.key);
        const okValue = d?.options.some((o) => o.value === change.value);
        return d && okValue ? [] : [`what-if names a reading that doesn't exist: ${change.key}=${change.value}`];
      }
      return [];
    }
    return ungroundedNumbers(out.answer, i.allowedNumbers).map((n) => `number not in the settlement: ${n}`);
  },
  rules: (i) => {
    if (i.whatIf) {
      return {
        action: "answer",
        answer: `If ${i.whatIf.description}, the artist gets ${money(i.whatIf.newTotal)} instead of ${money(i.whatIf.oldTotal)}. The engine recomputed every line; nothing else changes.`,
      };
    }
    const q = i.question.toLowerCase();
    if (/comp/.test(q) && i.context.compsCount > 0) return { action: "what_if", change: { kind: "comps_count", value: true } };
    const byWord: [RegExp, string][] = [
      [/recoup|cap/, "recoupPlacement"],
      [/fee/, "doorFees"],
      [/ratchet|tier|escalat/, "ratchet"],
      [/walkout|overage/, "walkout"],
      [/disput|hold/, "disputedRecoups"],
      [/notes|percentage/, "percentageSource"],
    ];
    if (/what if|instead|other reading|otherwise/.test(q)) {
      for (const [re, key] of byWord) {
        const d = i.context.decisions.find((x) => x.key === key);
        if (d && re.test(q)) {
          const other = d.options.find((o) => o.value !== d.chosen);
          if (other) return { action: "what_if", change: { kind: "reading", key, value: other.value } };
        }
      }
    }
    const top = i.context.lines.filter((l) => Math.abs(l.amount) > 0 && !/^gross$/i.test(l.label)).slice(0, 4);
    return {
      action: "answer",
      answer: `The total to the artist is ${money(i.context.totalToArtist)}. It comes from: ${top.map((l) => `${l.label} ${money(l.amount)}`).join("; ")}. Tap any line in the settlement to see its receipts.`,
    };
  },
};
