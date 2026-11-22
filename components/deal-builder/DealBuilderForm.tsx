"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { saveDealAction } from "@/app/shows/[id]/deal-builder/actions";
import {
  computeProjection,
  type DealTerms,
  type BonusV2,
  type ProjectedScenario,
} from "@/lib/dealMathV2";
import { computeBreakevenGross } from "@/lib/dealMathV2";
import type { Recommendation, Provenance } from "@/lib/dealRecommender";
import type { Contradiction } from "@/lib/freetextReconciliation";
import type { DealRationale } from "@/lib/dealRationaleStore";
import {
  AlertCircle,
  Info,
  Plus,
  X,
  Lock,
  Unlock,
  Send,
  Save,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PlainBadge } from "@/components/ui/badge";
import { formatMoney, formatMoneyCompact } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { Deal } from "@/db/schema";

type Props = {
  showId: string;
  artistName: string;
  artistId: string;
  venueCapacity: number;
  initialDealType: Deal["dealType"];
  recommendation: Recommendation;
  initialFreetext: string;
  freetextContradictions: Contradiction[];
};

type FieldOverride = {
  reason: string;
  visibility: "public" | "internal";
};

type FormState = {
  dealType: Deal["dealType"];
  guarantee: number;
  artistPercentage: number;
  expenseCap: number;
  hospitalityCap: number;
  walkoutEnabled: boolean;
  walkoutThreshold: number;
  bonuses: BonusV2[];
  freetext: string;
  overrides: Record<string, FieldOverride>;
};

const DEAL_TYPE_LABELS: Record<Deal["dealType"], string> = {
  flat: "Flat guarantee",
  percentage_of_gross: "% of gross",
  percentage_of_net: "% of net",
  vs: "Vs (guarantee vs %)",
  door: "Door (net-basis)",
};

