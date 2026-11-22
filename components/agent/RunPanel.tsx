"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Bot, Loader2, Laptop, Cloud, ScrollText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { runAgentAction } from "@/app/shows/[id]/agent/actions";

export type ProfileOption = { key: string; label: string; description: string; ready: boolean; note: string; local: boolean };

export function RunPanel({
  showId,
  email,
  profiles,
  initialProfile,
}: {
  showId: string;
  email: { text: string; from: string; fromFirstName: string; source: string };
  profiles: ProfileOption[];
  initialProfile: string;
}) {
  const router = useRouter();
  const [text, setText] = useState(email.text);
  const [profile, setProfile] = useState(initialProfile);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const chosen = profiles.find((p) => p.key === profile);

  const run = () => {
    setError(null);
    start(async () => {
      const r = await runAgentAction({ showId, email: text, from: email.from, firstName: email.fromFirstName, profile });
      if (!r.ok) setError(r.error);
      router.refresh();
    });
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
        <div className="eyebrow text-[10px] text-ink-500 mb-2">Which models run the agent</div>
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
        <Button variant="brand" size="lg" onClick={run} disabled={pending}>
          {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Bot className="h-4 w-4" />}
          {pending ? "Agent running…" : "Run the agent"}
        </Button>
        {pending && (
          <span className="text-[12px] text-ink-500">
            {chosen?.local ? "On a laptop, a local model can take 20 to 90 seconds for all the steps." : "Usually a few seconds."}
          </span>
        )}
        {error && <span className="text-[12px] text-rose-700">{error}</span>}
      </div>
    </div>
  );
}
