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

async function postJson(url: string, headers: Record<string, string>, body: unknown, timeoutMs: number) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
    return JSON.parse(text);
  } finally {
    clearTimeout(timer);
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
    let data;
    try {
      data = await postJson(
        `${localBaseUrl()}/chat/completions`,
        process.env.LOCAL_API_KEY ? { authorization: `Bearer ${process.env.LOCAL_API_KEY}` } : {},
        {
          model: spec.apiModel,
          // Local models may spend tokens "thinking"; give them room.
          max_tokens: req.maxTokens * 2,
          temperature: 0.2,
          stream: false,
          // Ollama: ask Gemma 4 to skip its thinking mode unless LOCAL_THINK=on (faster; the tasks
          // don't need it). Servers that don't know this field ignore it.
          ...(process.env.LOCAL_THINK === "on" ? {} : { think: false }),
          messages: [{ role: "system", content: req.system }, ...req.messages],
        },
        Number(process.env.LOCAL_TIMEOUT_MS ?? 180_000),
      );
    } catch (err) {
      const msg = String((err as Error)?.message ?? err);
      if (/ECONNREFUSED|fetch failed|ENOTFOUND|EHOSTUNREACH/i.test(msg) || (err as { cause?: { code?: string } })?.cause?.code === "ECONNREFUSED") {
        markLocalDown();
        throw new Error(`Local model not reachable at ${localBaseUrl()}. Start Ollama or LM Studio.`);
      }
      throw err;
    }
    const msg = data.choices?.[0]?.message ?? {};
    text = msg.content || msg.reasoning_content || msg.reasoning || "";
    inputTokens = data.usage?.prompt_tokens;
    outputTokens = data.usage?.completion_tokens;
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
