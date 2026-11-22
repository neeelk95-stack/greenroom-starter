"use client";

import { useEffect, useState } from "react";
import { CircleCheck, Circle, CircleAlert, CircleMinus, Loader2, LockKeyhole, PenLine, Cpu, ArrowRight } from "lucide-react";
import type { AgentEvent, AgentStep } from "@/lib/agent/agent";
import type { Autonomy } from "@/lib/agent/policy";
import { cn } from "@/lib/utils";
import { AGENT_NAME } from "@/components/agent/Backstage";

export type ModelLabels = Record<string, { label: string; local: boolean }>;

type CallStatus = "running" | "ok" | "invalid" | "error" | "skipped";
export type LiveCall = {
  model: string;
  why: "primary" | "fallback" | "escalation" | "skip";
  status: CallStatus;
  startedAt: number;
  latencyMs?: number;
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  reason?: string;
};
export type LiveStep = {
  action: string;
  label: string;
  autonomy: Autonomy;
  autonomyLabel: string;
  state: "pending" | "running" | "finished";
  status?: AgentStep["status"];
  summary?: string;
  calls: LiveCall[];
  startedAt?: number;
  endedAt?: number;
};
export type LiveState = {
  profileLabel: string;
  steps: LiveStep[];
  startedAt: number;
  endedAt?: number;
  error?: string;
  runId?: string;
};

/** Pure reducer: one streamed event in, the next state out. */
export function applyEvent(s: LiveState, e: AgentEvent): LiveState {
  const update = (action: string, fn: (st: LiveStep) => LiveStep) => ({
    ...s,
    steps: s.steps.map((st) => (st.action === action ? fn(st) : st)),
  });
  switch (e.type) {
    case "plan":
      return { ...s, steps: e.steps.map((p) => ({ ...p, state: "pending" as const, calls: [] })) };
    case "step_start":
      return update(e.action, (st) => ({ ...st, state: "running", startedAt: e.at }));
    case "call": {
      const ev = e.event;
      return update(e.action, (st) => {
        const calls = [...st.calls];
        if (ev.phase === "start") {
          calls.push({ model: ev.model, why: ev.why, status: "running", startedAt: e.at });
        } else if (ev.phase === "skip") {
          calls.push({ model: ev.model, why: "skip", status: "skipped", startedAt: e.at, reason: ev.reason });
        } else {
          const log = ev.log;
          let i = -1;
          for (let k = calls.length - 1; k >= 0; k--) {
            if (calls[k].model === log.model && (calls[k].status === "running" || log.status === "invalid")) {
              i = k;
              break;
            }
          }
          const done: Partial<LiveCall> = {
            status: log.status as CallStatus,
            latencyMs: log.latencyMs,
            costUsd: log.costUsd,
            inputTokens: log.inputTokens,
            outputTokens: log.outputTokens,
            reason: log.reason ?? (ev.problems?.length ? ev.problems.join("; ") : undefined),
          };
          if (i >= 0) calls[i] = { ...calls[i], ...done };
          else calls.push({ model: log.model, why: "primary", startedAt: e.at, ...done } as LiveCall);
        }
        return { ...st, calls };
      });
    }
    case "step_done":
      return update(e.step.action, (st) => ({ ...st, state: "finished", status: e.step.status, summary: e.step.summary, endedAt: e.at }));
    case "done":
      return { ...s, endedAt: e.at, runId: e.runId };
    case "error":
      return { ...s, endedAt: e.at, error: e.message };
  }
}

const AUTONOMY_STYLE: Record<Autonomy, string> = {
  auto: "bg-brand-50 text-brand-800 ring-brand-200/80",
  auto_if_checks_pass: "bg-sky-50 text-sky-800 ring-sky-200/80",
  draft_only: "bg-amber-50 text-amber-800 ring-amber-200/80",
  people_decide: "bg-rose-50 text-rose-800 ring-rose-200/80",
  people_only: "bg-rose-50 text-rose-800 ring-rose-200/80",
};