export function DealBuilderForm(props: Props) {
  const {
    showId,
    artistName,
    venueCapacity,
    recommendation,
    initialFreetext,
    freetextContradictions: initialContradictions,
  } = props;

  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  const [state, setState] = useState<FormState>(() => ({
    dealType: recommendation.dealType,
    guarantee: recommendation.guarantee?.value ?? 0,
    artistPercentage: recommendation.artistPercentage?.value ?? 0,
    expenseCap: recommendation.expenseCap.value,
    hospitalityCap: recommendation.hospitalityCap.value,
    walkoutEnabled: false,
    walkoutThreshold: recommendation.walkout?.value.netThreshold ?? 0,
    bonuses: [],
    freetext: initialFreetext,
    overrides: {},
  }));

  const [pendingOverride, setPendingOverride] = useState<{
    field: string;
    proposedValue: number;
  } | null>(null);

  const terms: DealTerms = useMemo(
    () => ({
      dealType: state.dealType,
      guarantee: state.guarantee,
      artistPercentage: state.artistPercentage,
      percentageBasis: recommendation.percentageBasis,
      expenseCap: state.expenseCap,
      hospitalityCap: state.hospitalityCap,
      bonuses: state.bonuses,
      walkout: state.walkoutEnabled
        ? { netThreshold: state.walkoutThreshold }
        : null,
    }),
    [state, recommendation.percentageBasis],
  );

  const projection = useMemo(
    () =>
      computeProjection({
        terms,
        projectedGross: recommendation.projectedGross,
        projectedExpenses: recommendation.projectedExpenses,
        venueCapacity,
      }),
    [terms, recommendation, venueCapacity],
  );

  const breakeven = useMemo(
    () =>
      computeBreakevenGross({
        terms,
        projectedExpenses: recommendation.projectedExpenses,
      }),
    [terms, recommendation.projectedExpenses],
  );

  // Field change handler — checks band, triggers override modal if outside.
  function attemptChange(
    field: string,
    value: number,
    band?: { min: number; max: number },
    onApply?: (v: number) => void,
  ) {
    if (band && (value < band.min || value > band.max)) {
      setPendingOverride({ field, proposedValue: value });
      return;
    }
    onApply?.(value);
    // Clear any existing override for this field if user moved back into band.
    setState((s) => {
      if (!s.overrides[field]) return s;
      const { [field]: _removed, ...rest } = s.overrides;
      return { ...s, overrides: rest };
    });
  }

  function applyOverride(reason: string, visibility: "public" | "internal") {
    if (!pendingOverride) return;
    const { field, proposedValue } = pendingOverride;
    setState((s) => {
      const next = { ...s, overrides: { ...s.overrides, [field]: { reason, visibility } } };
      if (field === "guarantee") next.guarantee = proposedValue;
      else if (field === "artistPercentage") next.artistPercentage = proposedValue;
      else if (field === "expenseCap") next.expenseCap = proposedValue;
      else if (field === "hospitalityCap") next.hospitalityCap = proposedValue;
      else if (field === "walkoutThreshold") next.walkoutThreshold = proposedValue;
      return next;
    });
    setPendingOverride(null);
  }

  function cancelOverride() {
    setPendingOverride(null);
  }

  // BR-05c hard block: 100% walkout requires high gross + 90% attendance.
  const walkoutBlocked = recommendation.walkout?.hardBlocked != null;
  // BR-04 hard block on door + gross basis is enforced by the deal-type
  // selector NOT showing "gross" for door deals — implicit in the UI.

  function handleSave() {
    const rationale: DealRationale = {
      showId,
      dealType: state.dealType,
      terms: [
        ...buildTermEntry("guarantee", state.guarantee, recommendation.guarantee?.value ?? null, recommendation.guarantee?.provenance, state.overrides.guarantee),
        ...buildTermEntry("artistPercentage", state.artistPercentage, recommendation.artistPercentage?.value ?? null, recommendation.artistPercentage?.provenance, state.overrides.artistPercentage),
        ...buildTermEntry("expenseCap", state.expenseCap, recommendation.expenseCap.value, recommendation.expenseCap.provenance, state.overrides.expenseCap),
        ...buildTermEntry("hospitalityCap", state.hospitalityCap, recommendation.hospitalityCap.value, recommendation.hospitalityCap.provenance, state.overrides.hospitalityCap),
        ...(state.walkoutEnabled
          ? buildTermEntry("walkoutThreshold", state.walkoutThreshold, recommendation.walkout?.value.netThreshold ?? null, recommendation.walkout?.provenance, state.overrides.walkoutThreshold)
          : []),
      ],
      breakevenGross: breakeven,
      projectedScenarios: projection,
      freetextContradictions: initialContradictions,
      savedAt: new Date().toISOString(),
      savedBy: "Ethan",
      version: 1,
    };
    startTransition(async () => {
      await saveDealAction(showId, rationale);
    });
  }

  // The hero scenario (p50) is the single primary number per BR-02 / UX-06.
  const hero = projection[1];

  return (
    <div className="space-y-6 max-w-3xl mx-auto pb-32">
      {/* Hero: projected venue earnings at p50 */}
      <Card accent={hero.venueEarnings >= 0 ? "brand" : "rose"}>
        <CardContent className="py-6">
          <div className="flex items-baseline justify-between flex-wrap gap-3">
            <div>
              <div className="eyebrow text-[10px] text-ink-500 mb-1">
                Projected venue earnings · p50 gross
              </div>
              <div
                className={cn(
                  "text-[34px] font-semibold tracking-tight tabular",
                  hero.venueEarnings >= 0 ? "text-ink-900" : "text-rose-700",
                )}
              >
                {formatMoney(hero.venueEarnings)}
              </div>
              <div className="text-[12px] text-ink-500 mt-1">
                At projected gross of {formatMoney(hero.gross)} ·{" "}
                <span className="font-medium text-ink-700">
                  Breakeven at {formatMoney(breakeven)}
                </span>
              </div>
            </div>
            <div className="flex gap-4 text-right">
              <ScenarioCell label="p25" scenario={projection[0]} />
              <ScenarioCell label="p75" scenario={projection[2]} />
            </div>
          </div>
          {hero.venueEarnings < 0 && (
            <div className="mt-4 text-[12.5px] text-rose-800 bg-rose-50 ring-1 ring-rose-200/80 rounded-md px-3 py-2">
              <AlertCircle className="inline w-3.5 h-3.5 mr-1.5 align-text-bottom" />
              At p50 gross, this deal loses money. Adjust the expense cap, the
              guarantee, or the artist % to bring this above zero.
            </div>
          )}
        </CardContent>
      </Card>

      {/* Recommended terms grid */}
      <Card>
        <CardHeader>
          <CardTitle>Deal terms</CardTitle>
          <PlainBadge variant={confidenceColor(recommendation.overallConfidence)}>
            {recommendation.overallConfidence} confidence
            {recommendation.basedOnPriorShows > 0
              ? ` · ${recommendation.basedOnPriorShows} prior shows`
              : " · no prior shows"}
          </PlainBadge>
        </CardHeader>
        <CardContent className="space-y-5">
          {/* Guarantee */}
          {recommendation.guarantee && (
            <RecommendationField
              label="Guarantee"
              kind="money"
              value={state.guarantee}
              recommended={recommendation.guarantee.value}
              band={recommendation.guarantee.band}
              provenance={recommendation.guarantee.provenance}
              overridden={!!state.overrides.guarantee}
              overrideReason={state.overrides.guarantee?.reason}
              onChange={(v) =>
                attemptChange(
                  "guarantee",
                  v,
                  recommendation.guarantee?.band,
                  (val) => setState((s) => ({ ...s, guarantee: val })),
                )
              }
            />
          )}

          {/* Artist % */}
          {recommendation.artistPercentage && (
            <RecommendationField
              label={`Artist % (of ${recommendation.percentageBasis})`}
              kind="percent"
              value={state.artistPercentage}
              recommended={recommendation.artistPercentage.value}
              band={recommendation.artistPercentage.band}
              provenance={recommendation.artistPercentage.provenance}
              overridden={!!state.overrides.artistPercentage}
              overrideReason={state.overrides.artistPercentage?.reason}
              hardBlocked={recommendation.artistPercentage.hardBlocked}
              onChange={(v) =>
                attemptChange(
                  "artistPercentage",
                  v,
                  recommendation.artistPercentage?.band,
                  (val) => setState((s) => ({ ...s, artistPercentage: val })),
                )
              }
            />
          )}

          {/* Expense cap */}
          <RecommendationField
            label="Expense cap"
            kind="money"
            value={state.expenseCap}
            recommended={recommendation.expenseCap.value}
            band={recommendation.expenseCap.band}
            provenance={recommendation.expenseCap.provenance}
            overridden={!!state.overrides.expenseCap}
            overrideReason={state.overrides.expenseCap?.reason}
            onChange={(v) =>
              attemptChange(
                "expenseCap",
                v,
                recommendation.expenseCap.band,
                (val) => setState((s) => ({ ...s, expenseCap: val })),
              )
            }
          />

          {/* Hospitality cap */}
          <RecommendationField
            label="Hospitality cap"
            kind="money"
            value={state.hospitalityCap}
            recommended={recommendation.hospitalityCap.value}
            provenance={recommendation.hospitalityCap.provenance}
            overridden={!!state.overrides.hospitalityCap}
            overrideReason={state.overrides.hospitalityCap?.reason}
            onChange={(v) =>
              setState((s) => ({ ...s, hospitalityCap: v }))
            }
          />

          {/* Walkout pot */}
          {recommendation.walkout && (
            <div className="border-t border-ink-100/80 pt-5">
              <div className="flex items-center justify-between mb-2">
                <div>
                  <div className="text-[12px] font-medium text-ink-800">
                    Walkout pot
                  </div>
                  <div className="text-[11.5px] text-ink-500">
                    100% of net above threshold goes to artist
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() =>
                    setState((s) => ({ ...s, walkoutEnabled: !s.walkoutEnabled }))
                  }
                  disabled={walkoutBlocked}
                  className={cn(
                    "h-6 w-11 rounded-full transition-colors",
                    state.walkoutEnabled ? "bg-brand-700" : "bg-ink-200",
                    walkoutBlocked && "opacity-50 cursor-not-allowed",
                  )}
                  aria-pressed={state.walkoutEnabled}
                >
                  <span
                    className={cn(
                      "block w-5 h-5 bg-white rounded-full transition-transform",
                      state.walkoutEnabled ? "translate-x-5" : "translate-x-0.5",
                    )}
                  />
                </button>
              </div>
              {walkoutBlocked && (
                <div className="text-[11.5px] text-rose-700 bg-rose-50 ring-1 ring-rose-200/60 rounded-md px-2.5 py-1.5 mb-2">
                  <Lock className="inline w-3 h-3 mr-1 align-text-bottom" />
                  {recommendation.walkout.hardBlocked?.[0].reason}
                </div>
              )}
              {state.walkoutEnabled && !walkoutBlocked && (
                <RecommendationField
                  label="Walkout threshold (net)"
                  kind="money"
                  value={state.walkoutThreshold}
                  recommended={recommendation.walkout.value.netThreshold}
                  provenance={recommendation.walkout.provenance}
                  overridden={!!state.overrides.walkoutThreshold}
                  overrideReason={state.overrides.walkoutThreshold?.reason}
                  onChange={(v) =>
                    setState((s) => ({ ...s, walkoutThreshold: v }))
                  }
                />
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Bonus editor */}
      <BonusEditor
        bonuses={state.bonuses}
        breakevenNet={0}
        onChange={(b) => setState((s) => ({ ...s, bonuses: b }))}
      />

      {/* Freetext + contradictions */}
      <Card>
        <CardHeader>
          <CardTitle>Deal notes (freetext)</CardTitle>
          <span className="text-[10.5px] text-ink-500">
            Reconciled against structured fields on save
          </span>
        </CardHeader>
        <CardContent>
          {initialContradictions.length > 0 && (
            <div className="mb-3 space-y-2">
              {initialContradictions.map((c, idx) => (
                <div
                  key={idx}
                  className="text-[12px] bg-amber-50 ring-1 ring-amber-200/80 rounded-md px-3 py-2"
                >
                  <AlertCircle className="inline w-3.5 h-3.5 mr-1.5 align-text-bottom text-amber-700" />
                  <span className="font-medium text-amber-900">
                    Contradiction detected:
                  </span>{" "}
                  <span className="text-amber-900">{c.explanation}</span>
                  <div className="mt-1 text-[11px] text-amber-800 italic">
                    "{c.freetextSnippet}"
                  </div>
                </div>
              ))}
            </div>
          )}
          <textarea
            value={state.freetext}
            onChange={(e) =>
              setState((s) => ({ ...s, freetext: e.target.value }))
            }
            rows={5}
            placeholder="Paste agent email language, side agreements, anything the structured fields above don't capture cleanly."
            className="w-full text-[13px] text-ink-900 bg-white border border-ink-200/80 rounded-md px-3 py-2 focus:outline-none focus:ring-2 focus:ring-brand-700/30 focus:border-brand-700"
          />
        </CardContent>
      </Card>

      {/* Sticky action bar */}
      <div className="fixed bottom-0 inset-x-0 bg-white border-t border-ink-200/80 px-4 py-3 z-40">
        <div className="max-w-3xl mx-auto flex items-center justify-between gap-3">
          <div className="text-[11.5px] text-ink-600 hidden sm:block">
            Sending to agent will produce a deal sheet with the rationale block
            for {artistName}.
          </div>
          <div className="flex gap-2 ml-auto">
            <Button
              variant="secondary"
              size="default"
              onClick={() => router.back()}
              disabled={isPending}
            >
              Cancel
            </Button>
            <Button
              variant="brand"
              size="default"
              onClick={handleSave}
              disabled={isPending}
            >
              <Send className="w-3.5 h-3.5" />
              {isPending ? "Saving…" : "Save & open deal sheet"}
            </Button>
          </div>
        </div>
      </div>

      {/* Override modal */}
      {pendingOverride && (
        <OverrideModal
          field={pendingOverride.field}
          proposedValue={pendingOverride.proposedValue}
          onCancel={cancelOverride}
          onConfirm={applyOverride}
        />
      )}
    </div>
  );
}

function ScenarioCell({
  label,
  scenario,
}: {
  label: string;
  scenario: ProjectedScenario;
}) {
  return (
    <div>
      <div className="eyebrow text-[9.5px] text-ink-500 mb-0.5">
        {label} venue
      </div>
      <div
        className={cn(
          "text-[15px] font-medium tabular",
          scenario.venueEarnings >= 0 ? "text-ink-800" : "text-rose-700",
        )}
      >
        {formatMoneyCompact(scenario.venueEarnings)}
      </div>
    </div>
  );
}

// ----------- RecommendationField -----------

function RecommendationField(props: {
  label: string;
  kind: "money" | "percent";
  value: number;
  recommended: number;
  band?: { min: number; max: number };
  provenance: Provenance;
  overridden: boolean;
  overrideReason?: string;
  hardBlocked?: { reason: string }[];
  onChange: (v: number) => void;
}) {
  const {
    label,
    kind,
    value,
    recommended,
    band,
    provenance,
    overridden,
    overrideReason,
    hardBlocked,
    onChange,
  } = props;

  const [showProvenance, setShowProvenance] = useState(false);

  return (
    <div>
      <div className="flex items-baseline justify-between gap-3 mb-1">
        <label className="text-[12px] font-medium text-ink-800">{label}</label>
        <button
          type="button"
          onClick={() => setShowProvenance(!showProvenance)}
          className="text-[10.5px] text-brand-700 hover:underline inline-flex items-center gap-1"
        >
          <Info className="w-3 h-3" />
          Why this?
        </button>
      </div>
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          {kind === "money" && (
            <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-500 text-[13px]">
              $
            </span>
          )}
          <input
            type="number"
            value={kind === "percent" ? Math.round(value * 100) : value}
            step={kind === "percent" ? 1 : 50}
            onChange={(e) => {
              const raw = parseFloat(e.target.value) || 0;
              onChange(kind === "percent" ? raw / 100 : raw);
            }}
            className={cn(
              "w-full text-[14px] tabular font-medium text-ink-900 bg-white border rounded-md py-2 focus:outline-none focus:ring-2 focus:ring-brand-700/30",
              kind === "money" ? "pl-6 pr-3" : "pl-3 pr-7",
              overridden ? "border-amber-400/80" : "border-ink-200/80",
            )}
          />
          {kind === "percent" && (
            <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-ink-500 text-[13px]">
              %
            </span>
          )}
        </div>
        <span className="text-[11px] text-ink-500 min-w-[5.5rem] text-right">
          rec:{" "}
          {kind === "money"
            ? formatMoneyCompact(recommended)
            : `${Math.round(recommended * 100)}%`}
        </span>
      </div>
      {band && !overridden && (
        <div className="text-[10.5px] text-ink-500 mt-1">
          Within recommended band ·{" "}
          {kind === "money"
            ? `${formatMoneyCompact(band.min)} – ${formatMoneyCompact(band.max)}`
            : `${Math.round(band.min * 100)}% – ${Math.round(band.max * 100)}%`}
        </div>
      )}
      {overridden && (
        <div className="text-[10.5px] text-amber-800 mt-1">
          <Unlock className="inline w-2.5 h-2.5 mr-1 align-baseline" />
          Override: {overrideReason}
        </div>
      )}
      {hardBlocked?.map((b, i) => (
        <div
          key={i}
          className="text-[10.5px] text-rose-700 mt-1 bg-rose-50 ring-1 ring-rose-200/60 rounded px-2 py-1"
        >
          <Lock className="inline w-2.5 h-2.5 mr-1 align-baseline" />
          {b.reason}
        </div>
      ))}
      {showProvenance && (
        <div className="mt-2 text-[11.5px] text-ink-700 bg-ink-50 ring-1 ring-ink-200/60 rounded-md px-3 py-2 leading-relaxed">
          {provenance.summary}
        </div>
      )}
    </div>
  );
}

// ----------- OverrideModal -----------

function OverrideModal(props: {
  field: string;
  proposedValue: number;
  onCancel: () => void;
  onConfirm: (reason: string, visibility: "public" | "internal") => void;
}) {
  const { field, onCancel, onConfirm } = props;
  const [reason, setReason] = useState("");
  const [visibility, setVisibility] = useState<"public" | "internal">("public");

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-ink-900/40">
      <div className="bg-white rounded-t-xl sm:rounded-xl w-full sm:max-w-md p-5 shadow-xl">
        <div className="flex items-start justify-between mb-3">
          <div>
            <div className="text-[15px] font-semibold text-ink-900">
              You're moving {humanField(field)} outside the recommended band.
            </div>
            <div className="text-[12px] text-ink-600 mt-1">
              Add a one-line reason — it'll be saved with the deal rationale.
            </div>
          </div>
          <button
            onClick={onCancel}
            className="text-ink-500 hover:text-ink-700"
            aria-label="Cancel override"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value.slice(0, 140))}
          placeholder="e.g. Artist's rider requires X; we want to lock them in before their album drops; agent asked for higher cap."
          rows={3}
          className="w-full text-[13px] text-ink-900 bg-white border border-ink-200/80 rounded-md px-3 py-2 focus:outline-none focus:ring-2 focus:ring-brand-700/30"
          autoFocus
        />
        <div className="text-[10.5px] text-ink-500 mt-1 text-right">
          {reason.length}/140
        </div>

        <div className="mt-3">
          <div className="text-[11.5px] font-medium text-ink-700 mb-1.5">
            Share this reason with the agent?
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setVisibility("public")}
              className={cn(
                "flex-1 text-[12px] py-2 rounded-md ring-1 ring-inset",
                visibility === "public"
                  ? "bg-brand-50 text-brand-800 ring-brand-300"
                  : "bg-white text-ink-700 ring-ink-200/80",
              )}
            >
              Public · shows on deal sheet
            </button>
            <button
              type="button"
              onClick={() => setVisibility("internal")}
              className={cn(
                "flex-1 text-[12px] py-2 rounded-md ring-1 ring-inset",
                visibility === "internal"
                  ? "bg-amber-50 text-amber-800 ring-amber-300"
                  : "bg-white text-ink-700 ring-ink-200/80",
              )}
            >
              Internal · GM only
            </button>
          </div>
        </div>

        <div className="mt-4 flex justify-end gap-2">
          <Button variant="secondary" size="default" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            variant="brand"
            size="default"
            onClick={() => reason.trim() && onConfirm(reason.trim(), visibility)}
            disabled={!reason.trim()}
          >
            Override
          </Button>
        </div>
      </div>
    </div>
  );
}

