import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Sparkles } from "lucide-react";
import { getShowById } from "@/lib/queries";
import {
  getArtistHistory,
  getDealTypeAggregates,
} from "@/lib/artistHistory";
import { recommend } from "@/lib/dealRecommender";
import { detect as detectContradictions } from "@/lib/freetextReconciliation";
import { isCancellationCandidate } from "@/lib/projection";
import { DealBuilderForm } from "@/components/deal-builder/DealBuilderForm";
import { DealTypeBadge, PlainBadge } from "@/components/ui/badge";
import { formatShowDateFull, formatMoney } from "@/lib/format";

export default async function DealBuilderPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const data = await getShowById(id);
  if (!data || !data.deal || !data.artist || !data.venue) notFound();

  const { show, artist, deal, venue } = data;

  const [artistHistory, dealTypeAggs, cancellationFlag] = await Promise.all([
    getArtistHistory(artist.id, venue.id, show.id),
    getDealTypeAggregates(venue.id),
    isCancellationCandidate(show.id, venue.id),
  ]);

  const recommendation = recommend({
    dealType: deal.dealType,
    artistHistory,
    dealTypeAggregates: dealTypeAggs,
    venueCapacity: venue.capacity,
  });

  const contradictions = detectContradictions(deal);

  return (
    <div className="min-h-screen bg-canvas">
      {/* Top bar */}
      <div className="border-b border-ink-200/80 bg-white sticky top-0 z-30">
        <div className="max-w-3xl mx-auto px-4 py-3 flex items-center justify-between gap-3">
          <Link
            href={`/shows/${id}`}
            className="text-[12px] text-ink-600 hover:text-ink-900 inline-flex items-center gap-1.5"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            Back to show
          </Link>
          <div className="flex items-center gap-1.5">
            <Sparkles className="w-3.5 h-3.5 text-brand-700" />
            <span className="text-[12.5px] font-semibold text-ink-900">
              Deal Builder
            </span>
          </div>
        </div>
      </div>

      <div className="max-w-3xl mx-auto px-4 pt-6">
        {/* Show header */}
        <div className="mb-5">
          <div className="flex items-center gap-2 mb-1">
            <DealTypeBadge type={deal.dealType} />
            <PlainBadge variant="default">
              {formatShowDateFull(show.date)}
            </PlainBadge>
          </div>
          <h1 className="font-display text-[26px] font-medium text-ink-900 leading-tight">
            {artist.name}
          </h1>
          <p className="text-[12.5px] text-ink-600 mt-1">
            {venue.name} · cap {venue.capacity}
            {artistHistory.priorShows.length > 0 && (
              <> · {artistHistory.priorShows.length} prior show{artistHistory.priorShows.length === 1 ? "" : "s"} at this venue</>
            )}
          </p>
        </div>

        {/* Cancellation banner */}
        {cancellationFlag.flagged && (
          <div className="mb-5 rounded-md bg-rose-50 ring-1 ring-rose-200/80 px-4 py-3">
            <div className="text-[12.5px] font-semibold text-rose-900 mb-1">
              Cancellation candidate
            </div>
            <p className="text-[12px] text-rose-800 leading-relaxed">
              At T-7 the projected gross is {formatMoney(cancellationFlag.projectedGross)},
              below the venue's average total expenses of{" "}
              {formatMoney(cancellationFlag.threshold)}. Projected loss if the show
              proceeds: ~{formatMoney(cancellationFlag.predictedLoss)}.
            </p>
          </div>
        )}

        {/* The form */}
        <DealBuilderForm
          showId={id}
          artistName={artist.name}
          artistId={artist.id}
          venueCapacity={venue.capacity}
          initialDealType={deal.dealType}
          recommendation={recommendation}
          initialFreetext={deal.dealNotesFreetext ?? ""}
          freetextContradictions={contradictions}
        />
      </div>
    </div>
  );
}
