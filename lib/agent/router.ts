/**
 * The model gateway. Every model call in the agent goes through runTask():
 *
 *   1. Look up the task's route (primary, escalation, fallbacks).
 *   2. Skip models that can't run right now (no key, local server down).
 *   3. Call the model, read its JSON (one retry if it isn't valid).
 *   4. Run the task's deterministic checks. If they fail and the route has an
 *      escalation, try the stronger model.
 *   5. Log every attempt: model, tokens in/out, latency, cost.
 *
 * Swapping a model never touches the tasks: change the routing table.
 */

import { availability, MODELS, type ModelKey } from "./models";
import { callModel } from "./providers";
import { extractJson } from "./json";
import { resolveRoute, type ProfileName, type Route, type TaskName } from "./routing";
import type { TaskDef } from "./tasks/types";

export type CallLog = {
  model: ModelKey;
  status: "ok" | "invalid" | "error" | "skipped";
  reason?: string;
  problems?: string[];
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  costUsd: number;
  estimatedTokens?: boolean;
  retried?: boolean;
};

export type TaskRun<O> = {
  task: TaskName;
  profile: ProfileName;
  route: Route;
  output: O;
  model: ModelKey;
  problems: string[];
  escalated: boolean;
  fellBack: boolean;
  attempts: CallLog[];
  totals: { inputTokens: number; outputTokens: number; latencyMs: number; costUsd: number };
};

export class TaskFailed extends Error {
  constructor(message: string, public attempts: CallLog[]) {
    super(message);
  }
}

const MAX_PROMPT_TOKENS = 90_000; // stay under Haiku 5.5's 100K price tier

type Exec<O> = { output: O; problems: string[]; log: CallLog };

async function execute<I, O>(def: TaskDef<I, O>, model: ModelKey, input: I): Promise<Exec<O>> {
  if (MODELS[model].provider === "rules") {
    const t0 = Date.now();
    const output = def.rules(input);
    const problems = def.check(output, input);
    return {
      output,
      problems,
      log: { model, status: problems.length ? "invalid" : "ok", problems, inputTokens: 0, outputTokens: 0, latencyMs: Date.now() - t0, costUsd: 0 },
    };
  }

  const p = def.prompt(input);
  if ((p.system.length + p.user.length) / 4 > MAX_PROMPT_TOKENS) throw new Error("Prompt too large for this task's token cap");
  const messages: { role: "user" | "assistant"; content: string }[] = [{ role: "user", content: p.user }];
  const log: CallLog = { model, status: "ok", inputTokens: 0, outputTokens: 0, latencyMs: 0, costUsd: 0 };
  const add = (r: Awaited<ReturnType<typeof callModel>>) => {
    log.inputTokens += r.inputTokens;
    log.outputTokens += r.outputTokens;
    log.latencyMs += r.latencyMs;
    log.costUsd += r.costUsd;
    log.estimatedTokens = log.estimatedTokens || r.estimatedTokens;
  };

  let reply = await callModel(model, { system: p.system, messages, maxTokens: def.maxTokens, json: true });
  add(reply);
  let output: O;
  try {
    output = def.parse(extractJson(reply.text), input);
  } catch (err) {
    log.retried = true;
    messages.push({ role: "assistant", content: reply.text || "(empty)" });
    messages.push({ role: "user", content: `That reply wasn't usable (${(err as Error).message}). Reply with the JSON object only.` });
    reply = await callModel(model, { system: p.system, messages, maxTokens: def.maxTokens, json: true });
    add(reply);
    try {
      output = def.parse(extractJson(reply.text), input);
    } catch (err2) {
      throw new TaskFailed(`Unusable reply from ${MODELS[model].label}: ${(err2 as Error).message}`, [{ ...log, status: "error", reason: (err2 as Error).message }]);
    }
  }
  const problems = def.check(output, input);
  log.status = problems.length ? "invalid" : "ok";
  log.problems = problems;
  return { output, problems, log };
}

export async function runTask<I, O>(
  def: TaskDef<I, O>,
  input: I,
  opts: { profile: ProfileName; onlyModel?: ModelKey },
): Promise<TaskRun<O>> {
  const route = resolveRoute(def.name, opts.profile);
  const chain = Array.from(new Set(opts.onlyModel ? [opts.onlyModel] : [route.primary, ...route.fallbacks]));
  if (!opts.onlyModel && !chain.includes("rules")) chain.push("rules");
  const attempts: CallLog[] = [];

  for (const model of chain) {
    const av = availability(model);
    if (!av.ok) {
      attempts.push({ model, status: "skipped", reason: av.reason, inputTokens: 0, outputTokens: 0, latencyMs: 0, costUsd: 0 });
      continue;
    }
    let result: Exec<O>;
    try {
      result = await execute(def, model, input);
    } catch (err) {
      if (err instanceof TaskFailed) attempts.push(...err.attempts);
      else attempts.push({ model, status: "error", reason: (err as Error).message, inputTokens: 0, outputTokens: 0, latencyMs: 0, costUsd: 0 });
      continue;
    }
    attempts.push(result.log);
    let used = model;
    let escalated = false;

    const esc = route.escalate;
    if (result.problems.length && !opts.onlyModel && esc && model === route.primary && esc !== model && availability(esc).ok) {
      try {
        const e = await execute(def, esc, input);
        attempts.push(e.log);
        if (e.problems.length <= result.problems.length) {
          result = e;
          used = esc;
          escalated = true;
        }
      } catch (err) {
        if (err instanceof TaskFailed) attempts.push(...err.attempts);
        else attempts.push({ model: esc, status: "error", reason: (err as Error).message, inputTokens: 0, outputTokens: 0, latencyMs: 0, costUsd: 0 });
      }
    }

    return {
      task: def.name,
      profile: opts.profile,
      route,
      output: result.output,
      model: used,
      problems: result.problems,
      escalated,
      fellBack: model !== chain[0],
      attempts,
      totals: attempts.reduce(
        (t, a) => ({
          inputTokens: t.inputTokens + a.inputTokens,
          outputTokens: t.outputTokens + a.outputTokens,
          latencyMs: t.latencyMs + a.latencyMs,
          costUsd: t.costUsd + a.costUsd,
        }),
        { inputTokens: 0, outputTokens: 0, latencyMs: 0, costUsd: 0 },
      ),
    };
  }
  throw new TaskFailed(`No model could run ${def.name}`, attempts);
}
