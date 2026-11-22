import { MODELS } from "@/lib/agent/models";
import type { ModelUse } from "@/lib/agent/agent";
import { cn } from "@/lib/utils";

const ms = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)} s` : `${n} ms`);
export const usd = (n: number) => (n === 0 ? "$0" : n < 0.01 ? `$${n.toFixed(5)}` : `$${n.toFixed(3)}`);

export function ModelChip({ use }: { use: ModelUse }) {
  const spec = MODELS[use.model];
  const t = use.totals;
  const tried = use.attempts.filter((a) => a.status !== "ok" || a.model !== use.model);
  return (
    <div className="mt-2">
      <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
        <span className={cn("inline-flex items-center px-2 py-0.5 rounded-md ring-1 ring-inset font-medium", spec.local ? "bg-brand-50 text-brand-800 ring-brand-200/80" : "bg-sky-50 text-sky-800 ring-sky-200/80")}>
          {spec.label}
        </span>
        {use.escalated && <span className="px-2 py-0.5 rounded-md bg-amber-50 text-amber-800 ring-1 ring-inset ring-amber-200/80">escalated</span>}
        {use.fellBack && <span className="px-2 py-0.5 rounded-md bg-amber-50 text-amber-800 ring-1 ring-inset ring-amber-200/80">fallback</span>}
        <span className="text-ink-500 tabular">
          {t.inputTokens.toLocaleString()} in · {t.outputTokens.toLocaleString()} out · {ms(t.latencyMs)} · {usd(t.costUsd)}
        </span>
      </div>
      {tried.length > 0 && (
        <details className="mt-1.5">
          <summary className="text-[11px] text-ink-400 cursor-pointer hover:text-ink-600">What the gateway tried</summary>
          <ul className="mt-1 space-y-0.5 text-[11px] text-ink-500">
            {use.attempts.map((a, i) => (
              <li key={i}>
                {MODELS[a.model].label}: {a.status}
                {a.reason ? `: ${a.reason}` : ""}
                {a.problems?.length ? `: ${a.problems.join("; ")}` : ""}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
