/**
 * Sample offer emails for the demo. There are no raw agent emails in the
 * dataset, so each sample wraps the deal notes Mariana typed from the agent's
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
      from: "Andrea Pelletier (WME)",
      fromFirstName: "Andrea",
      source: "Reconstructed from the dispute thread; the deal clause is quoted word for word.",
      text:
        `Hi Mariana,\n\nConfirming Coastal Spell at ${venue} on ${date}.\n\n` +
        `$5,000 vs 80% of net after expenses, whichever greater. Expenses capped at $2,500, marketing recoup of $900 against gross. ` +
        `Hospitality cap $500. +$1,000 bonus if gross exceeds $25,000.\n\nThanks,\nAndrea`,
    };
  }

  const agentName = data.agent?.name ?? "The agent";
  const first = agentName.split(" ")[0];
  const notes = (data.deal?.dealNotesFreetext ?? "")
    .replace(/\s*\(Note added[^)]*\)\s*/gi, " ")
    .trim();
  return {
    from: `${agentName}${data.agency?.name ? ` (${data.agency.name})` : ""}`,
    fromFirstName: first,
    source: "Built from the deal notes in the dataset.",
    text: `Hi Mariana,\n\nConfirming ${artist} at ${venue} on ${date}.\n\n${notes}\n\nThanks,\n${first}`,
  };
}
