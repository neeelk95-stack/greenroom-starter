/**
 * Self-test for the agent: no API keys, no local model needed.
 *
 *   npm run agent:test
 *
 * Spins up mock model servers (an OpenAI-compatible "local Gemma" and an
 * Anthropic endpoint) to check the gateway end to end: routing, fallback when
 * the local model is down, escalation when a citation fails, token and cost
 * logging, and the guardrails (no payout tool; payout needs both people).
 */

import http from "node:http";
import type { AddressInfo } from "node:net";
import assert from "node:assert/strict";

type Mode = { extractBadCitation: boolean };
const nativeCalls: number[] = [];
const mode: Mode = { extractBadCitation: false };

const EMAIL_GOOD_EXTRACT = {
  dealType: "vs",
  guaranteeAmount: 5000,
  percentage: 0.8,
  percentageBasis: "net",
  expenseCap: 2500,
  hospitalityCap: 500,
  bonuses: [{ label: "+$1,000 bonus if gross exceeds $25,000", kind: "gross_threshold", threshold: 25000, amount: 1000 }],
  recoups: [{ label: "marketing recoup", amount: 900 }],
  citations: {
    dealType: "$5,000 vs 80% of net",
    guaranteeAmount: "$5,000 vs",
    percentage: "80% of net after expenses",
    expenseCap: "Expenses capped at $2,500",
    hospitalityCap: "Hospitality cap $500",
  },
  confidence: "high",
};

function reply(system: string, user: string): string {
  if (system.includes("sort emails")) return JSON.stringify({ kind: "offer", reason: "Confirms the deal terms." });
  if (system.includes("extract deal terms")) {
    const out = mode.extractBadCitation
      ? { ...EMAIL_GOOD_EXTRACT, citations: { ...EMAIL_GOOD_EXTRACT.citations, guaranteeAmount: "a guarantee of five grand" } }
      : EMAIL_GOOD_EXTRACT;
    // Wrap like Gemma 4 can: an empty thinking channel, then prose, then JSON.
    return `<|channel>thought\n<channel|>Here are the terms:\n${JSON.stringify(out)}`;
  }
  if (system.includes("two different ways")) {
    return JSON.stringify({
      flags: [
        { type: "recoup_vs_cap", quote: "Expenses capped at $2,500, marketing recoup of $900 against gross", question: "Is the $900 recoup inside the cap?", readingA: "Inside the cap", readingB: "On top of the cap" },
        { type: "other", quote: "this sentence is not in the email", question: "?", readingA: "a", readingB: "b" },
      ],
    });
  }
  if (system.includes("draft short")) return JSON.stringify({ subject: "Quick check on the recoup", body: "Hi Drake, is the $900 marketing recoup inside the $2,500 cap or on top? Thanks, Ethan" });
  if (system.includes("explain a show settlement")) return JSON.stringify({ summary: "Total to artist: $13,005. We also invented $4,444 here." });
  if (system.includes("settlement table")) {
    if (user.includes("The settlement engine computed")) return JSON.stringify({ action: "answer", answer: "Deducting the recoup tonight takes the artist from $13,005 to $12,285." });
    return JSON.stringify({ action: "what_if", change: { kind: "reading", key: "disputedRecoups", value: "deduct" } });
  }
  return JSON.stringify({});
}

function startServer(kind: "openai" | "anthropic"): Promise<{ url: string; close: () => void; calls: number[] }> {
  const calls: number[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const j = JSON.parse(body || "{}");
      calls.push(1);
      if (kind === "openai" && req.url?.startsWith("/api/chat")) {
        // Ollama's native API.
        assert.equal(j.think, false, "native Ollama calls must turn thinking off");
        const system = j.messages?.find((m: { role: string }) => m.role === "system")?.content ?? "";
        const user = j.messages?.filter((m: { role: string }) => m.role === "user").map((m: { content: string }) => m.content).join("\n") ?? "";
        nativeCalls.push(1);
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ message: { role: "assistant", content: reply(system, user) }, prompt_eval_count: 300, eval_count: 60, done: true }));
      } else if (kind === "openai") {
        const system = j.messages?.find((m: { role: string }) => m.role === "system")?.content ?? "";
        const user = j.messages?.filter((m: { role: string }) => m.role === "user").map((m: { content: string }) => m.content).join("\n") ?? "";
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ choices: [{ message: { content: reply(system, user) } }], usage: { prompt_tokens: 400, completion_tokens: 80 } }));
      } else {
        assert.ok(req.headers["x-api-key"], "anthropic call must send x-api-key");
        const user = j.messages?.map((m: { content: string }) => m.content).join("\n") ?? "";
        const text = j.system?.includes("extract deal terms") ? JSON.stringify(EMAIL_GOOD_EXTRACT) : reply(j.system ?? "", user);
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ content: [{ type: "text", text }], usage: { input_tokens: 500, output_tokens: 100 } }));
      }
    });
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ url: `http://127.0.0.1:${port}`, close: () => server.close(), calls });
    }),
  );
}

