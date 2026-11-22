/**
 * The Deal Ledger agent.
 *
 * A workflow with an agent inside, not an open-ended loop: each show moves
 * through known steps, and models do the language work inside them. The
 * steps are known, which keeps the agent testable, cheap and predictable.
 *
 *   read email → extract terms → flag two readings → commit (gated)
 *   → draft a question to the agent → calculate (engine) → packet + summary
 *   → STOP: people approve; a rule releases the payout.
 */

import { format, parseISO } from "date-fns";
import { AUTONOMY_LABEL, autonomyOf, commitGate, type AgentAction, type Autonomy } from "./policy";
import { runTask, type CallEvent, type CallLog, type TaskRun } from "./router";
import type { ProfileName } from "./routing";
import type { ModelKey } from "./models";
import { classifyEmail, type ClassifyOutput } from "./tasks/classifyEmail";
import { extractTerms, MONEY_FIELDS, type CitedField, type DealTerms } from "./tasks/extractTerms";
import { findTwoReadings, ENGINE_KEY, READING_LABELS, type Flag } from "./tasks/findTwoReadings";
import { draftMessage, writeSummary, type Draft } from "./tasks/writing";
import { answerQuestion, type AssistantContext, type WhatIfChange } from "./tasks/answerQuestion";
import { computeSettlement, getShow, priceTwoReadings, type FlagPrice } from "./tools";
import { quoteAppears, numbersIn } from "./verify";
import type { FullSettlement, Readings, SettlementInput } from "@/lib/settlementEngine";
import { settleWithDecisions } from "@/lib/settlementEngine";

export type StepStatus = "done" | "needs_person" | "draft_ready" | "locked" | "skipped";

export type ModelUse = {
  model: ModelKey;
  escalated: boolean;
  fellBack: boolean;
  problems: string[];
  attempts: CallLog[];
  totals: TaskRun<unknown>["totals"];
};

export type AgentStep = {
  action: AgentAction;
  label: string;
  autonomy: Autonomy;
  autonomyLabel: string;
  status: StepStatus;
  summary: string;
  model?: ModelUse;
};

export type TermCheck = {
  field: CitedField;
  value: string | number | null;
  citation: string | null;
  verified: boolean;
  recordValue: string | number | null;
  matchesRecord: boolean;
};

export type PricedFlag = Flag & { label: string; verifiedQuote: boolean; price: FlagPrice | null };

export type QA = {
  question: string;
  answer: string;
  whatIf?: { description: string; oldTotal: number; newTotal: number };
  grounded: boolean;
  models: ModelUse[];
  askedAt: string;
};

export type AgentRun = {
  id: string;
  version: number;
  showId: string;
  artistName: string;
  showDate: string;
  profile: ProfileName;
  createdAt: string;
  email: { from: string; text: string };
  classification: ClassifyOutput;
  terms: DealTerms;
  termChecks: TermCheck[];
  flags: PricedFlag[];
  droppedFlags: number;
  /** Flags the model raised that failed a check, and why. Missing on runs saved before the checks existed. */
  droppedDetails?: { type: string; quote: string; reason: string; detail: string }[];
  gate: { autoCommit: boolean; reasons: string[] };
  termsStatus: "committed_by_agent" | "waiting_for_booker" | "confirmed_by_booker";
  draft: Draft | null;
  settlement: {
    totalToArtist: number;
    venueResult: number;
    dealSummary: string;
    lines: { label: string; amount: number }[];
    decisions: { key: string; title: string; impact: number }[];
    summary: string;
    summaryGrounded: boolean;
  };
  steps: AgentStep[];
  qa: QA[];
  approvals: { booker?: { by: string; at: string }; tourManager?: { by: string; at: string } };
  payout: { released: boolean; at?: string; note?: string };
  totals: { inputTokens: number; outputTokens: number; latencyMs: number; costUsd: number; modelCalls: number };
};

