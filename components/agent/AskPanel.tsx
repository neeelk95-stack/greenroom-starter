"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, MessageCircleQuestion } from "lucide-react";
import { Button } from "@/components/ui/button";
import { askAction } from "@/app/shows/[id]/agent/actions";

export function AskPanel({ showId, suggestions }: { showId: string; suggestions: string[] }) {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const ask = (question: string) => {
    if (!question.trim()) return;
    setError(null);
    start(async () => {
      const r = await askAction(showId, question.trim());
      if (!r.ok) setError(r.error);
      else setQ("");
      router.refresh();
    });
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-1.5">
        {suggestions.map((s) => (
          <button
            key={s}
            type="button"
            disabled={pending}
            onClick={() => ask(s)}
            className="text-[11.5px] rounded-full px-3 py-1 bg-ink-50 ring-1 ring-inset ring-ink-200/80 text-ink-700 hover:bg-white disabled:opacity-50"
          >
            {s}
          </button>
        ))}
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          ask(q);
        }}
        className="flex gap-2"
      >
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Ask what the tour manager would ask…"
          className="flex-1 h-9 rounded-lg border border-ink-200/80 bg-white px-3 text-[13px] focus:outline-none focus:ring-2 focus:ring-brand-700/30"
        />
        <Button variant="secondary" disabled={pending || !q.trim()}>
          {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <MessageCircleQuestion className="h-3.5 w-3.5" />}
          Ask
        </Button>
      </form>
      {error && <div className="text-[12px] text-rose-700">{error}</div>}
    </div>
  );
}
