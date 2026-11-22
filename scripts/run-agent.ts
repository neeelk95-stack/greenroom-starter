/**
 * Run the Deal Ledger agent from the terminal (a demo backup, and handy for testing).
 *
 *   npm run agent -- --show show_coastal_spell_dispute --profile local
 *   npm run agent -- --show show_0018 --profile rules
 *   npm run agent -- --show show_0007 --profile mixed --ask "What if the walkout is 100% of the overage?"
 */

import "../lib/loadEnv";
import { runAgent, askAssistant } from "../lib/agent/agent";
import { sampleOfferEmail } from "../lib/agent/offerEmails";
import { getShow } from "../lib/agent/tools";
import { defaultProfile, isProfile } from "../lib/agent/routing";
import { MODELS } from "../lib/agent/models";
import { saveRun } from "../lib/agent/runStore";
import { client } from "../db/index";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

async function main() {
  const showId = arg("show") ?? "show_coastal_spell_dispute";
  const p = arg("profile");
  const profile = isProfile(p) ? p : defaultProfile();
  const ctx = await getShow(showId);
  if (!ctx) throw new Error(`No deal for ${showId}`);
  const email = sampleOfferEmail(ctx.data);

  console.log(`\nBackstage (Deal Ledger agent) · ${ctx.data.artist?.name} · profile: ${profile}\n`);
  console.log(email.text.split("\n").map((l) => `  │ ${l}`).join("\n"), "\n");

  const run = await runAgent(showId, email.text, email.from, email.fromFirstName, profile);
  for (const s of run.steps) {
    const m = s.model;
    const modelInfo = m
      ? `  [${MODELS[m.model].label}${m.escalated ? ", escalated" : ""}${m.fellBack ? ", fallback" : ""} · ${m.totals.inputTokens}/${m.totals.outputTokens} tok · ${m.totals.latencyMs} ms · $${m.totals.costUsd.toFixed(5)}]`
      : "";
    console.log(`${s.status === "done" ? "✓" : s.status === "locked" ? "■" : "•"} ${s.label} — ${s.autonomyLabel}${modelInfo}\n    ${s.summary}`);
    m?.attempts.filter((a) => a.status !== "ok").forEach((a) => console.log(`      ${a.model}: ${a.status}${a.reason ? ` (${a.reason})` : ""}${a.problems?.length ? ` ${a.problems.join("; ")}` : ""}`));
  }
  console.log(`\nTerms:`);
  for (const t of run.termChecks) {
    if (t.value == null && t.recordValue == null) continue;
    const status = t.value == null ? "not in email" : t.verified ? "cited ✓" : "cited ✗";
    const diff = t.value != null && t.recordValue != null && !t.matchesRecord ? "  ← differs from record" : "";
    console.log(`  ${t.field.padEnd(16)} ${String(t.value ?? "—").padEnd(10)} ${status.padEnd(13)} record: ${t.recordValue ?? "—"}${diff}${t.citation ? `   "${t.citation}"` : ""}`);
  }
  if (run.flags.length) {
    console.log(`\nFlags:`);
    for (const f of run.flags) {
      console.log(`  ${f.label}: "${f.quote}"`);
      if (f.price) {
        console.log(`    at this show's numbers: ${f.price.actual.options.map((o) => `${o.label} $${Math.round(o.totalToArtist)}`).join(" vs ")}`);
        if (f.price.atCap) console.log(`    if receipts reach the cap: ${f.price.atCap.options.map((o) => `${o.label} $${Math.round(o.totalToArtist)}`).join(" vs ")}`);
      }
    }
  }
  if (run.draft) console.log(`\nDraft to Drake (not sent):\n  Subject: ${run.draft.subject}\n${run.draft.body.split("\n").map((l) => `  ${l}`).join("\n")}`);
  console.log(`\nSummary for Drake${run.settlement.summaryGrounded ? " (numbers checked)" : " (engine template)"}:\n  ${run.settlement.summary}`);
  console.log(`\nTotals: ${run.totals.modelCalls} model calls · ${run.totals.inputTokens}/${run.totals.outputTokens} tokens · ${(run.totals.latencyMs / 1000).toFixed(1)} s · $${run.totals.costUsd.toFixed(4)}`);

  const q = arg("ask");
  if (q) {
    const qa = await askAssistant(run, q);
    run.qa.push(qa);
    console.log(`\nQ: ${q}\nA: ${qa.answer}${qa.whatIf ? `\n   (engine what-if: ${qa.whatIf.description}: $${Math.round(qa.whatIf.oldTotal)} → $${Math.round(qa.whatIf.newTotal)})` : ""}`);
  }
  if (process.argv.includes("--save")) await saveRun(run);
  client.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
