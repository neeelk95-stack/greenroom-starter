/**
 * Sample offer emails for the demo. There are no raw agent emails in the
 * dataset, so each sample wraps the deal notes Ethan typed from the agent's
 * email. Coastal Spell is reconstructed from the dispute thread
 * (data/dispute-thread.md), using the exact clause that caused the dispute.
 */

import { format, parseISO } from "date-fns";
import type { ShowWithRelations } from "@/lib/queries";

export type OfferEmail = { from: string; fromFirstName: string; text: string; source: string };

export function sampleOfferEmail(data: ShowWithRelations): OfferEmail {
  const artist = data.artist?.name ?? "the artist";
  const venue = data.venue?.name ?? "the venue";
  const date = format(parseISO(data.show.date), "EEEE, MMMM d");

  if (data.show.id === "show_coastal_spell_dispute") {
    return {
      from: "Drake (WME, for Coastal Spell)",
      fromFirstName: "Drake",
      source: "Reconstructed from the dispute thread; the deal clause is quoted word for word.",
      text:
        `Hi Ethan,\n\nConfirming Coastal Spell at ${venue} on ${date}.\n\n` +
        `$5,000 vs 80% of net after expenses, whichever greater. Expenses capped at $2,500, marketing recoup of $900 against gross. ` +
        `Hospitality cap $500. +$1,000 bonus if gross exceeds $25,000.\n\nThanks,\nDrake`,
    };
  }

  const notes = (data.deal?.dealNotesFreetext ?? "")
    .replace(/\s*\(Note added[^)]*\)\s*/gi, " ")
    .trim();
  return {
    from: `Drake (${data.agency?.name ? `${data.agency.name}, ` : ""}for ${artist})`,
    fromFirstName: "Drake",
    source: "Built from the deal notes in the dataset.",
    text: `Hi Ethan,\n\nConfirming ${artist} at ${venue} on ${date}.\n\n${notes}\n\nThanks,\nDrake`,
  };
}
