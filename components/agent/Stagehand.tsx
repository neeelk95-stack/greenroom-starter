import Link from "next/link";
import { ArrowRight, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Stagehand: the name of the Deal Ledger agent. Like a stagehand, it does the
 * prep work behind the scenes and never takes the stage: it stops before
 * money moves.
 */
export const AGENT_NAME = "Stagehand";
export const AGENT_TAGLINE = "Your AI settlement agent";

export const stagehandButtonClass = cn(
  "group relative inline-flex items-center gap-3 rounded-xl pl-2 pr-4 py-2 min-w-[236px]",
  "bg-gradient-to-br from-ink-900 via-ink-800 to-brand-900 text-white",
  "ring-1 ring-inset ring-white/10 shadow-[0_8px_24px_-10px_rgba(4,120,87,0.6)]",
  "transition-all duration-200 hover:-translate-y-px hover:shadow-[0_12px_30px_-10px_rgba(4,120,87,0.75)]",
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500",
  "disabled:pointer-events-none disabled:opacity-80",
);

export function StagehandMark({ working = false }: { working?: boolean }) {
  return (
    <span className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-brand-500 to-brand-700 ring-1 ring-white/20 shadow-inner">
      <Sparkles className={cn("h-4 w-4 text-white", working && "animate-spin [animation-duration:2.5s]")} />
      <span className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-brand-300 ring-2 ring-ink-900 animate-pulse" />
    </span>
  );
}

export function StagehandLabel({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <span className="text-left leading-tight">
      <span className="block text-[13.5px] font-semibold tracking-[-0.01em]">{title}</span>
      <span className="block text-[11px] text-white/60 mt-0.5">{subtitle}</span>
    </span>
  );
}

/** The call to action on a show page. */
export function StagehandLink({ href }: { href: string }) {
  return (
    <Link href={href} className={stagehandButtonClass}>
      <StagehandMark />
      <StagehandLabel title={`Send in ${AGENT_NAME}`} subtitle={AGENT_TAGLINE} />
      <ArrowRight className="ml-auto h-3.5 w-3.5 text-white/50 transition-transform group-hover:translate-x-0.5 group-hover:text-white" />
    </Link>
  );
}