/** The steps every run walks through, in order. The UI shows them all from the start. */
export const PLAN: { action: AgentAction; label: string }[] = [
  { action: "read_email", label: "Read and sort the email" },
  { action: "extract_terms", label: "Extract the deal terms" },
  { action: "flag_two_readings", label: "Flag terms with two readings" },
  { action: "commit_terms", label: "Commit terms to the deal record" },
  { action: "message_agent", label: "Ask Drake to clarify" },
  { action: "compute_settlement", label: "Calculate the settlement" },
  { action: "prepare_packet", label: "Prepare the packet and Drake's summary" },
  { action: "release_payout", label: "Approve the settlement and release the payout" },
];

/** Live progress, streamed to the page while a run is in flight. */
export type AgentEvent =
  | { type: "plan"; profile: ProfileName; steps: { action: AgentAction; label: string; autonomy: Autonomy; autonomyLabel: string }[] }
  | { type: "step_start"; action: AgentAction; label: string; at: number }
  | { type: "call"; action: AgentAction; event: CallEvent; at: number }
  | { type: "step_done"; step: AgentStep; at: number }
  | { type: "done"; runId: string; totals: AgentRun["totals"]; at: number }
  | { type: "error"; message: string; at: number };

const money = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;

function modelUse<O>(r: TaskRun<O>): ModelUse {
  return { model: r.model, escalated: r.escalated, fellBack: r.fellBack, problems: r.problems, attempts: r.attempts, totals: r.totals };
}

function step(action: AgentAction, label: string, status: StepStatus, summary: string, model?: ModelUse): AgentStep {
  const autonomy = autonomyOf(action);
  return { action, label, autonomy, autonomyLabel: AUTONOMY_LABEL[autonomy], status, summary, model };
}

/** Every number a model is allowed to say: engine output, deal terms, the email. */
function allowedNumbers(full: FullSettlement, input: SettlementInput, email: string): number[] {
  const nums: number[] = [];
  const push = (n: number | null | undefined) => {
    if (typeof n === "number" && Number.isFinite(n)) nums.push(n);
  };
  for (const v of Object.values(full)) if (typeof v === "number") push(v);
  full.lines.forEach((l) => push(Math.abs(l.amount)));
  full.decisions.forEach((d) => d.options.forEach((o) => push(o.totalToArtist)));
  full.decisions.forEach((d) => push(d.impact));
  full.bonuses.forEach((b) => push(b.amount));
  const d = input.deal;
  [d.guaranteeAmount, d.expenseCap, d.hospitalityCap].forEach(push);
  if (d.percentage != null) push(d.percentage);
  input.recoups.forEach((r) => push(r.amount));
  input.expenses.forEach((e) => push(e.amount));
  numbersIn(email).forEach((n) => push(n.percent ? n.value / 100 : n.value));
  push(1); // "100%" (door deals, walkouts)
  return nums;
}

function recordValue(field: CitedField, input: SettlementInput): string | number | null {
  const d = input.deal;
  switch (field) {
    case "dealType":
      return d.dealType;
    case "guaranteeAmount":
      return d.guaranteeAmount;
    case "percentage":
      return d.percentage;
    case "percentageBasis":
      return d.percentageBasis;
    case "expenseCap":
      return d.expenseCap;
    case "hospitalityCap":
      return d.hospitalityCap;
  }
}

function same(a: string | number | null, b: string | number | null): boolean {
  if (a == null || b == null) return a == b;
  if (typeof a === "number" && typeof b === "number") return Math.abs(a - b) < (a < 1 ? 0.005 : 1);
  return String(a) === String(b);
}