// ----------- BonusEditor -----------

function BonusEditor(props: {
  bonuses: BonusV2[];
  breakevenNet: number;
  onChange: (b: BonusV2[]) => void;
}) {
  const { bonuses, onChange } = props;
  const [adding, setAdding] = useState<BonusV2["type"] | null>(null);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Bonus clauses</CardTitle>
        <span className="text-[10.5px] text-ink-500">
          All bonuses trigger only after fees + expenses + recoups are covered
        </span>
      </CardHeader>
      <CardContent className="space-y-3">
        {bonuses.length === 0 && (
          <div className="text-[12px] text-ink-500 italic py-1">
            No bonus clauses on this deal.
          </div>
        )}
        {bonuses.map((b, idx) => (
          <BonusRow
            key={idx}
            bonus={b}
            onRemove={() => onChange(bonuses.filter((_, i) => i !== idx))}
            onChange={(updated) =>
              onChange(bonuses.map((x, i) => (i === idx ? updated : x)))
            }
          />
        ))}

        {adding ? (
          <BonusComposer
            type={adding}
            onCancel={() => setAdding(null)}
            onAdd={(b) => {
              onChange([...bonuses, b]);
              setAdding(null);
            }}
          />
        ) : (
          <div className="flex flex-wrap gap-2 pt-1">
            {(["net_threshold", "attendance_threshold", "sellout", "tier_ratchet"] as const).map(
              (t) => (
                <Button
                  key={t}
                  variant="outline"
                  size="sm"
                  onClick={() => setAdding(t)}
                >
                  <Plus className="w-3 h-3" />
                  {bonusTypeLabel(t)}
                </Button>
              ),
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function BonusRow(props: {
  bonus: BonusV2;
  onRemove: () => void;
  onChange: (b: BonusV2) => void;
}) {
  const { bonus, onRemove } = props;
  return (
    <div className="flex items-center justify-between gap-2 bg-ink-50/50 ring-1 ring-ink-200/60 rounded-md px-3 py-2">
      <div>
        <div className="text-[12px] font-medium text-ink-800">{bonus.label}</div>
        <div className="text-[11px] text-ink-600">
          {bonusDescription(bonus)}
        </div>
      </div>
      <button
        onClick={onRemove}
        className="text-ink-500 hover:text-rose-700"
        aria-label="Remove bonus"
      >
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}

function BonusComposer(props: {
  type: BonusV2["type"];
  onCancel: () => void;
  onAdd: (b: BonusV2) => void;
}) {
  const { type, onCancel, onAdd } = props;
  const [label, setLabel] = useState(bonusTypeLabel(type));
  const [amount, setAmount] = useState(500);
  const [threshold, setThreshold] = useState(2000);

  function submit() {
    if (type === "net_threshold") {
      onAdd({ type, label, netThreshold: threshold, amount });
    } else if (type === "attendance_threshold") {
      onAdd({ type, label, threshold, amount });
    } else if (type === "sellout") {
      onAdd({ type, label, amount });
    } else if (type === "tier_ratchet") {
      onAdd({
        type,
        label,
        tiers: [
          { fromNet: 0, toNet: threshold, percentage: 0.85 },
          { fromNet: threshold, toNet: null, percentage: 0.9 },
        ],
      });
    }
  }

  return (
    <div className="bg-ink-50/70 ring-1 ring-ink-200/60 rounded-md p-3 space-y-2">
      <div className="text-[11px] text-ink-600">
        Adding: <span className="font-medium">{bonusTypeLabel(type)}</span>
      </div>
      <input
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        placeholder="Label"
        className="w-full text-[12.5px] border border-ink-200/80 rounded-md px-2.5 py-1.5"
      />
      <div className="grid grid-cols-2 gap-2">
        {type !== "sellout" && (
          <input
            type="number"
            value={threshold}
            onChange={(e) => setThreshold(parseFloat(e.target.value) || 0)}
            placeholder={
              type === "attendance_threshold"
                ? "Attendance"
                : type === "tier_ratchet"
                  ? "Tier boundary (net)"
                  : "Net threshold"
            }
            className="text-[12.5px] border border-ink-200/80 rounded-md px-2.5 py-1.5"
          />
        )}
        {type !== "tier_ratchet" && (
          <input
            type="number"
            value={amount}
            onChange={(e) => setAmount(parseFloat(e.target.value) || 0)}
            placeholder="Bonus amount $"
            className="text-[12.5px] border border-ink-200/80 rounded-md px-2.5 py-1.5"
          />
        )}
      </div>
      <div className="flex justify-end gap-2 pt-1">
        <Button variant="secondary" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="brand" size="sm" onClick={submit}>
          Add bonus
        </Button>
      </div>
    </div>
  );
}

// ----------- helpers -----------

function buildTermEntry(
  field: string,
  finalValue: unknown,
  recommendedValue: unknown,
  provenance: Provenance | undefined,
  override: FieldOverride | undefined,
) {
  if (!provenance) return [];
  return [
    {
      field,
      recommendedValue,
      finalValue,
      overridden: !!override,
      overrideReason: override?.reason,
      overrideVisibility: override?.visibility,
      provenance: {
        summary: provenance.summary,
        source: provenance.source,
        confidence: provenance.confidence,
      },
    },
  ];
}

function bonusTypeLabel(t: BonusV2["type"]): string {
  return {
    net_threshold: "Net threshold bonus",
    attendance_threshold: "Attendance bonus",
    sellout: "Sellout bonus",
    tier_ratchet: "Tier ratchet",
  }[t];
}

function bonusDescription(b: BonusV2): string {
  if (b.type === "net_threshold")
    return `+${formatMoney(b.amount)} if net ≥ ${formatMoney(b.netThreshold)}`;
  if (b.type === "attendance_threshold")
    return `+${formatMoney(b.amount)} if attendance ≥ ${b.threshold}`;
  if (b.type === "sellout") return `+${formatMoney(b.amount)} on sellout (≥95%)`;
  if (b.type === "tier_ratchet")
    return `${b.tiers.length} tiers: ${b.tiers
      .map(
        (t) =>
          `${formatMoneyCompact(t.fromNet)}–${
            t.toNet != null ? formatMoneyCompact(t.toNet) : "∞"
          } @ ${Math.round(t.percentage * 100)}%`,
      )
      .join(", ")}`;
  return "";
}

function humanField(f: string): string {
  return (
    {
      guarantee: "the guarantee",
      artistPercentage: "the artist percentage",
      expenseCap: "the expense cap",
      hospitalityCap: "the hospitality cap",
      walkoutThreshold: "the walkout threshold",
    }[f] ?? f
  );
}

function confidenceColor(
  c: "high" | "medium" | "low",
): "brand" | "amber" | "rose" {
  if (c === "high") return "brand";
  if (c === "medium") return "amber";
  return "rose";
}
