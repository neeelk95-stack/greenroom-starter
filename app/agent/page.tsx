import fs from "node:fs/promises";
import path from "node:path";
import Link from "next/link";
import { Sparkles } from "lucide-react";
import { AGENT_NAME } from "@/components/agent/Stagehand";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { PlainBadge } from "@/components/ui/badge";
import { AUTONOMY, AUTONOMY_LABEL } from "@/lib/agent/policy";
import { PROFILES, TASKS, defaultProfile, resolveRoute, type ProfileName } from "@/lib/agent/routing";
import { MODELS, MODEL_KEYS, availability, checkLocalModel, localBaseUrl } from "@/lib/agent/models";
import { AGENT_TOOLS, WITHHELD_FROM_AGENT } from "@/lib/agent/tools";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

type Scorecard = {
  generatedAt: string;
  cases: { extract: number; readings: number; disputed: number; disputedWithClause: number };
  gates: { extractFieldAccuracy: number; citationsVerified: number; readingsRecall: number; falseFlagRateOnClear: number };
  results: {
    model: string;
    label: string;
    extract: { fieldAccuracy: number; citationsVerified: number; p50ms: number; p95ms: number; costPer100: number; bySuite: Record<string, number> } | null;
    readings: { recall: number; precision: number; falseFlagRateOnClear: number; p50ms: number; costPer100: number } | null;
    disputed: { recall: number; positives: number } | null;
  }[];
};

async function loadScorecard(): Promise<Scorecard | null> {
  try {
    return JSON.parse(await fs.readFile(path.join(process.cwd(), "data", "eval", "latest.json"), "utf-8"));
  } catch {
    return null;
  }
}

const pct = (x: number) => `${Math.round(x * 1000) / 10}%`;
const levelStyle: Record<string, string> = {
  auto: "bg-brand-50 text-brand-800 ring-brand-200/80",
  auto_if_checks_pass: "bg-sky-50 text-sky-800 ring-sky-200/80",
  draft_only: "bg-amber-50 text-amber-800 ring-amber-200/80",
  people_decide: "bg-rose-50 text-rose-800 ring-rose-200/80",
  people_only: "bg-rose-50 text-rose-800 ring-rose-200/80",
};

function Gate({ ok, children }: { ok: boolean; children: React.ReactNode }) {
  return <span className={cn("tabular", ok ? "text-brand-800 font-medium" : "text-ink-700")}>{children}</span>;
}

