import type { TaskDef } from "./types";
import { asObject, asString } from "./types";
import { ungroundedNumbers } from "../verify";
import type { Flag } from "./findTwoReadings";

// ---------------------------------------------------------------- draft_message

export type DraftInput = {
  artistName: string;
  showDate: string;
  agentFirstName: string;
  bookerName: string;
  venueName: string;
  flags: Flag[];
  allowedNumbers: number[];
};
export type Draft = { subject: string; body: string };

export const draftMessage: TaskDef<DraftInput, Draft> = {
  name: "draft_message",
  maxTokens: 500,
  prompt: (i) => ({
    system:
      "You draft short, friendly emails from a music venue's booker to the artist's tour manager or agent. Use only the facts given. " +
      "Never add numbers that aren't in the facts. Reply with JSON only.",
    user: `Facts:\n- Artist: ${i.artistName}\n- Show date: ${i.showDate}\n- Agent's first name: ${i.agentFirstName}\n- Booker: ${i.bookerName}, ${i.venueName}\n- Terms to confirm:\n${i.flags
      .map((f) => `  - "${f.quote}": ${f.question} (${f.readingA} or ${f.readingB}?)`)
      .join("\n")}\n\nWrite an email under 120 words asking the agent to confirm each term in writing before the show, so settlement night is quick. Reply {"subject": "...", "body": "..."}`,
  }),
  parse: (json) => {
    const o = asObject(json);
    const subject = asString(o.subject).trim();
    const body = asString(o.body).trim();
    if (!body) throw new Error("Empty draft");
    return { subject: subject || "Quick confirmation on deal terms", body };
  },
  check: (d, i) => ungroundedNumbers(`${d.subject} ${d.body}`, i.allowedNumbers).map((n) => `number not in the facts: ${n}`),
  rules: (i) => ({
    subject: `${i.artistName}, ${i.showDate}: two minutes to confirm deal terms`,
    body:
      `Hi ${i.agentFirstName},\n\nLooking forward to ${i.artistName} on ${i.showDate}. Before the show, could you confirm how we should read ` +
      `${i.flags.length === 1 ? "this term" : "these terms"}?\n\n` +
      i.flags.map((f) => `- "${f.quote}": ${f.question}`).join("\n") +
      `\n\nA one-line reply is perfect. It'll keep settlement night quick for both of us.\n\nThanks,\n${i.bookerName}\n${i.venueName}`,
  }),
};

// ---------------------------------------------------------------- write_summary

export type SummaryInput = {
  artistName: string;
  dealSummary: string;
  engineSummary: string;
  lines: { label: string; amount: number }[];
  totalToArtist: number;
  allowedNumbers: number[];
};
export type Summary = { summary: string };

export const writeSummary: TaskDef<SummaryInput, Summary> = {
  name: "write_summary",
  maxTokens: 500,
  prompt: (i) => ({
    system:
      "You explain a show settlement to the artist's tour manager (Drake) in plain English. Use only numbers that appear in the data. " +
      "Don't calculate new numbers. Reply with JSON only.",
    user: `Artist: ${i.artistName}\nDeal: ${i.dealSummary}\nSettlement lines:\n${i.lines
      .map((l) => `- ${l.label}: $${Math.round(l.amount).toLocaleString("en-US")}`)
      .join("\n")}\nTotal to artist: $${Math.round(i.totalToArtist).toLocaleString("en-US")}\n\nWrite 3 to 5 short sentences a tour manager can read on a phone. Reply {"summary": "..."}`,
  }),
  parse: (json) => {
    const s = asString(asObject(json).summary).trim();
    if (!s) throw new Error("Empty summary");
    return { summary: s };
  },
  check: (s, i) => ungroundedNumbers(s.summary, i.allowedNumbers).map((n) => `number not in the settlement: ${n}`),
  rules: (i) => ({ summary: i.engineSummary }),
};
