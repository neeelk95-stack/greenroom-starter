import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Sparkles, CircleCheck, CircleDot, LockKeyhole, PenLine, CircleMinus, CircleAlert, FileSpreadsheet, Smartphone } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { DealTypeBadge, PlainBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { getShow } from "@/lib/agent/tools";
import { sampleOfferEmail } from "@/lib/agent/offerEmails";
import { getLatestRun } from "@/lib/agent/runStore";
import { PROFILES, defaultProfile, type ProfileName } from "@/lib/agent/routing";
import { MODELS, availability, checkLocalModel, type ModelKey } from "@/lib/agent/models";
import type { AgentStep, AgentRun } from "@/lib/agent/agent";
import type { Autonomy } from "@/lib/agent/policy";
import { formatShowDateFull } from "@/lib/format";
import { RunPanel, type ProfileOption } from "@/components/agent/RunPanel";
import { AskPanel } from "@/components/agent/AskPanel";
import { ConfirmTermsButton, PayoutPanel } from "@/components/agent/PeopleActions";
import { ModelChip, usd } from "@/components/agent/ModelChip";
import { cn } from "@/lib/utils";
import { AGENT_NAME } from "@/components/agent/Stagehand";

export const dynamic = "force-dynamic";

const money = (n: number) => `${n < 0 ? "−" : ""}$${Math.abs(Math.round(n)).toLocaleString("en-US")}`;

const AUTONOMY_STYLE: Record<Autonomy, string> = {
  auto: "bg-brand-50 text-brand-800 ring-brand-200/80",
  auto_if_checks_pass: "bg-sky-50 text-sky-800 ring-sky-200/80",
  draft_only: "bg-amber-50 text-amber-800 ring-amber-200/80",
  people_decide: "bg-rose-50 text-rose-800 ring-rose-200/80",
  people_only: "bg-rose-50 text-rose-800 ring-rose-200/80",
};

function StepIcon({ status }: { status: AgentStep["status"] }) {
  const cls = "h-4 w-4 shrink-0 mt-0.5";
  if (status === "done") return <CircleCheck className={cn(cls, "text-brand-600")} />;
  if (status === "needs_person") return <CircleAlert className={cn(cls, "text-amber-700")} />;
  if (status === "draft_ready") return <PenLine className={cn(cls, "text-amber-700")} />;
  if (status === "locked") return <LockKeyhole className={cn(cls, "text-rose-700")} />;
  if (status === "skipped") return <CircleMinus className={cn(cls, "text-ink-300")} />;
  return <CircleDot className={cls} />;
}

const FIELD_LABEL: Record<string, string> = {
  dealType: "Deal type",
  guaranteeAmount: "Guarantee",
  percentage: "Artist %",
  percentageBasis: "Basis",
  expenseCap: "Expense cap",
  hospitalityCap: "Hospitality cap",
};

function fmtField(field: string, v: string | number | null): string {
  if (v == null) return "—";
  if (field === "percentage" && typeof v === "number") return `${Math.round(v * 1000) / 10}%`;
  if (typeof v === "number") return money(v);
  return String(v).replaceAll("_", " ");
}

function suggestionsFor(run: AgentRun): string[] {
  const s = ["Why is the total to the artist this number?"];
  const keys = run.settlement.decisions.map((d) => d.key);
  if (keys.includes("disputedRecoups")) s.push("What if the disputed recoup is deducted tonight?");
  if (keys.includes("walkout")) s.push("What if the walkout is 100% of the overage instead?");
  if (keys.includes("doorFees")) s.push("What if fees don't come off the top instead?");
  if (keys.includes("recoupPlacement")) s.push("What if the recoup sits inside the cap instead?");
  s.push("What if every comp counted toward gross?");
  return s;
}

export default async function AgentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await getShow(id);
  if (!ctx) notFound();
  const { data } = ctx;
  const email = sampleOfferEmail(data);
  const [run, local] = await Promise.all([getLatestRun(id), checkLocalModel()]);

  const ready = (m: ModelKey) => (MODELS[m].provider === "openai_compatible" ? local.ok : availability(m).ok);
  const profiles: ProfileOption[] = (Object.keys(PROFILES) as ProfileName[]).map((k) => {
    const p = PROFILES[k];
    const primaries = Array.from(new Set(Object.values(p.routes).map((r) => r.primary)));
    const missing = primaries.filter((m) => !ready(m));
    return {
      key: k,
      label: p.label,
      description: p.description,
      ready: missing.length === 0,
      note: missing.length ? `Not ready: ${missing.map((m) => (MODELS[m].local ? `start the local model (${local.reason ?? "not reachable"})` : `${MODELS[m].label} needs an API key`)).join("; ")}. The gateway will fall back.` : "Ready",
      local: primaries.every((m) => MODELS[m].local) && k !== "rules",
    };
  });

  return (
    <div className="px-4 sm:px-12 py-8 sm:py-10 max-w-4xl">
      <Link href={`/shows/${id}`} className="inline-flex items-center gap-1.5 text-[12px] text-ink-400 hover:text-ink-700 mb-8">
        <ArrowLeft className="h-3 w-3" /> Back to show
      </Link>

      <div className="mb-8">
        <div className="flex items-center gap-1.5 mb-4">
          {data.deal && <DealTypeBadge type={data.deal.dealType} />}
          <PlainBadge variant="brand">
            <Sparkles className="h-3 w-3 mr-1" /> {AGENT_NAME} · Deal Ledger agent
          </PlainBadge>
        </div>
        <h1 className="font-display text-[32px] sm:text-[44px] font-medium text-ink-900 leading-[1.05]" style={{ letterSpacing: "-0.02em" }}>
          {data.artist?.name}
        </h1>
        <div className="text-[14px] text-ink-400 mt-3">{formatShowDateFull(data.show.date)}</div>
        <p className="text-[13.5px] text-ink-600 mt-4 max-w-2xl leading-relaxed">
          {AGENT_NAME} takes the show from the offer email to a settlement ready to sign. It acts alone on anything internal and undoable, drafts anything that leaves the building, and stops before money moves. The math is the deterministic engine; models only read and write.{" "}
          <Link href="/agent" className="text-brand-700 hover:underline">
            Routing, autonomy and evals
          </Link>
        </p>
      </div>

      <Card className="mb-6">
        <CardContent className="pt-6">
          <RunPanel showId={id} email={email} profiles={profiles} initialProfile={run?.profile ?? defaultProfile()} />
        </CardContent>
      </Card>

      {run && <RunView run={run} />}
    </div>
  );
}

