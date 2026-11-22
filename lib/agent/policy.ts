/**
 * What the agent may do alone, what it must ask about, and what it can never do.
 *
 * The rule: autonomy depends on whether an action can be undone and whether
 * it touches someone outside the venue. Reading, extracting, checking and
 * calculating are undoable and internal, so the agent does them alone.
 * Messages to the agent leave the building, so they're drafts. Money is
 * people-only, and that isn't a prompt instruction: the agent has no tool
 * that can approve a settlement or release a payout (see tools.ts).
 */

export type Autonomy = "auto" | "auto_if_checks_pass" | "draft_only" | "people_decide" | "people_only";

export type AgentAction =
  | "read_email"
  | "extract_terms"
  | "flag_two_readings"
  | "commit_terms"
  | "message_agent"
  | "compute_settlement"
  | "prepare_packet"
  | "answer_questions"
  | "decide_reading"
  | "release_payout";

export const AUTONOMY: { action: AgentAction; label: string; level: Autonomy; undoable: boolean; outside: boolean; why: string }[] = [
  { action: "read_email", label: "Read and sort the offer email", level: "auto", undoable: true, outside: false, why: "Internal and undoable." },
  { action: "extract_terms", label: "Extract the deal terms", level: "auto", undoable: true, outside: false, why: "A draft; every money field must cite the email." },
  { action: "flag_two_readings", label: "Flag terms with two readings", level: "auto", undoable: true, outside: false, why: "Flags are priced by the engine, not the model." },
  { action: "commit_terms", label: "Commit terms to the deal record", level: "auto_if_checks_pass", undoable: true, outside: false, why: "Alone only if every citation verifies, nothing is ambiguous, and the email matches the record. Otherwise the booker confirms." },
  { action: "message_agent", label: "Ask the artist's agent to clarify", level: "draft_only", undoable: false, outside: true, why: "It leaves the building, so the booker sends it." },
  { action: "compute_settlement", label: "Calculate the settlement", level: "auto", undoable: true, outside: false, why: "Deterministic engine. No model does arithmetic." },
  { action: "prepare_packet", label: "Prepare the packet and tour manager summary", level: "auto", undoable: true, outside: true, why: "Every number in the summary is checked against the engine first." },
  { action: "answer_questions", label: "Answer questions at the table", level: "auto", undoable: true, outside: true, why: "Read-only. What-ifs are computed by the engine." },
  { action: "decide_reading", label: "Decide a term with two readings", level: "people_decide", undoable: true, outside: true, why: "Both sides choose; the agent shows what each reading pays." },
  { action: "release_payout", label: "Approve the settlement and release the payout", level: "people_only", undoable: false, outside: true, why: "Money moves. Booker approves, tour manager accepts; then a rule releases it. The agent has no tool for this." },
];

export const AUTONOMY_LABEL: Record<Autonomy, string> = {
  auto: "Agent alone",
  auto_if_checks_pass: "Agent alone if checks pass",
  draft_only: "Draft only",
  people_decide: "People decide",
  people_only: "People only",
};

export function autonomyOf(action: AgentAction): Autonomy {
  return AUTONOMY.find((a) => a.action === action)!.level;
}

/** Whether the agent may commit the extracted terms without the booker. */
export function commitGate(args: {
  extractionProblems: string[];
  blockingFlags: number;
  recordMismatches: string[];
}): { autoCommit: boolean; reasons: string[] } {
  const reasons = [
    ...args.extractionProblems.map((p) => `Unverified: ${p}`),
    ...(args.blockingFlags ? [`${args.blockingFlags} term${args.blockingFlags === 1 ? "" : "s"} can be read two ways or changed after booking`] : []),
    ...args.recordMismatches.map((m) => `Email and deal record disagree: ${m}`),
  ];
  return { autoCommit: reasons.length === 0, reasons };
}
