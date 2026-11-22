/**
 * Pull the JSON object out of a model reply. Local models in particular may
 * wrap it in prose, code fences or (Gemma 4) an empty thinking channel.
 */

export function extractJson(text: string): unknown {
  const cleaned = text
    .replace(/<\|?channel\|?>[\s\S]*?<\|?\/?channel\|?>/g, "")
    .replace(/<think>[\s\S]*?<\/think>/g, "")
    .replace(/```(?:json)?/gi, "")
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    // fall through to scanning
  }
  for (let start = cleaned.indexOf("{"); start !== -1; start = cleaned.indexOf("{", start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < cleaned.length; i++) {
      const ch = cleaned[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          try {
            return JSON.parse(cleaned.slice(start, i + 1));
          } catch {
            break;
          }
        }
      }
    }
  }
  throw new Error("No JSON object found in the model's reply");
}