export async function runAgent(
  showId: string,
  emailText: string,
  emailFrom: string,
  agentFirstName: string,
  profile: ProfileName,
  onEvent?: (e: AgentEvent) => void,
): Promise<AgentRun> {
  const ctx = await getShow(showId);
  if (!ctx) throw new Error(`Show ${showId} has no deal`);
  const { data, input } = ctx;
  const artistName = data.artist?.name ?? "the artist";
  const showDate = format(parseISO(data.show.date), "MMMM d, yyyy");
  const steps: AgentStep[] = [];

  // Live progress: purely observational, so a listener can never change a run.
  const emit = (e: AgentEvent) => {
    try {
      onEvent?.(e);
    } catch {
      // ignore
    }
  };
  emit({
    type: "plan",
    profile,
    steps: PLAN.map((p) => ({ ...p, autonomy: autonomyOf(p.action), autonomyLabel: AUTONOMY_LABEL[autonomyOf(p.action)] })),
  });
  let current: AgentAction = "read_email";
  const begin = (action: AgentAction) => {
    current = action;
    emit({ type: "step_start", action, label: PLAN.find((p) => p.action === action)?.label ?? action, at: Date.now() });
  };
  const record = (s: AgentStep) => {
    steps.push(s);
    emit({ type: "step_done", step: s, at: Date.now() });
  };
  const opts = { profile, onCall: (event: CallEvent) => emit({ type: "call", action: current, event, at: Date.now() }) };

  // 1. Read and sort the email.
  begin("read_email");
  const cls = await runTask(classifyEmail, { email: emailText }, opts);
  record(step("read_email", "Read and sort the email", "done", `Sorted as "${cls.output.kind}": ${cls.output.reason}`, modelUse(cls)));

  // 2. Extract the terms, each with a citation that code verifies.
  begin("extract_terms");
  const ext = await runTask(extractTerms, { email: emailText }, opts);
  const terms = ext.output;
  const termChecks: TermCheck[] = (["dealType", "guaranteeAmount", "percentage", "percentageBasis", "expenseCap", "hospitalityCap"] as CitedField[]).map((field) => {
    const value = terms[field] as string | number | null;
    const citation = terms.citations[field] ?? null;
    const problem = ext.problems.find((p) => p.startsWith(`${field}:`));
    const rv = recordValue(field, input);
    return {
      field,
      value,
      citation,
      verified: value == null ? true : field === "percentageBasis" ? true : !problem && !!citation && quoteAppears(emailText, citation),
      recordValue: rv,
      matchesRecord: same(value, rv),
    };
  });
  const verifiedCount = termChecks.filter((t) => t.value != null && t.verified).length;
  const filled = termChecks.filter((t) => t.value != null).length;
  record(
    step(
      "extract_terms",
      "Extract the deal terms",
      "done",
      `${filled} terms found; ${verifiedCount} of ${filled} citations verified against the email.${ext.escalated ? " Escalated after a failed check." : ""}`,
      modelUse(ext),
    ),
  );

  // 3. Flag terms with two readings. Code checks every flag (lib/agent/tasks/flagChecks.ts);
  //    the engine prices each one it can, and flags that move money come first.
  begin("flag_two_readings");
  const rd = await runTask(findTwoReadings, { email: emailText }, opts);
  const impact = (f: PricedFlag) => Math.max(f.price?.actual.impact ?? 0, f.price?.atCap?.impact ?? 0);
  const kept: PricedFlag[] = rd.output.flags
    .map((f) => {
      const key = ENGINE_KEY[f.type];
      return {
        ...f,
        label: READING_LABELS[f.type],
        verifiedQuote: quoteAppears(emailText, f.quote),
        price: key ? priceTwoReadings(input, key, terms.recoups) : null,
      };
    })
    .sort((a, b) => impact(b) - impact(a));
  const droppedDetails = rd.output.dropped.map((d) => ({ type: d.type, quote: d.quote, reason: d.reason, detail: d.detail }));
  const dropped = droppedDetails.length;
  const priced = kept.filter((f) => impact(f) >= 1);
  const dropNote = dropped
    ? ` ${dropped} dropped by the checks (${[...new Set(droppedDetails.map((d) => d.detail))].join("; ")}).`
    : "";
  record(
    step(
      "flag_two_readings",
      "Flag terms with two readings",
      "done",
      kept.length
        ? `${kept.length} flagged${priced.length ? `; the engine shows ${priced.length} change${priced.length === 1 ? "s" : ""} the payout` : ""}.${dropNote}`
        : `No ambiguous terms found.${dropNote}`,
      modelUse(rd),
    ),
  );

  // 4. Commit gate.
  begin("commit_terms");
  const mismatches = termChecks
    .filter((t) => MONEY_FIELDS.includes(t.field) && t.value != null && t.recordValue != null && !t.matchesRecord)
    .map((t) => `${t.field} (email ${t.value}, record ${t.recordValue})`);
  const gate = commitGate({ extractionProblems: ext.problems, blockingFlags: kept.length, recordMismatches: mismatches });
  record(
    step(
      "commit_terms",
      "Commit terms to the deal record",
      gate.autoCommit ? "done" : "needs_person",
      gate.autoCommit ? "Every check passed, so Backstage committed the terms on its own." : `Waiting for Ethan: ${gate.reasons.join("; ")}.`,
    ),
  );

  // 5. Draft a question to the agent (never sent by the agent).
  begin("message_agent");
  const full = computeSettlement(input);
  const allowed = allowedNumbers(full, input, emailText);
  let draft: Draft | null = null;
  if (kept.length) {
    const dr = await runTask(
      draftMessage,
      {
        artistName,
        showDate,
        agentFirstName,
        bookerName: "Ethan",
        venueName: data.venue?.name ?? "The Crescent",
        flags: kept,
        allowedNumbers: allowed,
      },
      opts,
    );
    draft = dr.problems.length ? draftMessage.rules({ artistName, showDate, agentFirstName, bookerName: "Ethan", venueName: data.venue?.name ?? "The Crescent", flags: kept, allowedNumbers: allowed }) : dr.output;
    record(step("message_agent", "Ask Drake to clarify", "draft_ready", `Draft ready for Ethan to send.${dr.problems.length ? " The model's draft failed the number check, so the template was used." : ""}`, modelUse(dr)));
  } else {
    record(step("message_agent", "Ask Drake to clarify", "skipped", "Nothing to clarify."));
  }

  // 6. Calculate: deterministic engine, called as a tool.
  begin("compute_settlement");
  record(
    step(
      "compute_settlement",
      "Calculate the settlement",
      "done",
      `Engine: ${money(full.totalToArtist)} to the artist${full.decisions.length ? `, with ${full.decisions.length} decision${full.decisions.length === 1 ? "" : "s"} for the table` : ""}.`,
    ),
  );

  // 7. Packet and summary, with every number checked against the engine.
  begin("prepare_packet");
  const lines = full.lines.filter((l) => l.kind !== "info").map((l) => ({ label: l.label, amount: l.amount }));
  const sm = await runTask(
    writeSummary,
    { artistName, dealSummary: full.dealSummary, engineSummary: full.summary, lines, totalToArtist: full.totalToArtist, allowedNumbers: allowed },
    opts,
  );
  const summaryGrounded = sm.problems.length === 0;
  record(
    step(
      "prepare_packet",
      "Prepare the packet and Drake's summary",
      "done",
      summaryGrounded ? "Summary written; every number matches the engine." : `Model summary had unverified numbers (${sm.problems.join(", ")}); used the engine's own summary instead.`,
      modelUse(sm),
    ),
  );

  // 8. People only.
  begin("release_payout");
  record(step("release_payout", "Approve the settlement and release the payout", "locked", "Locked until Ethan approves and Drake accepts. Backstage has no tool for this."));

  const modelSteps = [cls, ext, rd, sm];
  const totals = modelSteps.reduce(
    (t, r) => ({
      inputTokens: t.inputTokens + r.totals.inputTokens,
      outputTokens: t.outputTokens + r.totals.outputTokens,
      latencyMs: t.latencyMs + r.totals.latencyMs,
      costUsd: t.costUsd + r.totals.costUsd,
      modelCalls: t.modelCalls + r.attempts.filter((a) => a.status !== "skipped" && a.model !== "rules").length,
    }),
    { inputTokens: 0, outputTokens: 0, latencyMs: 0, costUsd: 0, modelCalls: 0 },
  );
  const draftStep = steps.find((s) => s.action === "message_agent")?.model;
  if (draftStep) {
    totals.inputTokens += draftStep.totals.inputTokens;
    totals.outputTokens += draftStep.totals.outputTokens;
    totals.latencyMs += draftStep.totals.latencyMs;
    totals.costUsd += draftStep.totals.costUsd;
    totals.modelCalls += draftStep.attempts.filter((a) => a.status !== "skipped" && a.model !== "rules").length;
  }

  return {
    id: Date.now().toString(36),
    version: 1,
    showId,
    artistName,
    showDate,
    profile,
    createdAt: new Date().toISOString(),
    email: { from: emailFrom, text: emailText },
    classification: cls.output,
    terms,
    termChecks,
    flags: kept,
    droppedFlags: dropped,
    droppedDetails,
    gate,
    termsStatus: gate.autoCommit ? "committed_by_agent" : "waiting_for_booker",
    draft,
    settlement: {
      totalToArtist: full.totalToArtist,
      venueResult: full.venueResult,
      dealSummary: full.dealSummary,
      lines,
      decisions: full.decisions.map((d) => ({ key: d.key, title: d.title, impact: d.impact })),
      summary: summaryGrounded ? sm.output.summary : full.summary,
      summaryGrounded,
    },
    steps,
    qa: [],
    approvals: {},
    payout: { released: false },
    totals,
  };
}