export default async function AgentOverviewPage() {
  const [local, card] = await Promise.all([checkLocalModel(), loadScorecard()]);
  const current = defaultProfile();
  const profiles = Object.keys(PROFILES) as ProfileName[];

  return (
    <div className="px-4 sm:px-12 py-8 sm:py-10 max-w-5xl space-y-6">
      <div className="mb-2">
        <PlainBadge variant="brand">
          <Sparkles className="h-3 w-3 mr-1" /> {AGENT_NAME} · Deal Ledger agent
        </PlainBadge>
        <h1 className="font-display text-[36px] sm:text-[44px] font-medium text-ink-900 leading-[1.05] mt-4" style={{ letterSpacing: "-0.02em" }}>
          {AGENT_NAME}: autonomy, models and evals
        </h1>
        <p className="text-[13.5px] text-ink-600 mt-3 max-w-2xl leading-relaxed">
          What the agent may do alone, which model runs each task, and how each model scored on the venue&apos;s own history. Try it on{" "}
          <Link className="text-brand-700 hover:underline" href="/shows/show_coastal_spell_dispute/agent">
            Coastal Spell
          </Link>
          ,{" "}
          <Link className="text-brand-700 hover:underline" href="/shows/show_0007/agent">
            Briar Road
          </Link>{" "}
          or{" "}
          <Link className="text-brand-700 hover:underline" href="/shows/show_0018/agent">
            Navarro
          </Link>
          .
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>What {AGENT_NAME} may do alone</CardTitle>
          <CardDescription>Autonomy depends on whether the action can be undone and whether it reaches someone outside the venue.</CardDescription>
        </CardHeader>
        <CardContent>
          <table className="w-full text-[12.5px]">
            <tbody>
              {AUTONOMY.map((a) => (
                <tr key={a.action} className="border-t border-ink-100 align-top first:border-t-0">
                  <td className="py-2 pr-3 text-ink-900">{a.label}</td>
                  <td className="py-2 pr-3 whitespace-nowrap">
                    <span className={cn("text-[10.5px] px-2 py-0.5 rounded-md ring-1 ring-inset font-medium", levelStyle[a.level])}>{AUTONOMY_LABEL[a.level]}</span>
                  </td>
                  <td className="py-2 text-ink-500">{a.why}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="mt-4 text-[12px] text-ink-500">
            Tools the agent has: <span className="font-mono text-ink-700">{AGENT_TOOLS.join(", ")}</span>. Withheld on purpose:{" "}
            <span className="font-mono text-rose-700">{WITHHELD_FROM_AGENT.join(", ")}</span>.
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Model routing</CardTitle>
          <CardDescription>
            Primary model per task, with escalation (→) when a check fails. Every route falls back down a chain that ends in rules, so the agent keeps working offline. Default profile:{" "}
            <span className="font-medium text-ink-800">{PROFILES[current].label}</span> (set <span className="font-mono">AGENT_PROFILE</span>).
          </CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="w-full text-[12px]">
            <thead>
              <tr className="text-left text-ink-400 text-[10.5px] uppercase tracking-wide">
                <th className="py-1.5 pr-3 font-medium">Task</th>
                {profiles.map((p) => (
                  <th key={p} className={cn("py-1.5 pr-3 font-medium", p === current && "text-brand-800")}>
                    {PROFILES[p].label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {TASKS.map((t) => (
                <tr key={t.name} className="border-t border-ink-100 align-top">
                  <td className="py-2 pr-3">
                    <div className="text-ink-900">{t.label}</div>
                    <div className="text-[11px] text-ink-400 leading-snug mt-0.5 max-w-[220px]">{t.why}</div>
                  </td>
                  {profiles.map((p) => {
                    const r = resolveRoute(t.name, p);
                    return (
                      <td key={p} className={cn("py-2 pr-3 text-ink-700", p === current && "bg-brand-50/40")}>
                        {MODELS[r.primary].label}
                        {r.escalate && <span className="text-ink-400"> → {MODELS[r.escalate].label}</span>}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Models</CardTitle>
          <CardDescription>List prices per million tokens, November 2026. The gateway logs tokens, latency and cost on every call.</CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="w-full text-[12.5px]">
            <thead>
              <tr className="text-left text-ink-400 text-[10.5px] uppercase tracking-wide">
                <th className="py-1.5 pr-3 font-medium">Model</th>
                <th className="py-1.5 pr-3 font-medium">Input / output</th>
                <th className="py-1.5 pr-3 font-medium">Status</th>
                <th className="py-1.5 font-medium">Role</th>
              </tr>
            </thead>
            <tbody>
              {MODEL_KEYS.map((k) => {
                const m = MODELS[k];
                const av = m.provider === "openai_compatible" ? { ok: local.ok, reason: local.reason } : availability(k);
                return (
                  <tr key={k} className="border-t border-ink-100 align-top">
                    <td className="py-2 pr-3 text-ink-900 whitespace-nowrap">
                      {m.label}
                      {m.apiModel && <div className="text-[10.5px] font-mono text-ink-400">{m.apiModel}</div>}
                    </td>
                    <td className="py-2 pr-3 tabular text-ink-700 whitespace-nowrap">{m.inputPerM === 0 && m.outputPerM === 0 ? "free" : `$${m.inputPerM} / $${m.outputPerM}`}</td>
                    <td className="py-2 pr-3 whitespace-nowrap">
                      <span className={cn("text-[11px]", av.ok ? "text-brand-800" : "text-amber-800")}>
                        {av.ok ? (m.provider === "openai_compatible" ? `running at ${localBaseUrl()}` : "ready") : av.reason}
                      </span>
                    </td>
                    <td className="py-2 text-ink-500">{m.note}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {local.ok && local.models.length > 0 && (
            <div className="mt-3 text-[11.5px] text-ink-500">
              Local server reports: <span className="font-mono">{local.models.join(", ")}</span>. The agent uses <span className="font-mono">{MODELS["gemma-local"].apiModel}</span> (set <span className="font-mono">LOCAL_MODEL</span>).
            </div>
          )}
        </CardContent>
      </Card>

      <Card accent="sky">
        <CardHeader>
          <CardTitle>Eval scorecard</CardTitle>
          <CardDescription>
            {card
              ? `Run ${new Date(card.generatedAt).toLocaleString("en-US")}. ${card.cases.extract} extraction cases (half the real deal notes, half paraphrased), ${card.cases.readings} two-readings cases, ${card.cases.disputed} disputed settlements (${card.cases.disputedWithClause} have a clause the engine or the text can verify). Each model runs alone, with no routing.`
              : "No scorecard yet. Run npm run eval."}
          </CardDescription>
        </CardHeader>
        {card && (
          <CardContent className="overflow-x-auto">
            <table className="w-full text-[12.5px]">
              <thead>
                <tr className="text-left text-ink-400 text-[10.5px] uppercase tracking-wide">
                  <th className="py-1.5 pr-3 font-medium">Model</th>
                  <th className="py-1.5 pr-3 font-medium">Field accuracy</th>
                  <th className="py-1.5 pr-3 font-medium">Paraphrased</th>
                  <th className="py-1.5 pr-3 font-medium">Citations</th>
                  <th className="py-1.5 pr-3 font-medium">Two readings: recall</th>
                  <th className="py-1.5 pr-3 font-medium">False flags</th>
                  <th className="py-1.5 pr-3 font-medium">Disputed: recall</th>
                  <th className="py-1.5 pr-3 font-medium">Latency p50 / p95</th>
                  <th className="py-1.5 font-medium">Cost / 100 deals</th>
                </tr>
              </thead>
              <tbody>
                {card.results.map((r) => (
                  <tr key={r.model} className="border-t border-ink-100">
                    <td className="py-2 pr-3 text-ink-900 whitespace-nowrap">{r.label}</td>
                    <td className="py-2 pr-3">{r.extract ? <Gate ok={r.extract.fieldAccuracy >= card.gates.extractFieldAccuracy}>{pct(r.extract.fieldAccuracy)}</Gate> : "—"}</td>
                    <td className="py-2 pr-3 tabular text-ink-600">{r.extract?.bySuite?.["extract-paraphrased"] != null ? pct(r.extract.bySuite["extract-paraphrased"]) : "—"}</td>
                    <td className="py-2 pr-3">{r.extract ? <Gate ok={r.extract.citationsVerified >= card.gates.citationsVerified}>{pct(r.extract.citationsVerified)}</Gate> : "—"}</td>
                    <td className="py-2 pr-3">{r.readings ? <Gate ok={r.readings.recall >= card.gates.readingsRecall}>{pct(r.readings.recall)}</Gate> : "—"}</td>
                    <td className="py-2 pr-3">{r.readings ? <Gate ok={r.readings.falseFlagRateOnClear <= card.gates.falseFlagRateOnClear}>{pct(r.readings.falseFlagRateOnClear)}</Gate> : "—"}</td>
                    <td className="py-2 pr-3 tabular text-ink-700">{r.disputed ? pct(r.disputed.recall) : "—"}</td>
                    <td className="py-2 pr-3 tabular text-ink-600 whitespace-nowrap">{r.extract ? `${r.extract.p50ms} / ${r.extract.p95ms} ms` : "—"}</td>
                    <td className="py-2 tabular text-ink-600">{r.extract ? `$${(r.extract.costPer100 + (r.readings?.costPer100 ?? 0)).toFixed(4)}` : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="mt-3 text-[11.5px] text-ink-500">
              Gates (in green when met): field accuracy ≥ {pct(card.gates.extractFieldAccuracy)}, citations {pct(card.gates.citationsVerified)}, two-readings recall ≥ {pct(card.gates.readingsRecall)}, false flags on clear emails ≤ {pct(card.gates.falseFlagRateOnClear)}. Refresh with{" "}
              <span className="font-mono">npm run eval -- --models rules,gemma-local,haiku-5.5,sonnet-5.5</span>.
            </div>
          </CardContent>
        )}
      </Card>
    </div>
  );
}
