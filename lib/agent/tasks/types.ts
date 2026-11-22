import type { TaskName } from "../routing";

/**
 * A task the agent can hand to a model. Each task owns its prompt, how to
 * read the reply, the deterministic checks on the reply, and a rules-only
 * implementation (the no-AI baseline and the last fallback).
 */
export type TaskDef<I, O> = {
  name: TaskName;
  maxTokens: number;
  prompt(input: I): { system: string; user: string };
  /** Turn the model's JSON into a typed value. Throw if the shape is wrong. */
  parse(json: unknown, input: I): O;
  /** Problems code can verify (e.g. a citation that isn't in the email). Non-empty → escalate if the route allows. */
  check(output: O, input: I): string[];
  /** Output too empty to use at all (e.g. no deal terms). The gateway moves down the chain. */
  isUnusable?(output: O): boolean;
  rules(input: I): O;
};

export const asString = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : String(v));

export function asNumber(v: unknown): number | null {
  if (v == null || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") {
    const m = v.replace(/,/g, "").match(/-?\d+(?:\.\d+)?\s*(k)?/i);
    if (!m) return null;
    const n = parseFloat(m[0]);
    return m[1] ? n * 1000 : n;
  }
  return null;
}

export function asObject(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("Expected a JSON object");
  return v as Record<string, unknown>;
}
