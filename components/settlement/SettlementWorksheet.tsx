"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronRight,
  FileText,
  Info,
  Scale,
  Send,
} from "lucide-react";
import {
  settleWithDecisions,
  money,
  type Readings,
  type SettlementInput,
  type Line,
} from "@/lib/settlementEngine";
import type { SettlementRecord } from "@/lib/settlementRecordStore";
import { saveSettlementRecordAction } from "@/app/shows/[id]/settle/actions";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PlainBadge } from "@/components/ui/badge";

const GROUP_LABELS: Record<Line["group"], string> = {
  revenue: "Ticket revenue",
  costs: "Costs charged to the deal",
  split: "The deal",
  bonus: "Bonuses",
  adjustment: "Adjustments",
  total: "",
};

export function SettlementWorksheet({
  showId,
  input,
  recordedTotal,
  savedRecord,
}: {
  showId: string;
  input: SettlementInput;
  recordedTotal: number | null;
  savedRecord: SettlementRecord | null;
}) {
  const [readings, setReadings] = useState<Partial<Readings>>(savedRecord?.readings ?? {});
  const [questioned, setQuestioned] = useState(savedRecord?.questioned ?? "");
  const [agreed, setAgreed] = useState(savedRecord?.agreed ?? "");
  const [signedBy, setSignedBy] = useState(savedRecord?.signedBy ?? "");
  const [savedAt, setSavedAt] = useState<string | null>(savedRecord?.savedAt ?? null);
  const [pending, startTransition] = useTransition();

  const s = useMemo(() => settleWithDecisions(input, readings), [input, readings]);
  const warnings = s.checks.filter((c) => c.level === "warning");

  const save = () => {
    const record: SettlementRecord = {
      showId,
      readings: s.readings,
      totalToArtist: s.totalToArtist,
      venueResult: s.venueResult,
      decisions: s.decisions.map((d) => ({
        key: d.key,
        title: d.title,
        chosen: d.chosen,
        chosenLabel: d.options.find((o) => o.value === d.chosen)?.label ?? d.chosen,
        impact: d.impact,
      })),
      venueAbsorbedOverCap: s.venueAbsorbedOverCap,
      recoupsHeld: s.recoupsHeld,
      questioned,
      agreed,
      signedBy,
      summary: s.summary,
      savedAt: "",
      version: 1,
    };
    startTransition(async () => {
      await saveSettlementRecordAction(record);
      setSavedAt(new Date().toISOString());
    });
  };

  const groups = (["revenue", "costs", "split", "bonus", "adjustment"] as const)
    .map((g) => ({ g, lines: s.lines.filter((l) => l.group === g) }))
    .filter((x) => x.lines.length > 0);

  return (
    <div className="space-y-5">
      {/* Hero */}
      <div className="rounded-lg border border-ink-200/80 bg-white px-5 py-7 text-center">
        <div className="eyebrow text-[10px] text-ink-400 mb-2">Total to artist</div>
        <div className="text-[56px] sm:text-[64px] font-mono tabular font-bold text-ink-900 leading-none" style={{ letterSpacing: "-0.03em" }}>
          {money(s.totalToArtist)}
        </div>
        <div className="text-[12.5px] text-ink-500 mt-3">{s.dealSummary}</div>
        <div className="mt-4 flex flex-wrap justify-center gap-x-5 gap-y-1 text-[12px] text-ink-500">
          <span>
            Venue box office result{" "}
            <span className={`font-mono tabular font-medium ${s.venueResult < 0 ? "text-rose-700" : "text-ink-800"}`}>
              {money(s.venueResult)}
            </span>
          </span>
          {s.decisions.length > 0 && (
            <span className="text-amber-800">
              {s.decisions.length} term{s.decisions.length === 1 ? "" : "s"} to agree on
            </span>
          )}
          {recordedTotal != null && Math.abs(recordedTotal - s.totalToArtist) >= 1 && (
            <span>
              Recorded at the time{" "}
              <span className="font-mono tabular text-ink-800">{money(recordedTotal)}</span>{" "}
              <span className="text-ink-400">({money(s.totalToArtist - recordedTotal)} difference)</span>
            </span>
          )}
          {recordedTotal != null && Math.abs(recordedTotal - s.totalToArtist) < 1 && (
            <span className="inline-flex items-center gap-1 text-brand-700">
              <Check className="h-3 w-3" /> Matches what was paid
            </span>
          )}
        </div>
      </div>

      {/* Decisions */}
      {s.decisions.length > 0 && (
        <Card accent="amber">
          <CardHeader>
            <div>
              <CardTitle className="flex items-center gap-1.5">
                <Scale className="h-3.5 w-3.5 text-amber-700" /> Agree these before you sign
              </CardTitle>
              <CardDescription>
                The deal can honestly be read more than one way here. Both readings are shown with what each pays. Whatever you pick is saved with the settlement.
              </CardDescription>
            </div>
          </CardHeader>
          <CardContent className="space-y-5">
            {s.decisions.map((d) => (
              <div key={d.key}>
                <div className="flex items-baseline justify-between gap-3">
                  <div className="text-[13px] font-semibold text-ink-900">{d.title}</div>
                  <span className="shrink-0 whitespace-nowrap"><PlainBadge variant="amber">{money(d.impact)} apart</PlainBadge></span>
                </div>
                <div className="text-[12px] text-ink-500 mt-0.5">{d.question}</div>
                {d.sourceText && (
                  <div className="mt-2 text-[11.5px] text-ink-600 bg-canvas-soft rounded-md px-3 py-2 ring-1 ring-ink-200/60 leading-relaxed">
                    <span className="eyebrow text-[9.5px] text-ink-400 mr-1.5">Deal notes</span>
                    {d.sourceText}
                  </div>
                )}
                <div className="mt-2.5 grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {d.options.map((o) => {
                    const active = d.chosen === o.value;
                    return (
                      <button
                        key={o.value}
                        type="button"
                        onClick={() => setReadings((r) => ({ ...r, [d.key]: o.value }))}
                        className={`text-left rounded-lg px-3.5 py-3 ring-1 transition-colors min-h-[64px] ${
                          active
                            ? "ring-2 ring-brand-600 bg-brand-50/50"
                            : "ring-ink-200 bg-white hover:ring-ink-300"
                        }`}
                      >
                        <div className="flex items-baseline justify-between gap-2">
                          <span className="text-[13px] font-medium text-ink-900">{o.label}</span>
                          <span className="font-mono tabular text-[13px] text-ink-900">{money(o.totalToArtist)}</span>
                        </div>
                        <div className="text-[11.5px] text-ink-500 mt-1 leading-snug">{o.description}</div>
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {/* Plain-English summary */}
      <Card>
        <CardHeader>
          <div>
            <CardTitle className="flex items-center gap-1.5">
              <FileText className="h-3.5 w-3.5 text-ink-500" /> In plain English
            </CardTitle>
            <CardDescription>What the tour manager sees first.</CardDescription>
          </div>
        </CardHeader>
        <CardContent>
          <p className="text-[13px] text-ink-800 leading-relaxed">{s.summary}</p>
        </CardContent>
      </Card>

      {/* Worksheet */}
      <Card accent="brand">
        <CardHeader>
          <div>
            <CardTitle>Settlement worksheet</CardTitle>
            <CardDescription>Tap any line to see the receipts, ticket reports or deal terms behind it.</CardDescription>
          </div>
        </CardHeader>
        <CardContent className="space-y-5">
          {groups.map(({ g, lines }) => (
            <div key={g}>
              <div className="eyebrow text-[10px] text-ink-400 mb-1">{GROUP_LABELS[g]}</div>
              <div className="divide-y divide-ink-100/80">
                {lines.map((l) => (
                  <WorksheetLine key={l.key} line={l} />
                ))}
              </div>
            </div>
          ))}
          <div className="flex items-baseline justify-between pt-3 border-t-2 border-ink-900/80">
            <span className="text-[14px] font-semibold text-ink-900">Total to artist</span>
            <span className="text-[20px] font-mono tabular font-semibold text-ink-900">{money(s.totalToArtist)}</span>
          </div>
        </CardContent>
      </Card>

      {/* Checks */}
      {s.checks.length > 0 && (
        <Card accent={warnings.length ? "rose" : undefined}>
          <CardHeader>
            <div>
              <CardTitle className="flex items-center gap-1.5">
                <AlertTriangle className="h-3.5 w-3.5 text-rose-700" /> Look at these before signing
              </CardTitle>
              <CardDescription>Data problems the engine found. They don&apos;t change the math on their own.</CardDescription>
            </div>
          </CardHeader>
          <CardContent className="divide-y divide-ink-100/80">
            {s.checks.map((c, i) => (
              <div key={i} className="py-3 flex gap-2.5">
                {c.level === "warning" ? (
                  <AlertTriangle className="h-3.5 w-3.5 text-rose-600 mt-0.5 shrink-0" />
                ) : (
                  <Info className="h-3.5 w-3.5 text-sky-600 mt-0.5 shrink-0" />
                )}
                <div className="min-w-0">
                  <div className="text-[12.5px] font-medium text-ink-900">{c.title}</div>
                  <div className="text-[11.5px] text-ink-500 mt-0.5 leading-snug break-words">{c.detail}</div>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {/* Record of the room */}
      <Card>
        <CardHeader>
          <div>
            <CardTitle>Record of the room</CardTitle>
            <CardDescription>
              Saved with the settlement, and shared with the artist team. Next time nobody has to remember what was agreed.
            </CardDescription>
          </div>
          {savedAt && <PlainBadge variant="brand">Saved</PlainBadge>}
        </CardHeader>
        <CardContent className="space-y-4">
          <ul className="text-[12.5px] text-ink-700 space-y-1.5">
            {s.decisions.map((d) => (
              <li key={d.key} className="flex gap-2">
                <Check className="h-3.5 w-3.5 text-brand-700 mt-0.5 shrink-0" />
                <span>
                  {d.title.replace(/[?:]$/, "")} — <strong className="font-medium text-ink-900">{d.options.find((o) => o.value === d.chosen)?.label}</strong>
                </span>
              </li>
            ))}
            {s.venueAbsorbedOverCap > 0 && (
              <li className="flex gap-2">
                <Check className="h-3.5 w-3.5 text-brand-700 mt-0.5 shrink-0" />
                <span>Venue covers {money(s.venueAbsorbedOverCap)} of expenses over the cap</span>
              </li>
            )}
            {s.absorbedByVenue > 0 && (
              <li className="flex gap-2">
                <Check className="h-3.5 w-3.5 text-brand-700 mt-0.5 shrink-0" />
                <span>Venue absorbed {money(s.absorbedByVenue)} of receipts (not charged)</span>
              </li>
            )}
            {s.recoupsHeld > 0 && (
              <li className="flex gap-2">
                <Check className="h-3.5 w-3.5 text-brand-700 mt-0.5 shrink-0" />
                <span>{money(s.recoupsHeld)} in disputed recoups held open</span>
              </li>
            )}
          </ul>
          <label className="block">
            <span className="text-[11.5px] font-medium text-ink-600">What was questioned</span>
            <textarea
              value={questioned}
              onChange={(e) => setQuestioned(e.target.value)}
              rows={2}
              placeholder="e.g. TM asked about the backline charge"
              className="mt-1 w-full rounded-md ring-1 ring-ink-200 px-3 py-2 text-[13px] focus:outline-none focus:ring-2 focus:ring-brand-600"
            />
          </label>
          <label className="block">
            <span className="text-[11.5px] font-medium text-ink-600">What was agreed</span>
            <textarea
              value={agreed}
              onChange={(e) => setAgreed(e.target.value)}
              rows={2}
              placeholder="e.g. Venue absorbs backline; recoup held until the agent confirms"
              className="mt-1 w-full rounded-md ring-1 ring-ink-200 px-3 py-2 text-[13px] focus:outline-none focus:ring-2 focus:ring-brand-600"
            />
          </label>
          <label className="block">
            <span className="text-[11.5px] font-medium text-ink-600">Signed off by (tour manager)</span>
            <input
              value={signedBy}
              onChange={(e) => setSignedBy(e.target.value)}
              placeholder="Name"
              className="mt-1 w-full rounded-md ring-1 ring-ink-200 px-3 py-2 text-[13px] focus:outline-none focus:ring-2 focus:ring-brand-600"
            />
          </label>
          <div className="flex flex-col sm:flex-row gap-2 pt-1">
            <button
              type="button"
              onClick={save}
              disabled={pending}
              className="inline-flex items-center justify-center gap-1.5 rounded-md bg-brand-700 hover:bg-brand-800 text-white text-[13px] font-medium px-4 py-2.5 disabled:opacity-60"
            >
              <Check className="h-3.5 w-3.5" />
              {pending ? "Saving…" : savedAt ? "Save again" : "Save settlement record"}
            </button>
            <Link
              href={`/shows/${showId}/settle/share`}
              className="inline-flex items-center justify-center gap-1.5 rounded-md ring-1 ring-ink-200 hover:ring-ink-300 bg-white text-ink-900 text-[13px] font-medium px-4 py-2.5"
            >
              <Send className="h-3.5 w-3.5" /> Tour manager view
            </Link>
          </div>
          {savedAt && (
            <div className="text-[11px] text-ink-400">
              Last saved {new Date(savedAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}. The tour manager view shows the saved version.
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function WorksheetLine({ line }: { line: Line }) {
  const [open, setOpen] = useState(false);
  const expandable = line.sources.length > 0 || !!line.detail;
  const muted = line.kind === "info";
  const strong = line.kind === "subtotal";
  return (
    <div className="py-2.5">
      <button
        type="button"
        onClick={() => expandable && setOpen((o) => !o)}
        className={`w-full flex items-baseline justify-between gap-3 text-left ${expandable ? "cursor-pointer" : "cursor-default"}`}
      >
        <span className={`flex items-baseline gap-1 min-w-0 text-[13px] ${muted ? "text-ink-400" : strong ? "text-ink-900 font-medium" : "text-ink-700"}`}>
          {expandable ? (
            open ? <ChevronDown className="h-3 w-3 shrink-0 translate-y-0.5" /> : <ChevronRight className="h-3 w-3 shrink-0 translate-y-0.5" />
          ) : (
            <span className="w-3 shrink-0" />
          )}
          <span className="break-words">{line.label}</span>
        </span>
        <span className={`font-mono tabular text-[13.5px] shrink-0 ${muted ? "text-ink-300" : strong ? "text-ink-900 font-medium" : "text-ink-900"}`}>
          {muted ? "—" : line.kind === "subtract" ? money(line.amount) : line.kind === "add" && line.group !== "revenue" ? `+${money(line.amount)}` : money(line.amount)}
        </span>
      </button>
      {open && (
        <div className="ml-4 mt-2 space-y-1.5">
          {line.detail && <div className="text-[11.5px] text-ink-500 leading-snug">{line.detail}</div>}
          {line.sources.map((src, i) => (
            <div key={i} className="flex items-baseline justify-between gap-3 text-[11.5px]">
              <span className="text-ink-600 min-w-0 break-words">
                <span className="eyebrow text-[9px] text-ink-400 mr-1.5">{src.kind.replace("_", " ")}</span>
                {src.label}
              </span>
              {src.amount != null && <span className="font-mono tabular text-ink-700 shrink-0">{money(src.amount)}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
