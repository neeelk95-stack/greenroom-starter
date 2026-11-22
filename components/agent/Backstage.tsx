import Link from "next/link";
import { ArrowRight, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Backstage: the name of the Deal Ledger agent. At a venue, the real work
 * happens backstage before anyone sees the show: the advance, the checks,
 * the paperwork. The agent works there too and never walks on stage: it
 * stops before money moves.
 */
export const AGENT_NAME = "Backstage";
export const AGENT_TAGLINE = "Your AI settlement agent";

export const backstageButtonClass = cn(
  "group relative inline-flex items-center gap-3 rounded-xl pl-2 pr-4 py-2 min-w-[236px]",
  "bg-gradient-to-br from-ink-900 via-ink-800 to-brand-900 text-white",
  "ring-1 ring-inset ring-white/10 shadow-[0_8px_24px_-10px_rgba(4,120,87,0.6)]",
  "transition-all duration-200 hover:-translate-y-px hover:shadow-[0_12px_30px_-10px_rgba(4,120,87,0.75)]",
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500",
  "disabled:pointer-events-none disabled:opacity-80",
);

export function BackstageMark({ working = false }: { working?: boolean }) {
  return (
    <span className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-brand-500 to-brand-700 ring-1 ring-white/20 shadow-inner">
      <Sparkles className={cn("h-4 w-4 text-white", working && "animate-spin [animation-duration:2.5s]")} />
      <span className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-brand-300 ring-2 ring-ink-900 animate-pulse" />
    </span>
  );
}

export function BackstageLabel({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <span className="text-left leading-tight">
      <span className="block text-[13.5px] font-semibold tracking-[-0.01em]">{title}</span>
      <span className="block text-[11px] text-white/60 mt-0.5">{subtitle}</span>
    </span>
  );
}

/** The call to action on a show page. */
export function BackstageLink({ href }: { href: string }) {
  return (
    <Link href={href} className={backstageButtonClass}>
      <BackstageMark />
      <BackstageLabel title={`Send to ${AGENT_NAME}`} subtitle={AGENT_TAGLINE} />
      <ArrowRight className="ml-auto h-3.5 w-3.5 text-white/50 transition-transform group-hover:translate-x-0.5 group-hover:text-white" />
    </Link>
  );
}
