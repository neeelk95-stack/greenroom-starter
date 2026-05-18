import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, FileText, Mail, CheckCircle2 } from "lucide-react";
import { getShowById } from "@/lib/queries";
import { getLatestRationale } from "@/lib/dealRationaleStore";
import { DealTypeBadge } from "@/components/ui/badge";
import { formatShowDateFull, formatMoney, formatMoneyCompact } from "@/lib/format";
import type { ProjectedScenario } from "@/lib/dealMathV2";

/**
 * Agent-facing preview of the deal sheet (FR-A-01..06).
 *
 * This is what the agent receives — same numbers Mariana saw, with plain-English
 * provenance and the breakeven explanation. Override reasons render only if
 * the booker marked them public. Internal-only reasons are excluded.
 *
 * In production this also renders a PDF; here we render HTML that's
 * indistinguishable for review purposes.
 */
export default async function DealPreviewPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const data = await getShowById(id);
  if (!data || !data.deal || !data.artist || !data.venue) notFound();
  const { show, artist, deal, venue } = data;

  const rationale = await getLatestRationale(id);
  if (!rationale) {
    return (
      <EmptyState id={id} />
    );
  }

  const scenarios = rationale.projectedScenarios as ProjectedScenario[];
  const p50 = scenarios[1];

  return (
    <div className="min-h-screen bg-canvas">
      <div className="border-b border-ink-200/80 bg-white">
        <div className="max-w-2xl mx-auto px-4 py-3 flex items-center justify-between gap-3">
          <Link
            href={`/shows/${id}/deal-builder`}
            className="text-[12px] text-ink-600 hover:text-ink-900 inline-flex items-center gap-1.5"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            Back to Deal Builder
          </Link>
          <div className="flex items-center gap-1.5">
            <Mail className="w-3.5 h-3.5 text-brand-700" />
            <span className="text-[12.5px] font-semibold text-ink-900">
              Agent preview
            </span>
          </div>
        </div>
      </div>

      <div className="max-w-2xl mx-auto px-4 py-8">
        {/* Header */}
        <div className="bg-white rounded-lg ring-1 ring-ink-200/80 shadow-sm overflow-hidden">
          {/* Deal sheet header */}
          <div className="px-6 py-5 border-b border-ink-100/80">
            <div className="text-[10px] eyebrow text-ink-500 mb-1">Deal sheet</div>
            <h1 className="font-display text-[24px] font-medium text-ink-900">
              {artist.name} at {venue.name}
            </h1>
            <p className="text-[12.5px] text-ink-600 mt-1">
              {formatShowDateFull(show.date)} · cap {venue.capacity}
            </p>
            <div className="mt-3">
              <DealTypeBadge type={deal.dealType} />
            </div>
          </div>

          {/* Terms */}
          <div className="px-6 py-5 space-y-4">
            <div className="text-[10.5px] eyebrow text-ink-500">
              Agreed terms
            </div>
            <div className="space-y-3.5">
              {rationale.terms.map((t, idx) => (
                <TermRow key={idx} term={t} />
              ))}
            </div>
          </div>

          {/* Breakeven panel — the trust intervention (FR-A-02) */}
          <div className="px-6 py-5 bg-brand-50/40 border-y border-brand-100/80">
            <div className="text-[11px] eyebrow text-brand-800 mb-1.5">
              Venue breakeven
            </div>
            <div className="text-[14px] text-ink-900 leading-relaxed">
              The venue clears breakeven at gross of{" "}
              <span className="font-semibold tabular">
                {formatMoney(rationale.breakevenGross)}
              </span>
              . At projected p50 gross of{" "}
              <span className="font-semibold tabular">
                {formatMoney(p50.gross)}
              </span>
              , venue earnings are{" "}
              <span
                className={
                  p50.venueEarnings >= 0
                    ? "font-semibold tabular text-ink-900"
                    : "font-semibold tabular text-rose-700"
                }
              >
                {formatMoney(p50.venueEarnings)}
              </span>
              .
            </div>
          </div>

          {/* Projected outcomes table */}
          <div className="px-6 py-5">
            <div className="text-[10.5px] eyebrow text-ink-500 mb-2">
              Projected outcomes
            </div>
            <table className="w-full text-[12.5px]">
              <thead>
                <tr className="text-ink-500 text-left text-[10.5px] eyebrow">
                  <th className="py-1 font-medium">Scenario</th>
                  <th className="py-1 font-medium text-right">Gross</th>
                  <th className="py-1 font-medium text-right">To artist</th>
                  <th className="py-1 font-medium text-right">Venue</th>
                </tr>
              </thead>
              <tbody className="tabular">
                {scenarios.map((s) => (
                  <tr key={s.label} className="border-t border-ink-100/80">
                    <td className="py-1.5 font-medium text-ink-700">
                      {s.label.toUpperCase()}
                    </td>
                    <td className="py-1.5 text-right">{formatMoneyCompact(s.gross)}</td>
                    <td className="py-1.5 text-right">
                      {formatMoneyCompact(s.artistPay + s.walkoutPaid)}
                    </td>
                    <td
                      className={`py-1.5 text-right ${s.venueEarnings >= 0 ? "" : "text-rose-700"}`}
                    >
                      {formatMoneyCompact(s.venueEarnings)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Rationale appendix */}
          <div className="px-6 py-5 border-t border-ink-100/80 bg-ink-50/30">
            <div className="text-[10.5px] eyebrow text-ink-500 mb-2">
              <FileText className="inline w-3 h-3 mr-1 align-baseline" />
              Why these numbers
            </div>
            <div className="space-y-2.5">
              {rationale.terms.map((t, idx) => (
                <div key={idx} className="text-[12px] text-ink-700">
                  <span className="font-medium text-ink-900">
                    {humanField(t.field)}:
                  </span>{" "}
                  {t.provenance.summary}
                  {t.overridden && t.overrideVisibility === "public" && (
                    <span className="block mt-0.5 text-[11.5px] text-amber-800">
                      Adjusted from recommended{" "}
                      {formatRecValue(t.field, t.recommendedValue)} to{" "}
                      {formatRecValue(t.field, t.finalValue)} — reason:{" "}
                      <em>{t.overrideReason}</em>
                    </span>
                  )}
                </div>
              ))}
            </div>
          </div>

          {/* Footer */}
          <div className="px-6 py-4 border-t border-ink-100/80 text-[11px] text-ink-500 flex items-center gap-1.5">
            <CheckCircle2 className="w-3 h-3 text-brand-700" />
            Saved {new Date(rationale.savedAt).toLocaleString()} by{" "}
            {rationale.savedBy}. Same numbers shown to agent and venue.
          </div>
        </div>

        <div className="mt-4 text-[11.5px] text-ink-500 text-center">
          In production this is sent as an email + PDF. Agents view this view by
          a signed, time-limited link.
        </div>
      </div>
    </div>
  );
}

function TermRow({
  term,
}: {
  term: {
    field: string;
    recommendedValue: unknown;
    finalValue: unknown;
    overridden: boolean;
    overrideVisibility?: string;
  };
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-[12.5px] text-ink-700">
        {humanField(term.field)}
      </span>
      <span className="font-medium text-[13.5px] tabular text-ink-900">
        {formatRecValue(term.field, term.finalValue)}
      </span>
    </div>
  );
}

function humanField(f: string): string {
  return (
    {
      guarantee: "Guarantee",
      artistPercentage: "Artist percentage",
      expenseCap: "Expense cap",
      hospitalityCap: "Hospitality cap",
      walkoutThreshold: "Walkout threshold (net)",
    }[f] ?? f
  );
}

function formatRecValue(field: string, value: unknown): string {
  if (typeof value !== "number") return String(value);
  if (field === "artistPercentage") return `${Math.round(value * 100)}%`;
  return formatMoney(value);
}

function EmptyState({ id }: { id: string }) {
  return (
    <div className="min-h-screen bg-canvas flex items-center justify-center px-4">
      <div className="max-w-md text-center">
        <FileText className="w-8 h-8 text-ink-400 mx-auto mb-3" />
        <h2 className="text-[15px] font-semibold text-ink-900 mb-1">
          No deal sheet saved yet
        </h2>
        <p className="text-[12.5px] text-ink-600 mb-4">
          Save the deal in the Deal Builder first — the agent preview renders
          the saved rationale snapshot.
        </p>
        <Link
          href={`/shows/${id}/deal-builder`}
          className="inline-block text-[12.5px] font-medium text-brand-700 hover:underline"
        >
          ← Back to Deal Builder
        </Link>
      </div>
    </div>
  );
}
