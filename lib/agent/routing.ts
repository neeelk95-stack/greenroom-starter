/**
 * The routing table: which model runs which task.
 *
 * Each task has a primary model, an optional escalation (used when the
 * primary's output fails validation, e.g. a money field without a verified
 * citation) and a fallback chain (used when a model can't be reached).
 * The chain always ends in "rules", so the agent still works offline with no
 * model at all.
 *
 * Switching models is a config change:
 *   AGENT_PROFILE=local|private-hybrid|mixed|haiku|rules
 *   AGENT_ROUTE_find_two_readings=sonnet-5.5     (override one task)
 */

import { isModelKey, type ModelKey } from "./models";

export type TaskName =
  | "classify_email"
  | "extract_terms"
  | "find_two_readings"
  | "draft_message"
  | "write_summary"
  | "answer_question";

export const TASKS: { name: TaskName; label: string; why: string }[] = [
  { name: "classify_email", label: "Sort inbound email", why: "Simple classification. Cheapest model that passes." },
  { name: "extract_terms", label: "Extract deal terms", why: "Copy-and-structure work with a citation per field. Escalate when a citation fails." },
  { name: "find_two_readings", label: "Find terms with two readings", why: "The reasoning step. A miss becomes a dispute, so it gets the strongest model the data rules allow." },
  { name: "draft_message", label: "Draft a question to the agent", why: "Short writing from known facts. Draft only; a person sends it." },
  { name: "write_summary", label: "Plain-English summary for the tour manager", why: "Every number is checked against the engine before it's shown." },
  { name: "answer_question", label: "Answer questions at the table", why: "People are waiting, so it needs a fast model. What-ifs are computed by the engine." },
];

export type Route = { primary: ModelKey; escalate?: ModelKey; fallbacks: ModelKey[] };
export type ProfileName = "local" | "private-hybrid" | "mixed" | "haiku" | "rules";

const all = (r: Route): Record<TaskName, Route> =>
  Object.fromEntries(TASKS.map((t) => [t.name, r])) as Record<TaskName, Route>;

export const PROFILES: Record<ProfileName, { label: string; description: string; routes: Record<TaskName, Route> }> = {
  local: {
    label: "Local only (Gemma 4 12B)",
    description: "Everything runs on the laptop. Free, offline, private. Falls back to rules if the local model isn't running.",
    routes: all({ primary: "gemma-local", fallbacks: ["rules"] }),
  },
  "private-hybrid": {
    label: "Private hybrid",
    description: "Simple steps on local Gemma; only the reasoning step goes to Sonnet 5.5.",
    routes: {
      ...all({ primary: "gemma-local", escalate: "haiku-5.5", fallbacks: ["haiku-5.5", "rules"] }),
      find_two_readings: { primary: "sonnet-5.5", fallbacks: ["gpt-6.1-sol", "gemma-local", "rules"] },
    },
  },
  mixed: {
    label: "Production design (Haiku + Sonnet)",
    description: "Haiku 5.5 for simple steps, Sonnet 5.5 for the reasoning step, OpenAI as the outage fallback, rules last.",
    routes: {
      classify_email: { primary: "haiku-5.5", fallbacks: ["gpt-6-luna", "gemma-local", "rules"] },
      extract_terms: { primary: "haiku-5.5", escalate: "sonnet-5.5", fallbacks: ["gpt-6-luna", "gemma-local", "rules"] },
      find_two_readings: { primary: "sonnet-5.5", fallbacks: ["gpt-6.1-sol", "gemma-local", "rules"] },
      draft_message: { primary: "haiku-5.5", fallbacks: ["gpt-6-luna", "gemma-local", "rules"] },
      write_summary: { primary: "haiku-5.5", fallbacks: ["gpt-6-luna", "gemma-local", "rules"] },
      answer_question: { primary: "haiku-5.5", escalate: "sonnet-5.5", fallbacks: ["gpt-6-luna", "gemma-local", "rules"] },
    },
  },
  haiku: {
    label: "Haiku 5.5 only",
    description: "Cheapest cloud setup: one small model for every step.",
    routes: all({ primary: "haiku-5.5", fallbacks: ["rules"] }),
  },
  rules: {
    label: "Rules only (no AI)",
    description: "The deterministic v1. Free, offline, the baseline.",
    routes: all({ primary: "rules", fallbacks: [] }),
  },
};

export function isProfile(p: string | undefined | null): p is ProfileName {
  return !!p && p in PROFILES;
}

export function defaultProfile(): ProfileName {
  const p = process.env.AGENT_PROFILE;
  return isProfile(p) ? p : "local";
}

/** The route for a task under a profile, with any AGENT_ROUTE_<task> override applied. */
export function resolveRoute(task: TaskName, profile: ProfileName): Route {
  const base = PROFILES[profile].routes[task];
  const override = process.env[`AGENT_ROUTE_${task}`]?.trim();
  if (override && isModelKey(override)) {
    return { primary: override, fallbacks: [...base.fallbacks.filter((m) => m !== override)] };
  }
  return base;
}