function RunView({ run }: { run: AgentRun }) {
  const termsConfirmed = run.termsStatus !== "waiting_for_booker";
  return (
    <div className="space-y-6">
      <Card accent="brand">
        <CardHeader>
          <CardTitle>What {AGENT_NAME} did</CardTitle>
          <CardDescription>
            Run {run.id} · {PROFILES[run.profile].label} · {new Date(run.createdAt).toLocaleString("en-US")} · {run.totals.modelCalls} model calls ·{" "}
            {run.totals.inputTokens.toLocaleString()} tokens in, {run.totals.outputTokens.toLocaleString()} out · {(run.totals.latencyMs / 1000).toFixed(1)} s · {usd(run.totals.costUsd)}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ol className="space-y-4">
            {run.steps.map((s) => (
              <li key={s.action} className="flex gap-3">
                <StepIcon status={s.status} />
                <div className="flex-1 min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[13.5px] font-medium text-ink-900">{s.label}</span>
                    <span className={cn("text-[10.5px] px-2 py-0.5 rounded-md ring-1 ring-inset font-medium", AUTONOMY_STYLE[s.autonomy])}>{s.autonomyLabel}</span>
                  </div>
                  <div className="text-[12.5px] text-ink-600 mt-0.5 leading-relaxed">{s.summary}</div>
                  {s.model && <ModelChip use={s.model} />}
                </div>
              </li>
            ))}
          </ol>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Deal terms from the email</CardTitle>
          <CardDescription>Every money term must quote the email. Code checks each quote and compares it with the deal record.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full text-[12.5px]">
              <thead>
                <tr className="text-left text-ink-400 text-[11px] uppercase tracking-wide">
                  <th className="py-1.5 pr-3 font-medium">Term</th>
                  <th className="py-1.5 pr-3 font-medium">From the email</th>
                  <th className="py-1.5 pr-3 font-medium">Quote</th>
                  <th className="py-1.5 pr-3 font-medium">Deal record</th>
                </tr>
              </thead>
              <tbody>
                {run.termChecks.map((t) => (
                  <tr key={t.field} className="border-t border-ink-100 align-top">
                    <td className="py-2 pr-3 text-ink-600">{FIELD_LABEL[t.field]}</td>
                    <td className="py-2 pr-3 font-medium text-ink-900 tabular">
                      {fmtField(t.field, t.value)}{" "}
                      {t.value != null && t.field !== "percentageBasis" && (t.verified ? <span className="text-brand-700">✓</span> : <span className="text-rose-700">✗</span>)}
                    </td>
                    <td className="py-2 pr-3 text-ink-500 italic">{t.citation ? `“${t.citation}”` : t.value == null ? "not in the email" : "—"}</td>
                    <td className={cn("py-2 pr-3 tabular", t.value != null && t.recordValue != null && !t.matchesRecord ? "text-rose-700 font-medium" : "text-ink-500")}>
                      {fmtField(t.field, t.recordValue)}
                      {t.value != null && t.recordValue != null && !t.matchesRecord ? " ← differs" : ""}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className={cn("mt-5 rounded-lg p-4 ring-1 ring-inset", run.termsStatus === "waiting_for_booker" ? "bg-amber-50/60 ring-amber-200/80" : "bg-brand-50/50 ring-brand-200/80")}>
            <div className="text-[13px] font-medium text-ink-900">
              {run.termsStatus === "committed_by_agent" && "Committed by the agent: every check passed."}
              {run.termsStatus === "waiting_for_booker" && "Waiting for Ethan before the terms are committed"}
              {run.termsStatus === "confirmed_by_booker" && "Confirmed by Ethan."}
            </div>
            {run.termsStatus === "waiting_for_booker" && (
              <>
                <ul className="mt-1.5 text-[12px] text-ink-600 list-disc pl-4 space-y-0.5">
                  {run.gate.reasons.map((r) => (
                    <li key={r}>{r}</li>
                  ))}
                </ul>
                <div className="mt-3">
                  <ConfirmTermsButton showId={run.showId} />
                </div>
              </>
            )}
          </div>
        </CardContent>
      </Card>

      {run.flags.length > 0 && (
        <Card accent="amber">
          <CardHeader>
            <CardTitle>Terms with two readings</CardTitle>
            <CardDescription>The model finds the clause; the settlement engine computes what each reading pays.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            {run.flags.map((f, i) => (
              <div key={i} className="rounded-lg ring-1 ring-inset ring-ink-200/80 p-4">
                <div className="text-[13px] font-medium text-ink-900">{f.label}</div>
                <div className="text-[12.5px] text-ink-600 italic mt-1">“{f.quote}”</div>
                <div className="text-[12.5px] text-ink-700 mt-2">{f.question}</div>
                {f.price && (
                  <div className="mt-3 space-y-2">
                    {[{ title: "At this show's numbers", p: f.price.actual }, ...(f.price.atCap ? [{ title: "If receipts reach the expense cap", p: f.price.atCap }] : [])].map(({ title, p }) => (
                      <div key={title}>
                        <div className="text-[11px] text-ink-400 uppercase tracking-wide">{title}</div>
                        <div className="flex flex-wrap gap-2 mt-1">
                          {p.options.map((o) => (
                            <span key={o.value} className="text-[12.5px] rounded-md bg-ink-50 ring-1 ring-inset ring-ink-200/80 px-2.5 py-1 tabular">
                              {o.label}: <span className="font-medium text-ink-900">{money(o.totalToArtist)}</span>
                            </span>
                          ))}
                          <span className={cn("text-[12px] px-2 py-1 tabular", p.impact >= 1 ? "text-amber-800 font-medium" : "text-ink-400")}>
                            {p.impact >= 1 ? `${money(p.impact)} difference` : "same payout"}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
            {run.droppedFlags > 0 && (
              <div className="text-[11.5px] text-ink-400">
                {run.droppedFlags} flag{run.droppedFlags === 1 ? "" : "s"} dropped because the quoted words weren&apos;t in the email.
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {run.draft && (
        <Card>
          <CardHeader>
            <CardTitle>Draft to Drake</CardTitle>
            <CardDescription>Draft only. {AGENT_NAME} can&apos;t send email; Ethan reviews and sends it.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="text-[12px] text-ink-500 mb-1">Subject: {run.draft.subject}</div>
            <pre className="whitespace-pre-wrap text-[13px] leading-relaxed text-ink-800 font-sans bg-canvas-soft rounded-lg p-4 ring-1 ring-inset ring-ink-200/60">{run.draft.body}</pre>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Settlement packet</CardTitle>
          <CardDescription>Calculated by the engine. The summary&apos;s numbers were checked against it before showing.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-baseline gap-3">
            <div className="font-display text-[36px] text-ink-900 tabular">{money(run.settlement.totalToArtist)}</div>
            <div className="text-[12.5px] text-ink-500">to the artist</div>
            <PlainBadge variant={run.settlement.summaryGrounded ? "brand" : "amber"} className="ml-auto">
              {run.settlement.summaryGrounded ? "Every number checked" : "Engine's own summary used"}
            </PlainBadge>
          </div>
          <p className="text-[13px] text-ink-700 leading-relaxed mt-3">{run.settlement.summary}</p>
          <div className="flex gap-2 mt-4">
            <Link href={`/shows/${run.showId}/settle`}>
              <Button variant="secondary" size="sm">
                <FileSpreadsheet className="h-3.5 w-3.5" /> Open the settlement
              </Button>
            </Link>
            <Link href={`/shows/${run.showId}/settle/share`}>
              <Button variant="secondary" size="sm">
                <Smartphone className="h-3.5 w-3.5" /> Drake&apos;s view
              </Button>
            </Link>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Ask at the table</CardTitle>
          <CardDescription>Answers come from the engine. For a what-if, the model asks the engine to recompute, then explains the result.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <AskPanel showId={run.showId} suggestions={suggestionsFor(run)} />
          {[...run.qa].reverse().map((qa, i) => (
            <div key={i} className="border-t border-ink-100 pt-4">
              <div className="text-[12.5px] font-medium text-ink-900">{qa.question}</div>
              <div className="text-[13px] text-ink-700 mt-1 leading-relaxed">{qa.answer}</div>
              {qa.whatIf && (
                <div className="text-[11.5px] text-ink-500 mt-1.5 tabular">
                  Engine what-if: {money(qa.whatIf.oldTotal)} → {money(qa.whatIf.newTotal)}
                </div>
              )}
              {qa.models.map((m, j) => (
                <ModelChip key={j} use={m} />
              ))}
            </div>
          ))}
        </CardContent>
      </Card>

      <Card accent="rose">
        <CardHeader>
          <CardTitle>Payout: people only</CardTitle>
          <CardDescription>{AGENT_NAME} stops here.</CardDescription>
        </CardHeader>
        <CardContent>
          <PayoutPanel
            showId={run.showId}
            termsConfirmed={termsConfirmed}
            booker={run.approvals.booker?.by}
            tourManager={run.approvals.tourManager?.by}
            released={run.payout.released}
            note={run.payout.note}
            total={money(run.settlement.totalToArtist)}
          />
        </CardContent>
      </Card>
    </div>
  );
}
