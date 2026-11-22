/**
 * One tiny call per model, to check the key, the model name and the credit
 * balance before a long eval run. Costs a fraction of a cent.
 *
 *   npm run models:check                                  # every configured model
 *   npm run models:check -- --models haiku-5.5,sonnet-5.5
 */
import "../lib/loadEnv";
import { MODELS, MODEL_KEYS, availability, isModelKey, type ModelKey } from "../lib/agent/models";
import { callModel } from "../lib/agent/providers";

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

async function main() {
  const requested = (arg("models") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const unknown = requested.filter((m) => !isModelKey(m));
  if (unknown.length) console.log(`Unknown model keys: ${unknown.join(", ")}. Known: ${MODEL_KEYS.join(", ")}`);
  const models: ModelKey[] = requested.length ? requested.filter(isModelKey) : MODEL_KEYS.filter((m) => m !== "rules");

  let ok = 0;
  for (const m of models) {
    const spec = MODELS[m];
    const av = availability(m);
    if (!av.ok) {
      console.log(`✗ ${spec.label}: ${av.reason}`);
      continue;
    }
    try {
      const r = await callModel(m, {
        system: "Reply with JSON only.",
        messages: [{ role: "user", content: 'Reply {"ok": true}' }],
        maxTokens: 20,
        json: true,
      });
      console.log(`✓ ${spec.label} (${spec.apiModel}): ${r.latencyMs} ms, ${r.inputTokens ?? "?"} in / ${r.outputTokens ?? "?"} out tokens`);
      ok++;
    } catch (err) {
      console.log(`✗ ${spec.label} (${spec.apiModel}): ${(err as Error).message.slice(0, 300)}`);
    }
  }
  if (ok < models.length) {
    console.log("\nFix the ✗ lines before running the eval. Common causes: the key isn't in .env.local, the account has no credits yet, or the model name is different (override with ANTHROPIC_HAIKU_MODEL / ANTHROPIC_SONNET_MODEL).");
    process.exitCode = 1;
  }
}

main();
