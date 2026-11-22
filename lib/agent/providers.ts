/**
 * One function to call any model: Anthropic, OpenAI, or a local
 * OpenAI-compatible server (Ollama, LM Studio) running Gemma.
 *
 * Plain fetch, no SDKs, so swapping providers never touches the tasks.
 * Returns the text plus what the gateway logs: tokens, latency, cost.
 */

import { MODELS, costUsd, localBaseUrl, markLocalDown, type ModelKey } from "./models";

export type ModelRequest = {
  system: string;
  messages: { role: "user" | "assistant"; content: string }[];
  maxTokens: number;
  /** Ask for a JSON reply where the provider supports it. */
  json?: boolean;
};

export type ModelReply = {
  text: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  costUsd: number;
  /** True when the provider didn't report usage and tokens are estimated (chars / 4). */
  estimatedTokens: boolean;
};

const estimate = (s: string) => Math.ceil(s.length / 4);

/** Talk to Ollama through its own API (LOCAL_API=ollama), or auto-detect its default port. */
function isOllamaNative(): boolean {
  const mode = (process.env.LOCAL_API ?? "auto").toLowerCase();
  if (mode === "ollama") return true;
  if (mode === "openai") return false;
  return /:11434(\/|$)/.test(localBaseUrl());
}

// Rate limits (429), overload (529) and brief server errors are normal on a new API
// account; retry those with backoff. Bad keys, bad model names and empty credit
// balances (400/401/403/404) fail at once, with the API's own message.
const RETRY_STATUS = new Set([429, 500, 502, 503, 504, 529]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function postJson(url: string, headers: Record<string, string>, body: unknown, timeoutMs: number) {
  const maxRetries = Number(process.env.MODEL_MAX_RETRIES ?? 3);
  for (let attempt = 0; ; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      // A timeout is final; a dropped connection gets the same retries as a 5xx.
      if ((err as Error).name === "AbortError" || attempt >= maxRetries) throw err;
      await sleep(2 ** attempt * 1000 + Math.random() * 500);
      continue;
    }
    try {
      const text = await res.text();
      if (res.ok) return JSON.parse(text);
      if (RETRY_STATUS.has(res.status) && attempt < maxRetries) {
        const after = Number(res.headers.get("retry-after"));
        await sleep(after > 0 ? after * 1000 : 2 ** attempt * 1000 + Math.random() * 500);
        continue;
      }
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
    } finally {
      clearTimeout(timer);
    }
  }
}

export async function callModel(model: ModelKey, req: ModelRequest): Promise<ModelReply> {
  const spec = MODELS[model];
  const started = Date.now();
  const promptChars = req.system.length + req.messages.reduce((s, m) => s + m.content.length, 0);

  let text = "";
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;

  if (spec.provider === "anthropic") {
    const data = await postJson(
      `${(process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com").replace(/\/+$/, "")}/v1/messages`,
      { "x-api-key": process.env.ANTHROPIC_API_KEY ?? "", "anthropic-version": "2023-06-01" },
      { model: spec.apiModel, max_tokens: req.maxTokens, system: req.system, messages: req.messages },
      60_000,
    );
    text = (data.content ?? []).filter((c: { type: string }) => c.type === "text").map((c: { text: string }) => c.text).join("");
    inputTokens = data.usage?.input_tokens;
    outputTokens = data.usage?.output_tokens;
  } else if (spec.provider === "openai") {
    const data = await postJson(
      `${(process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1").replace(/\/+$/, "")}/chat/completions`,
      { authorization: `Bearer ${process.env.OPENAI_API_KEY ?? ""}` },
      {
        model: spec.apiModel,
        max_completion_tokens: req.maxTokens,
        messages: [{ role: "system", content: req.system }, ...req.messages],
        ...(req.json ? { response_format: { type: "json_object" } } : {}),
      },
      60_000,
    );
    text = data.choices?.[0]?.message?.content ?? "";
    inputTokens = data.usage?.prompt_tokens;
    outputTokens = data.usage?.completion_tokens;
  } else if (spec.provider === "openai_compatible") {
    const timeout = Number(process.env.LOCAL_TIMEOUT_MS ?? 180_000);
    const think = process.env.LOCAL_THINK === "on";
    let data;
    try {
      if (isOllamaNative()) {
        // Ollama's own API: the only place `think: false` reliably turns off Gemma 4's thinking.
        // With thinking on, each call spent its whole token budget thinking (slow, and the
        // answer got cut off). `format: "json"` makes it reply with JSON only.
        data = await postJson(
          `${localBaseUrl().replace(/\/v1$/, "")}/api/chat`,
          {},
          {
            model: spec.apiModel,
            stream: false,
            think,
            keep_alive: process.env.LOCAL_KEEP_ALIVE ?? "30m",
            ...(req.json ? { format: "json" } : {}),
            options: { temperature: 0.2, num_predict: req.maxTokens * (think ? 4 : 1) },
            messages: [{ role: "system", content: req.system }, ...req.messages],
          },
          timeout,
        );
        text = data.message?.content ?? "";
        inputTokens = data.prompt_eval_count;
        outputTokens = data.eval_count;
      } else {
        // Any other OpenAI-compatible server (LM Studio, llama.cpp, vLLM).
        data = await postJson(
          `${localBaseUrl()}/chat/completions`,
          process.env.LOCAL_API_KEY ? { authorization: `Bearer ${process.env.LOCAL_API_KEY}` } : {},
          {
            model: spec.apiModel,
            max_tokens: req.maxTokens * (think ? 4 : 1),
            temperature: 0.2,
            stream: false,
            messages: [{ role: "system", content: req.system }, ...req.messages],
          },
          timeout,
        );
        text = data.choices?.[0]?.message?.content ?? "";
        inputTokens = data.usage?.prompt_tokens;
        outputTokens = data.usage?.completion_tokens;
      }
    } catch (err) {
      const msg = String((err as Error)?.message ?? err);
      if (/ECONNREFUSED|fetch failed|ENOTFOUND|EHOSTUNREACH/i.test(msg) || (err as { cause?: { code?: string } })?.cause?.code === "ECONNREFUSED") {
        markLocalDown();
        throw new Error(`Local model not reachable at ${localBaseUrl()}. Start Ollama or LM Studio.`);
      }
      if ((err as Error)?.name === "AbortError") throw new Error(`Local model took longer than ${Math.round(timeout / 1000)} s`);
      throw err;
    }
  } else {
    throw new Error(`callModel can't call the "${model}" provider`);
  }

  const estimatedTokens = inputTokens == null || outputTokens == null;
  const inTok = inputTokens ?? estimate(" ".repeat(promptChars));
  const outTok = outputTokens ?? estimate(text);
  return {
    text,
    inputTokens: inTok,
    outputTokens: outTok,
    latencyMs: Date.now() - started,
    costUsd: costUsd(model, inTok, outTok),
    estimatedTokens,
  };
}