function applyWhatIf(
  input: SettlementInput,
  change: WhatIfChange,
  base: Readings,
  context: AssistantContext,
): { input: SettlementInput; readings: Readings; description: string } {
  if (change.kind === "comps_count") {
    return {
      input: { ...input, comps: input.comps.map((c) => ({ ...c, countsTowardGross: change.value })) },
      readings: base,
      description: change.value ? "every comp counted toward gross" : "no comps counted toward gross",
    };
  }
  const option = context.decisions.find((d) => d.key === change.key)?.options.find((o) => o.value === change.value);
  return {
    input,
    readings: { ...base, [change.key]: change.value } as Readings,
    description: `the reading were "${option?.label ?? change.value}"`,
  };
}

/** The assistant at the table: answers from the engine, and asks the engine for what-ifs. */
export async function askAssistant(run: AgentRun, question: string): Promise<QA> {
  const ctx = await getShow(run.showId);
  if (!ctx) throw new Error("Show not found");
  const full = settleWithDecisions(ctx.input);
  const context: AssistantContext = {
    dealSummary: full.dealSummary,
    totalToArtist: full.totalToArtist,
    lines: full.lines.filter((l) => l.kind !== "info").map((l) => ({ label: l.label, amount: l.amount })),
    decisions: full.decisions.map((d) => ({ key: d.key, title: d.title, chosen: d.chosen, options: d.options.map((o) => ({ value: o.value, label: o.label, totalToArtist: o.totalToArtist })) })),
    compsCount: ctx.input.comps.reduce((s, c) => s + c.count, 0),
  };
  const allowed = allowedNumbers(full, ctx.input, run.email.text);
  const opts = { profile: run.profile };

  const first = await runTask(answerQuestion, { question, context, allowedNumbers: allowed }, opts);
  const models = [modelUse(first)];
  if (first.output.action === "answer") {
    return { question, answer: first.output.answer, grounded: first.problems.length === 0, models, askedAt: new Date().toISOString() };
  }

  // The model asked the engine for a what-if. The engine computes; the model explains.
  const w = applyWhatIf(ctx.input, first.output.change, full.readings, context);
  const after = settleWithDecisions(w.input, w.readings);
  const whatIf = { description: w.description, oldTotal: full.totalToArtist, newTotal: after.totalToArtist };
  const second = await runTask(answerQuestion, { question, context, whatIf, allowedNumbers: [...allowed, after.totalToArtist, Math.abs(after.totalToArtist - full.totalToArtist)] }, opts);
  models.push(modelUse(second));
  const answer = second.output.action === "answer" && second.problems.length === 0 ? second.output.answer : answerQuestion.rules({ question, context, whatIf, allowedNumbers: allowed });
  return {
    question,
    answer: typeof answer === "string" ? answer : answer.action === "answer" ? answer.answer : "",
    whatIf,
    grounded: true,
    models,
    askedAt: new Date().toISOString(),
  };
}
