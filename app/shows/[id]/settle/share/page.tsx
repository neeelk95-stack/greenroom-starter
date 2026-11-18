/**
 * Tour manager view — what the artist team opens on their phone.
 *
 * Read-only. Shows the saved settlement record if there is one (otherwise a
 * clearly-labelled draft): the plain-English summary, every line with its
 * receipts, and what was agreed in the room. No internal checks, no venue P&L.
 */

import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Check } from "lucide-react";
import { getShowById } from "@/lib/queries";
import { settleWithDecisions, money, type SettlementInput, type Line } from "@/lib/settlementEngine";
import { getLatestSettlementRecord } from "@/lib/settlementRecordStore";
import { formatShowDateFull } from "@/lib/format";

export default async function SettlementSharePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const data = await getShowById(id);
  if (!data || !data.deal) notFound();
  const { show, artist, deal, venue } = data;

  const input: SettlementInput = {
    deal,
    ticketSales: data.ticketSales,
    expenses: data.expenses,
    comps: data.comps,
    recoups: data.recoups,
    venueCapacity: venue?.capacity ?? null,
  };
  const record = await getLatestSettlementRecord(show.id);
  const s = settleWithDecisions(input, record?.readings ?? {});
  const visible = s.lines.filter((l) => l.group !== "total");

  return (
    <div className="min-h-screen bg-canvas">
      <div className="max-w-md mx-auto px-4 py-6">
        <Link
          href={`/shows/${show.id}/settle`}
          className="inline-flex items-center gap-1 text-[12px] text-ink-400 hover:text-ink-900 mb-5"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> Back to venue view
        </Link>

        <div className="eyebrow text-[10px] text-ink-400">Settlement for the artist team</div>
        <h1 className="font-display text-[28px] font-medium text-ink-900 leading-tight mt-1" style={{ letterSpacing: "-0.02em" }}>
          {artist?.name}
        </h1>
        <div className="text-[12.5px] text-ink-500 mt-1">
          {venue?.name} · {formatShowDateFull(show.date)}
        </div>
        <div className="mt-2 text-[11.5px]">
          {record ? (
            <span className="inline-flex items-center gap-1 text-brand-700">
              <Check className="h-3 w-3" /> Saved {new Date(record.savedAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
              {record.signedBy ? ` · signed off by ${record.signedBy}` : ""}
            </span>
          ) : (
            <span className="text-amber-800">Draft — the venue hasn&apos;t saved this settlement yet.</span>
          )}
        </div>

        <div className="mt-6 rounded-lg bg-white border border-ink-200/80 px-5 py-6 text-center">
          <div className="eyebrow text-[10px] text-ink-400 mb-1.5">Total to artist</div>
          <div className="text-[48px] font-mono tabular font-bold text-ink-900 leading-none" style={{ letterSpacing: "-0.03em" }}>
            {money(s.totalToArtist)}
          </div>
          <div className="text-[12px] text-ink-500 mt-2.5">{s.dealSummary}</div>
        </div>

        <p className="mt-5 text-[13.5px] text-ink-800 leading-relaxed">{s.summary}</p>

        {record && (record.decisions.length > 0 || record.agreed || record.questioned) && (
          <div className="mt-6 rounded-lg bg-white border border-ink-200/80 p-4">
            <div className="text-[13px] font-semibold text-ink-900 mb-2">Agreed at the table</div>
            <ul className="space-y-1.5 text-[12.5px] text-ink-700">
              {record.decisions.map((d) => (
                <li key={d.key} className="flex gap-2">
                  <Check className="h-3.5 w-3.5 text-brand-700 mt-0.5 shrink-0" />
                  <span>
                    {d.title.replace(/[?:]$/, "")} — <strong className="font-medium text-ink-900">{d.chosenLabel}</strong>
                  </span>
                </li>
              ))}
              {record.questioned && <li className="text-ink-600"><span className="font-medium text-ink-800">Questioned:</span> {record.questioned}</li>}
              {record.agreed && <li className="text-ink-600"><span className="font-medium text-ink-800">Agreed:</span> {record.agreed}</li>}
            </ul>
          </div>
        )}

        <div className="mt-6 rounded-lg bg-white border border-ink-200/80 divide-y divide-ink-100/80">
          {visible.map((l) => (
            <ShareLine key={l.key} line={l} />
          ))}
          <div className="px-4 py-3 flex items-baseline justify-between">
            <span className="text-[13.5px] font-semibold text-ink-900">Total to artist</span>
            <span className="font-mono tabular text-[16px] font-semibold text-ink-900">{money(s.totalToArtist)}</span>
          </div>
        </div>

        <p className="mt-5 text-[11px] text-ink-400 leading-relaxed">
          Every number traces to a ticket report, a receipt or a term in the deal. Tap a line to see its sources. Questions? Reply to the venue before signing.
        </p>
      </div>
    </div>
  );
}

function ShareLine({ line }: { line: Line }) {
  const muted = line.kind === "info";
  const value = muted ? "—" : money(line.amount);
  if (line.sources.length === 0 && !line.detail) {
    return (
      <div className="px-4 py-2.5 flex items-baseline justify-between gap-3">
        <span className={`text-[12.5px] ${line.kind === "subtotal" ? "font-medium text-ink-900" : muted ? "text-ink-400" : "text-ink-700"}`}>{line.label}</span>
        <span className={`font-mono tabular text-[13px] ${muted ? "text-ink-300" : "text-ink-900"}`}>{value}</span>
      </div>
    );
  }
  return (
    <details className="px-4 py-2.5 group">
      <summary className="flex items-baseline justify-between gap-3 cursor-pointer list-none">
        <span className={`text-[12.5px] ${line.kind === "subtotal" ? "font-medium text-ink-900" : muted ? "text-ink-400" : "text-ink-700"}`}>
          {line.label}
        </span>
        <span className={`font-mono tabular text-[13px] shrink-0 ${muted ? "text-ink-300" : "text-ink-900"}`}>{value}</span>
      </summary>
      <div className="mt-2 space-y-1">
        {line.detail && <div className="text-[11.5px] text-ink-500">{line.detail}</div>}
        {line.sources.map((src, i) => (
          <div key={i} className="flex items-baseline justify-between gap-3 text-[11.5px]">
            <span className="text-ink-600 break-words min-w-0">{src.label}</span>
            {src.amount != null && <span className="font-mono tabular text-ink-700 shrink-0">{money(src.amount)}</span>}
          </div>
        ))}
      </div>
    </details>
  );
}
