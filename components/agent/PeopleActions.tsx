"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, LockKeyhole, Loader2, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { approveAction, confirmTermsAction, releasePayoutAction } from "@/app/shows/[id]/agent/actions";

function useAction() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const go = (fn: () => Promise<{ ok: boolean; error?: string }>) =>
    start(async () => {
      setError(null);
      const r = await fn();
      if (!r.ok) setError(r.error ?? "Something went wrong");
      router.refresh();
    });
  return { pending, error, go };
}

export function ConfirmTermsButton({ showId }: { showId: string }) {
  const { pending, error, go } = useAction();
  return (
    <div className="flex items-center gap-3">
      <Button variant="default" size="sm" disabled={pending} onClick={() => go(() => confirmTermsAction(showId))}>
        {pending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
        Ethan confirms the terms
      </Button>
      {error && <span className="text-[12px] text-rose-700">{error}</span>}
    </div>
  );
}

export function PayoutPanel({
  showId,
  termsConfirmed,
  booker,
  tourManager,
  released,
  note,
  total,
}: {
  showId: string;
  termsConfirmed: boolean;
  booker?: string;
  tourManager?: string;
  released: boolean;
  note?: string;
  total: string;
}) {
  const { pending, error, go } = useAction();
  const ready = termsConfirmed && !!booker && !!tourManager && !released;
  return (
    <div className="space-y-4">
      <div className="grid sm:grid-cols-2 gap-2">
        <Button variant={booker ? "secondary" : "default"} disabled={pending || !!booker || !termsConfirmed} onClick={() => go(() => approveAction(showId, "booker"))}>
          {booker ? <Check className="h-3.5 w-3.5 text-brand-700" /> : <ShieldCheck className="h-3.5 w-3.5" />}
          {booker ? `Approved by ${booker}` : "Ethan approves"}
        </Button>
        <Button variant={tourManager ? "secondary" : "default"} disabled={pending || !!tourManager || !termsConfirmed} onClick={() => go(() => approveAction(showId, "tourManager"))}>
          {tourManager ? <Check className="h-3.5 w-3.5 text-brand-700" /> : <ShieldCheck className="h-3.5 w-3.5" />}
          {tourManager ? `Accepted by ${tourManager}` : "Drake accepts"}
        </Button>
      </div>
      <Button variant="brand" size="lg" className="w-full" disabled={!ready || pending} onClick={() => go(() => releasePayoutAction(showId))}>
        {released ? <Check className="h-4 w-4" /> : <LockKeyhole className="h-4 w-4" />}
        {released ? `Payout of ${total} released` : `Release payout of ${total}`}
      </Button>
      <p className="text-[12px] text-ink-500 leading-relaxed">
        {released
          ? note
          : !termsConfirmed
            ? "Locked: Ethan has to confirm the deal terms first."
            : "Locked until Ethan approves and Drake accepts. Then a plain rule releases it. Backstage has no tool for this step, so no prompt can make it move money."}
      </p>
      {error && <div className="text-[12px] text-rose-700">{error}</div>}
    </div>
  );
}
