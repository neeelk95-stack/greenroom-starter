import type { TaskDef } from "./types";
import { asObject, asString } from "./types";

export type EmailKind = "offer" | "change" | "settlement_question" | "other";
export type ClassifyInput = { email: string };
export type ClassifyOutput = { kind: EmailKind; reason: string };

const KINDS: EmailKind[] = ["offer", "change", "settlement_question", "other"];

export const classifyEmail: TaskDef<ClassifyInput, ClassifyOutput> = {
  name: "classify_email",
  maxTokens: 150,
  prompt: ({ email }) => ({
    system: "You sort emails for a music venue's booking inbox. Reply with JSON only.",
    user: `Email:\n<<<\n${email}\n>>>\n\nWhich kind is it?\n- offer: proposes or confirms the terms of a show deal\n- change: changes terms of a deal already agreed\n- settlement_question: asks about a settlement after a show\n- other: anything else\n\nReply {"kind": "offer" | "change" | "settlement_question" | "other", "reason": "<one short sentence>"}`,
  }),
  parse: (json) => {
    const o = asObject(json);
    const kind = asString(o.kind).toLowerCase() as EmailKind;
    if (!KINDS.includes(kind)) throw new Error(`Unknown kind "${o.kind}"`);
    return { kind, reason: asString(o.reason) };
  },
  check: () => [],
  rules: ({ email }) => {
    const t = email.toLowerCase();
    if (/re: settlement|settlement statement|your statement|the math on|question about the math/.test(t)) return { kind: "settlement_question", reason: "Asks about a settlement." };
    if (/updated|renegotiat|change(d)? to|now \$|dropped to|instead of/.test(t)) return { kind: "change", reason: "Says a term changed." };
    if (/guarantee|g'tee|\bvs\b|% of|door deal|flat|offer|confirm/.test(t)) return { kind: "offer", reason: "Contains deal terms." };
    return { kind: "other", reason: "No deal terms found." };
  },
};