const secs = (ms: number) => `${(Math.max(0, ms) / 1000).toFixed(1)} s`;
const usd = (n: number) => (n === 0 ? "$0" : n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(3)}`);

function StepIcon({ step }: { step: LiveStep }) {
  const cls = "h-[18px] w-[18px]";
  if (step.state === "pending") return <Circle className={cn(cls, "text-ink-200")} />;
  if (step.state === "running") return <Loader2 className={cn(cls, "text-brand-600 animate-spin")} />;
  switch (step.status) {
    case "needs_person":
      return <CircleAlert className={cn(cls, "text-amber-700")} />;
    case "draft_ready":
      return <PenLine className={cn(cls, "text-amber-700")} />;
    case "locked":
      return <LockKeyhole className={cn(cls, "text-rose-700")} />;
    case "skipped":
      return <CircleMinus className={cn(cls, "text-ink-300")} />;
    default:
      return <CircleCheck className={cn(cls, "text-brand-600")} />;
  }
}

function CallChip({ call, labels, now }: { call: LiveCall; labels: ModelLabels; now: number }) {
  const spec = labels[call.model] ?? { label: call.model, local: false };
  const label = call.model === "rules" ? "Rules (no AI)" : spec.label;
  const base = "inline-flex items-center gap-1 px-2 py-0.5 rounded-md ring-1 ring-inset text-[11px]";
  if (call.status === "running") {
    return (
      <span className={cn(base, "bg-white text-ink-700 ring-brand-300")}>
        <span className="h-1.5 w-1.5 rounded-full bg-brand-500 animate-pulse" />
        {call.why === "escalation" && <span className="text-amber-700">escalating to</span>}
        {call.why === "fallback" && <span className="text-amber-700">falling back to</span>}
        <span className="font-medium">{label}</span>
        <span className="tabular text-ink-400">{secs(now - call.startedAt)}</span>
      </span>
    );
  }
  if (call.status === "skipped") {
    return (
      <span className={cn(base, "bg-ink-50 text-ink-400 ring-ink-200/70")} title={call.reason}>
        {label} skipped{call.reason ? `: ${call.reason}` : ""}
      </span>
    );
  }
  const ok = call.status === "ok";
  return (
    <span
      className={cn(base, ok ? (spec.local ? "bg-brand-50 text-brand-800 ring-brand-200/80" : "bg-sky-50 text-sky-800 ring-sky-200/80") : "bg-amber-50 text-amber-800 ring-amber-200/80")}
      title={call.reason}
    >
      {call.why === "escalation" && <ArrowRight className="h-3 w-3" />}
      <span className="font-medium">{label}</span>
      {call.why === "fallback" && <span className="opacity-70">fallback</span>}
      {!ok && <span>{call.status === "invalid" ? "failed a check" : "error"}</span>}
      <span className="tabular opacity-70">
        {call.latencyMs != null ? secs(call.latencyMs) : ""}
        {call.costUsd != null && call.model !== "rules" ? ` · ${usd(call.costUsd)}` : ""}
      </span>
    </span>
  );
}

export function LiveRun({ state, labels }: { state: LiveState; labels: ModelLabels }) {
  const running = !state.endedAt;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(t);
  }, [running]);

  const calls = state.steps.flatMap((s) => s.calls).filter((c) => c.status !== "skipped" && c.model !== "rules");
  const cost = calls.reduce((t, c) => t + (c.costUsd ?? 0), 0);
  const elapsed = (state.endedAt ?? now) - state.startedAt;
  const current = state.steps.find((s) => s.state === "running");

  return (
    <div className="rounded-xl ring-1 ring-inset ring-ink-200/80 bg-white overflow-hidden">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 border-b border-ink-100 bg-canvas-soft">
        <span className="flex items-center gap-2 text-[12.5px] font-semibold text-ink-900">
          {running ? <span className="h-2 w-2 rounded-full bg-brand-500 animate-pulse" /> : <span className="h-2 w-2 rounded-full bg-ink-300" />}
          {running ? `${AGENT_NAME} is working` : state.error ? "Run stopped" : "Run finished"}
        </span>
        <span className="text-[11.5px] text-ink-500">{state.profileLabel}</span>
        <span className="ml-auto text-[11.5px] text-ink-500 tabular">
          {secs(elapsed)} · {calls.length} model call{calls.length === 1 ? "" : "s"} · {usd(cost)}
        </span>
      </div>

      {state.steps.length === 0 && !state.error && (
        <div className="px-4 py-4 text-[12.5px] text-ink-500 flex items-center gap-2">
          <Loader2 className="h-4 w-4 animate-spin text-brand-600" /> Loading the show and the deal record…
        </div>
      )}

      <ol className="divide-y divide-ink-100">
        {state.steps.map((s) => {
          const modelCalls = s.calls;
          const inCode = s.state !== "pending" && modelCalls.length === 0;
          return (
            <li
              key={s.action}
              className={cn(
                "flex gap-3 px-4 py-3 transition-colors duration-300",
                s.state === "running" && "bg-brand-50/50",
                s.state === "pending" && "opacity-55",
              )}
            >
              <div className="pt-0.5">
                <StepIcon step={s} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className={cn("text-[13px] font-medium", s.state === "pending" ? "text-ink-500" : "text-ink-900")}>{s.label}</span>
                  <span className={cn("px-1.5 py-0.5 rounded text-[10.5px] ring-1 ring-inset", AUTONOMY_STYLE[s.autonomy])}>{s.autonomyLabel}</span>
                  {(s.startedAt || s.endedAt) && (
                    <span className="ml-auto text-[11px] text-ink-400 tabular">{secs((s.endedAt ?? now) - (s.startedAt ?? now))}</span>
                  )}
                </div>
                {modelCalls.length > 0 && (
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    {modelCalls.map((c, i) => (
                      <CallChip key={i} call={c} labels={labels} now={now} />
                    ))}
                  </div>
                )}
                {inCode && (
                  <div className="mt-1 flex items-center gap-1.5 text-[11px] text-ink-400">
                    <Cpu className="h-3 w-3" /> {s.action === "release_payout" ? "No tool on the agent's side" : "Code, no model"}
                  </div>
                )}
                {s.summary && <div className="mt-1.5 text-[12px] text-ink-600 leading-snug">{s.summary}</div>}
                {s.state === "running" && modelCalls.length === 0 && !inCode && (
                  <div className="mt-1 text-[11.5px] text-ink-400">Starting…</div>
                )}
              </div>
            </li>
          );
        })}
      </ol>

      {(state.error || (!running && state.runId)) && (
        <div className={cn("px-4 py-3 border-t text-[12px]", state.error ? "border-rose-100 bg-rose-50 text-rose-800" : "border-ink-100 text-ink-600")}>
          {state.error
            ? `Stopped: ${state.error}`
            : `Done in ${secs(elapsed)}. ${AGENT_NAME} stopped before the money: Ethan approves, Drake accepts, then a rule releases the payout. The full results are below.`}
        </div>
      )}
      {running && current && (
        <div className="sr-only" aria-live="polite">
          {current.label}
        </div>
      )}
    </div>
  );
}
