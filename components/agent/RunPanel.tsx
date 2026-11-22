"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Laptop, Cloud, ScrollText } from "lucide-react";
import { AGENT_NAME, BackstageLabel, BackstageMark, backstageButtonClass } from "@/components/agent/Backstage";
import { LiveRun, applyEvent, type LiveState, type ModelLabels } from "@/components/agent/LiveRun";
import type { AgentEvent } from "@/lib/agent/agent";
import { cn } from "@/lib/utils";

export type ProfileOption = { key: string; label: string; description: string; ready: boolean; note: string; local: boolean };

export function RunPanel({
  showId,
  email,
  profiles,
  initialProfile,
  modelLabels,
}: {
  showId: string;
  email: { text: string; from: string; fromFirstName: string; source: string };
  profiles: ProfileOption[];
  initialProfile: string;
  modelLabels: ModelLabels;
}) {
  const router = useRouter();
  const [text, setText] = useState(email.text);
  const [profile, setProfile] = useState(initialProfile);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [live, setLive] = useState<LiveState | null>(null);
  const chosen = profiles.find((p) => p.key === profile);
  const currentStep = live?.steps.find((s) => s.state === "running");

  // Streams the run: each line from the server is one event (a step starting,
  // a model call, a step finishing), applied to the live view as it arrives.
  const run = async () => {
    setError(null);
    setPending(true);
    setLive({ profileLabel: chosen?.label ?? profile, steps: [], startedAt: Date.now() });
    try {
      const res = await fetch(`/shows/${showId}/agent/run`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: text, from: email.from, firstName: email.fromFirstName, profile }),
      });
      if (!res.ok || !res.body) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error ?? `HTTP ${res.status}`);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          const ev = JSON.parse(line) as AgentEvent;
          setLive((s) => (s ? applyEvent(s, ev) : s));
          if (ev.type === "error") setError(ev.message);
        }
      }
    } catch (e) {
      const message = (e as Error).message;
      setError(message);
      setLive((s) => (s ? { ...s, endedAt: Date.now(), error: s.error ?? message } : s));
    } finally {
      setPending(false);
      router.refresh();
    }
  };

  return (
    <div className="space-y-5">
      <div>
        <div className="flex items-baseline justify-between mb-2">
          <label className="eyebrow text-[10px] text-ink-500">Offer email from {email.from}</label>
          <span className="text-[11px] text-ink-400">{email.source}</span>
        </div>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={9}
          className="w-full rounded-lg border border-ink-200/80 bg-canvas-soft px-4 py-3 text-[13px] leading-relaxed text-ink-800 font-mono focus:outline-none focus:ring-2 focus:ring-brand-700/30"
        />
      </div>

      <div>
        <div className="eyebrow text-[10px] text-ink-500 mb-2">Which models {AGENT_NAME} runs on</div>
        <div className="grid gap-2 sm:grid-cols-2">
          {profiles.map((p) => (
            <button
              key={p.key}
              type="button"
              onClick={() => setProfile(p.key)}
              className={cn(
                "text-left rounded-lg px-3.5 py-3 ring-1 ring-inset transition-all",
                profile === p.key ? "bg-white ring-brand-700/60 shadow-sm" : "bg-white/60 ring-ink-200/80 hover:bg-white",
              )}
            >
              <div className="flex items-center gap-2 text-[13px] font-medium text-ink-900">
                {p.local ? <Laptop className="h-3.5 w-3.5 text-ink-500" /> : p.key === "rules" ? <ScrollText className="h-3.5 w-3.5 text-ink-500" /> : <Cloud className="h-3.5 w-3.5 text-ink-500" />}
                {p.label}
                <span className={cn("ml-auto h-1.5 w-1.5 rounded-full", p.ready ? "bg-brand-500" : "bg-amber-500")} title={p.note} />
              </div>
              <div className="text-[11.5px] text-ink-500 mt-1 leading-snug">{p.description}</div>
              {!p.ready && <div className="text-[11px] text-amber-800 mt-1">{p.note}</div>}
            </button>
          ))}
        </div>
      </div>

      <div className="flex items-center gap-3">
        <button type="button" onClick={run} disabled={pending} className={backstageButtonClass}>
          <BackstageMark working={pending} />
          <BackstageLabel
            title={pending ? `${AGENT_NAME} is working…` : `Send to ${AGENT_NAME}`}
            subtitle={pending ? (currentStep?.label ?? chosen?.label ?? "") : "Reads the email, checks the terms, preps the settlement"}
          />
        </button>
        {pending && chosen?.local && (
          <span className="text-[12px] text-ink-500">On a laptop, a local model takes a couple of minutes for all the steps.</span>
        )}
        {error && !live && <span className="text-[12px] text-rose-700">{error}</span>}
      </div>

      {live && <LiveRun state={live} labels={modelLabels} />}
    </div>
  );
}