let passed = 0;
async function check(name: string, fn: () => Promise<void> | void) {
  await fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

async function main() {
  const local = await startServer("openai");
  const anthropic = await startServer("anthropic");
  process.env.LOCAL_BASE_URL = `${local.url}/v1`;
  process.env.ANTHROPIC_BASE_URL = anthropic.url;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENAI_API_KEY;

  const { extractJson } = await import("../lib/agent/json");
  const { quoteAppears, ungroundedNumbers } = await import("../lib/agent/verify");
  const { checkTerms } = await import("../lib/agent/tasks/extractTerms");
  const { AGENT_TOOLS, WITHHELD_FROM_AGENT, getShow } = await import("../lib/agent/tools");
  const { autonomyOf } = await import("../lib/agent/policy");
  const { runAgent, askAssistant } = await import("../lib/agent/agent");
  const { sampleOfferEmail } = await import("../lib/agent/offerEmails");
  const { approve, confirmTerms, releasePayout } = await import("../lib/agent/approvals");
  const { client } = await import("../db/index");

  console.log("\nGuardrails");
  await check("the agent has no payout, approval or send tool", () => {
    for (const t of WITHHELD_FROM_AGENT) assert.ok(!(AGENT_TOOLS as readonly string[]).includes(t), t);
  });
  await check("releasing the payout is people-only", () => assert.equal(autonomyOf("release_payout"), "people_only"));
  await check("JSON is read through Gemma's thinking tags and prose", () => {
    assert.deepEqual(extractJson('<|channel>thought\n<channel|>Sure: {"a": {"b": 1}} done'), { a: { b: 1 } });
  });
  await check("a citation that isn't in the email fails the check", () => {
    const email = "$5,000 vs 80% of net. Expenses capped at $2,500.";
    assert.ok(quoteAppears(email, "Expenses capped at $2,500"));
    const terms = { ...EMAIL_GOOD_EXTRACT, citations: { dealType: "vs", guaranteeAmount: "five grand", percentage: "80%", expenseCap: "Expenses capped at $2,500" }, hospitalityCap: null } as unknown as Parameters<typeof checkTerms>[0];
    const problems = checkTerms(terms, email);
    assert.ok(problems.some((p) => p.startsWith("guaranteeAmount")), problems.join("; "));
  });
  await check("made-up numbers in AI text are caught", () => {
    assert.deepEqual(ungroundedNumbers("Total $13,005, plus $4,444.", [13005]), ["$4,444"]);
  });

  const ctx = await getShow("show_coastal_spell_dispute");
  assert.ok(ctx);
  const email = sampleOfferEmail(ctx!.data);

  console.log("\nGateway with a mock local model (stands in for Gemma 4 12B)");
  const run = await runAgent("show_coastal_spell_dispute", email.text, email.from, email.fromFirstName, "local");
  await check("every model step ran on the local model", () => {
    for (const s of run.steps.filter((s) => s.model)) assert.equal(s.model!.model, "gemma-local", s.label);
  });
  await check("tokens are logged and local cost is $0", () => {
    assert.ok(run.totals.inputTokens > 0 && run.totals.outputTokens > 0);
    assert.equal(run.totals.costUsd, 0);
  });
  await check("a flag whose quote isn't in the email is dropped", () => {
    assert.equal(run.flags.length, 1);
    assert.equal(run.droppedFlags, 1);
  });
  await check("the engine prices the recoup flag: $11,565 vs $12,285 if receipts reach the cap", () => {
    const at = run.flags[0].price!.atCap!;
    assert.deepEqual(at.options.map((o) => Math.round(o.totalToArtist)).sort(), [11565, 12285]);
  });
  await check("an ambiguous term blocks auto-commit", () => assert.equal(run.termsStatus, "waiting_for_booker"));
  await check("a summary with a made-up number is replaced by the engine's", () => {
    assert.equal(run.settlement.summaryGrounded, false);
    assert.ok(!run.settlement.summary.includes("4,444"));
  });
  await check("the assistant asks the engine for a what-if and explains it", async () => {
    const qa = await askAssistant(run, "What if the disputed recoup is deducted tonight?");
    assert.equal(Math.round(qa.whatIf!.newTotal), 12285);
    assert.ok(qa.answer.includes("12,285"));
  });

  console.log("\nFallback and escalation");
  await check("if the local model is down, the agent falls back to rules and keeps going", async () => {
    process.env.LOCAL_BASE_URL = "http://127.0.0.1:9/v1";
    const r = await runAgent("show_coastal_spell_dispute", email.text, email.from, email.fromFirstName, "local");
    const ext = r.steps.find((s) => s.action === "extract_terms")!.model!;
    assert.equal(ext.model, "rules");
    assert.ok(ext.attempts.some((a) => a.model === "gemma-local" && (a.status === "error" || a.status === "skipped")));
    const first = r.steps.find((s) => s.action === "read_email")!.model!;
    assert.ok(first.attempts.some((a) => a.model === "gemma-local" && a.status === "error" && /not reachable/.test(a.reason ?? "")));
  });
  await check("a failed citation escalates to Haiku 5.5, and the cost uses Haiku's price", async () => {
    const models = await import("../lib/agent/models");
    models.markLocalDown(0);
    process.env.LOCAL_BASE_URL = `${local.url}/v1`;
    process.env.ANTHROPIC_API_KEY = "test-key";
    mode.extractBadCitation = true;
    const r = await runAgent("show_coastal_spell_dispute", email.text, email.from, email.fromFirstName, "private-hybrid");
    const ext = r.steps.find((s) => s.action === "extract_terms")!.model!;
    assert.equal(ext.model, "haiku-5.5");
    assert.equal(ext.escalated, true);
    const haikuCall = ext.attempts.find((a) => a.model === "haiku-5.5")!;
    assert.ok(Math.abs(haikuCall.costUsd - (500 * 0.1 + 100 * 0.5) / 1e6) < 1e-9);
    const rd = r.steps.find((s) => s.action === "flag_two_readings")!.model!;
    assert.equal(rd.model, "sonnet-5.5", "the reasoning step routes to Sonnet in private-hybrid");
    mode.extractBadCitation = false;
    delete process.env.ANTHROPIC_API_KEY;
  });

  await check("with LOCAL_API=ollama, Gemma is called through Ollama's own API with thinking off", async () => {
    process.env.LOCAL_API = "ollama";
    const before = nativeCalls.length;
    const r = await runAgent("show_coastal_spell_dispute", email.text, email.from, email.fromFirstName, "local");
    assert.ok(nativeCalls.length > before);
    const ext = r.steps.find((s) => s.action === "extract_terms")!.model!;
    assert.equal(ext.model, "gemma-local");
    assert.equal(ext.totals.outputTokens, 60);
    delete process.env.LOCAL_API;
  });

  console.log("\nTwo-readings checks");
  const { checkFlag, verifyFlags, typeIsOpen } = await import("../lib/agent/tasks/flagChecks");
  const { rulesReadings } = await import("../lib/agent/tasks/findTwoReadings");
  const { buildReadingsCases, buildNewWordingCases, buildDisputedCases } = await import("../lib/agent/evalData");
  const readingSets = [...(await buildReadingsCases()), ...buildNewWordingCases(), ...(await buildDisputedCases())];
  const caseById = (id: string) => readingSets.find((c) => c.id === id)!;
  const flag = (type: string, quote: string) => ({ type, quote, question: "?", readingA: "One way", readingB: "The other way" }) as Parameters<typeof checkFlag>[1];
  const sentenceWith = (email: string, words: string) => email.split(/\n/).find((l) => l.includes(words))!.trim();
  await check("no real clause in any eval set is blocked by the checks", () => {
    const blocked = readingSets.flatMap((c) => c.truth.filter((t) => !typeIsOpen(c.email, t)).map((t) => `${c.id}: ${t}`));
    assert.deepEqual(blocked, []);
  });
  await check("wording that settles the question drops the flag", () => {
    const settled: [string, string, string][] = [
      ["recoup-explicit-0", "recoup_vs_cap", "included in the expense cap"],
      ["recoup-explicit-1", "recoup_vs_cap", "in addition to the expense cap"],
      ["door-explicit-0", "door_fees", "after ticketing fees"],
      ["new-clear-recoup", "recoup_vs_cap", "counts toward that cap"],
      ["new-clear-door", "door_fees", "net of ticketing fees"],
      ["new-clear-ratchet", "ratchet_scope", "rising to 85%"],
      ["new-clear-bonus", "walkout_amount", "fixed $1,000 bonus"],
    ];
    for (const [id, type, words] of settled) {
      const c = caseById(id);
      const r = checkFlag(c.email, flag(type, sentenceWith(c.email, words)));
      assert.ok(!r.ok && r.reason === "answered", `${id}: ${JSON.stringify(r)}`);
    }
  });
  await check("a recoup or ratchet flag on a plain deal is dropped: the clause isn't there", () => {
    const c = caseById("clean-vs-0");
    const r1 = checkFlag(c.email, flag("recoup_vs_cap", sentenceWith(c.email, "Expenses capped")));
    const r2 = checkFlag(c.email, flag("ratchet_scope", sentenceWith(c.email, "of net")));
    assert.ok(!r1.ok && r1.reason === "clause" && !r2.ok && r2.reason === "clause");
  });
  await check("a flag about logistics is dropped; the same type about money is kept", () => {
    const c = caseById("new-clear-logistics");
    const r = checkFlag(c.email, flag("other", "two drink tickets each"));
    assert.ok(!r.ok && r.reason === "money");
    assert.ok(checkFlag(caseById("coastal-spell-real").email, flag("recoup_vs_cap", "marketing recoup of $900 against gross")).ok);
  });
  await check("two identical readings are dropped", () => {
    const c = caseById("coastal-spell-real");
    const r = checkFlag(c.email, { ...flag("recoup_vs_cap", "marketing recoup of $900 against gross"), readingA: "Inside the cap", readingB: "inside the cap." });
    assert.ok(!r.ok && r.reason === "readings");
  });
  await check("the rules baseline loses nothing to the checks", () => {
    for (const c of readingSets) {
      const raw = rulesReadings(c.email);
      assert.equal(verifyFlags(c.email, raw).flags.length, raw.length, c.id);
    }
  });

  console.log("\nCloud API handling");
  const { parseEnv } = await import("../lib/loadEnv");
  const { callModel } = await import("../lib/agent/providers");
  await check(".env.local parsing: comments, quotes and export are handled", () => {
    const env = parseEnv('# key\nANTHROPIC_API_KEY="sk-test"\nexport AGENT_PROFILE=haiku # inline\nEMPTY=\nbad line');
    assert.deepEqual(env, { ANTHROPIC_API_KEY: "sk-test", AGENT_PROFILE: "haiku", EMPTY: "" });
  });
  const flaky = async (statuses: number[]) => {
    const seen: number[] = [];
    const srv = http.createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        const status = statuses[Math.min(seen.length, statuses.length - 1)];
        seen.push(status);
        res.statusCode = status;
        if (status !== 200) res.setHeader("retry-after", "0");
        res.setHeader("content-type", "application/json");
        res.end(status === 200
          ? JSON.stringify({ content: [{ type: "text", text: '{"ok":true}' }], usage: { input_tokens: 12, output_tokens: 4 } })
          : JSON.stringify({ type: "error", error: { message: `status ${status}` } }));
      });
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    return { url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`, seen, close: () => srv.close() };
  };
  const withAnthropic = async (url: string, fn: () => Promise<void>) => {
    const saved = { base: process.env.ANTHROPIC_BASE_URL, key: process.env.ANTHROPIC_API_KEY };
    process.env.ANTHROPIC_BASE_URL = url;
    process.env.ANTHROPIC_API_KEY = "test-key";
    try {
      await fn();
    } finally {
      process.env.ANTHROPIC_BASE_URL = saved.base;
      if (saved.key === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = saved.key;
    }
  };
  await check("a rate limit (429) or overload (529) is retried, then succeeds", async () => {
    const srv = await flaky([429, 529, 200]);
    await withAnthropic(srv.url, async () => {
      const r = await callModel("haiku-5.5", { system: "s", messages: [{ role: "user", content: "u" }], maxTokens: 10 });
      assert.equal(r.text, '{"ok":true}');
      assert.deepEqual(srv.seen, [429, 529, 200]);
    });
    srv.close();
  });
  await check("a bad key (401) fails at once with the API's message", async () => {
    const srv = await flaky([401]);
    await withAnthropic(srv.url, async () => {
      await assert.rejects(
        callModel("haiku-5.5", { system: "s", messages: [{ role: "user", content: "u" }], maxTokens: 10 }),
        /HTTP 401/,
      );
      assert.equal(srv.seen.length, 1);
    });
    srv.close();
  });

  console.log("\nPeople-only steps");
  await check("the payout can't be released without both approvals", () => {
    assert.throws(() => releasePayout(run));
    let r = confirmTerms(run, "Ethan");
    r = approve(r, "booker", "Ethan");
    assert.throws(() => releasePayout(r));
    r = approve(r, "tourManager", "Drake");
    r = releasePayout(r);
    assert.equal(r.payout.released, true);
    assert.ok(r.payout.note!.includes("Not an agent action"));
  });

  local.close();
  anthropic.close();
  client.close();
  console.log(`\n${passed} checks passed.\n`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
