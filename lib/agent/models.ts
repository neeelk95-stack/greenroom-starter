/**
 * Model registry for the Deal Ledger agent.
 *
 * Every model the agent can use is listed here with its provider, the API
 * model id, and list prices (USD per million tokens, Nov 2026). The gateway
 * (`router.ts`) reads this to call the model and to log cost per call.
 *
 * "rules" is not a model: it's the deterministic v1 implementation (regex and
 * templates). It costs nothing, runs offline, and is the baseline every model
 * has to beat in the eval harness.
 */

export type ModelKey =
  | "rules"
  | "gemma-local"
  | "haiku-5.5"
  | "sonnet-5.5"
  | "opus-5.5"
  | "gpt-6-luna"
  | "gpt-6.1-sol";

export type Provider = "rules" | "openai_compatible" | "anthropic" | "openai";

export type ModelSpec = {
  key: ModelKey;
  label: string;
  provider: Provider;
  /** The id sent to the provider's API. */
  apiModel: string;
  /** USD per million input / output tokens (list price). */
  inputPerM: number;
  outputPerM: number;
  /** Runs on this machine; nothing leaves the laptop. */
  local: boolean;
  note: string;
};

const env = (k: string, fallback: string) => process.env[k]?.trim() || fallback;

export const MODELS: Record<ModelKey, ModelSpec> = {
  rules: {
    key: "rules",
    label: "Rules (no AI)",
    provider: "rules",
    apiModel: "",
    inputPerM: 0,
    outputPerM: 0,
    local: true,
    note: "Deterministic v1 baseline: regex and templates. Free, offline, the bar every model must beat.",
  },
  "gemma-local": {
    key: "gemma-local",
    label: "Gemma 4 12B (local)",
    provider: "openai_compatible",
    apiModel: env("LOCAL_MODEL", "gemma4:12b"),
    inputPerM: 0,
    outputPerM: 0,
    local: true,
    note: "Open weights, runs on the laptop through Ollama or LM Studio. No per-token cost; data never leaves the machine.",
  },
  "haiku-5.5": {
    key: "haiku-5.5",
    label: "Claude Haiku 5.5",
    provider: "anthropic",
    apiModel: env("ANTHROPIC_HAIKU_MODEL", "claude-haiku-5-5"),
    inputPerM: 0.1,
    outputPerM: 0.5,
    local: false,
    note: "Cheap, fast default for simple steps. Price rises 5x above 100K-token prompts; the gateway caps prompts well below that.",
  },
  "sonnet-5.5": {
    key: "sonnet-5.5",
    label: "Claude Sonnet 5.5",
    provider: "anthropic",
    apiModel: env("ANTHROPIC_SONNET_MODEL", "claude-sonnet-5-5"),
    inputPerM: 2,
    outputPerM: 10,
    local: false,
    note: "Mid tier. Used for the reasoning step (finding terms with two readings) and for escalations.",
  },
  "opus-5.5": {
    key: "opus-5.5",
    label: "Claude Opus 5.5",
    provider: "anthropic",
    apiModel: env("ANTHROPIC_OPUS_MODEL", "claude-opus-5-5"),
    inputPerM: 4,
    outputPerM: 20,
    local: false,
    note: "Frontier. Only if Sonnet misses cases in the eval harness.",
  },
  "gpt-6-luna": {
    key: "gpt-6-luna",
    label: "GPT-6 Luna",
    provider: "openai",
    apiModel: env("OPENAI_LUNA_MODEL", "gpt-6-luna"),
    inputPerM: 0.1,
    outputPerM: 0.5,
    local: false,
    note: "Same list price as Haiku 5.5. Fallback for simple steps if Anthropic is down.",
  },
  "gpt-6.1-sol": {
    key: "gpt-6.1-sol",
    label: "GPT-6.1 Sol",
    provider: "openai",
    apiModel: env("OPENAI_SOL_MODEL", "gpt-6.1-sol"),
    inputPerM: 2,
    outputPerM: 10,
    local: false,
    note: "Same list price as Sonnet 5.5. Fallback for the reasoning step.",
  },
};

export const MODEL_KEYS = Object.keys(MODELS) as ModelKey[];

export function isModelKey(k: string): k is ModelKey {
  return (MODEL_KEYS as string[]).includes(k);
}

export function costUsd(model: ModelKey, inputTokens: number, outputTokens: number): number {
  const m = MODELS[model];
  return (inputTokens * m.inputPerM + outputTokens * m.outputPerM) / 1_000_000;
}

export function localBaseUrl(): string {
  return env("LOCAL_BASE_URL", "http://localhost:11434/v1").replace(/\/+$/, "");
}

/**
 * Whether a model can be called right now, and if not, why. Local
 * reachability is checked at call time (a refused connection marks it down
 * for a minute); keys are checked here.
 */
export function availability(model: ModelKey): { ok: boolean; reason?: string } {
  const spec = MODELS[model];
  switch (spec.provider) {
    case "rules":
      return { ok: true };
    case "openai_compatible":
      if (localDownUntil > Date.now()) return { ok: false, reason: `Local model not reachable at ${localBaseUrl()}` };
      return { ok: true };
    case "anthropic":
      return process.env.ANTHROPIC_API_KEY ? { ok: true } : { ok: false, reason: "No ANTHROPIC_API_KEY set" };
    case "openai":
      return process.env.OPENAI_API_KEY ? { ok: true } : { ok: false, reason: "No OPENAI_API_KEY set" };
  }
}

let localDownUntil = 0;
export function markLocalDown(ms = 60_000) {
  localDownUntil = Date.now() + ms;
}

/** Quick reachability check for the local model server (used by the UI). */
export async function checkLocalModel(timeoutMs = 800): Promise<{ ok: boolean; models: string[]; reason?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${localBaseUrl()}/models`, { signal: controller.signal, cache: "no-store" });
    if (!res.ok) return { ok: false, models: [], reason: `HTTP ${res.status}` };
    const data = await res.json();
    const models = Array.isArray(data?.data) ? data.data.map((m: { id: string }) => m.id) : [];
    return { ok: true, models };
  } catch {
    return { ok: false, models: [], reason: `Nothing answering at ${localBaseUrl()}` };
  } finally {
    clearTimeout(timer);
  }
}
