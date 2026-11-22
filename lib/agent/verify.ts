/**
 * Deterministic checks on model output. These are what let the agent act on
 * its own: a model's claim is only trusted when code can verify it.
 *
 *  - quoteAppears: the model's citation must be words that are really in the email.
 *  - quoteSupportsNumber: the cited words must contain the number the model extracted.
 *  - ungroundedNumbers: every number in AI-written text must exist in the data
 *    (engine output, deal terms, the email). Anything else is a made-up number.
 */

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[‘’‛]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—−]/g, "-")
    .replace(/\s+/g, " ")
    .trim();

export function quoteAppears(source: string, quote: string | null | undefined): boolean {
  if (!quote || quote.trim().length < 2) return false;
  const q = norm(quote).replace(/^["'.\s]+|["'.\s]+$/g, "");
  return q.length >= 2 && norm(source).includes(q);
}

/** Numbers mentioned in text, with "k" and percentages expanded. */
export function numbersIn(text: string): { value: number; percent: boolean; raw: string }[] {
  const out: { value: number; percent: boolean; raw: string }[] = [];
  const re = /(\$)?(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s*(k\b|%|\/\s?\d{1,2}\b)?/gi;
  for (const m of text.matchAll(re)) {
    let value = parseFloat(m[2].replace(/,/g, ""));
    const suffix = (m[3] ?? "").toLowerCase();
    if (suffix === "k") value *= 1000;
    out.push({ value, percent: suffix === "%" || suffix.startsWith("/"), raw: m[0] });
  }
  return out;
}

export function quoteSupportsNumber(quote: string, value: number, kind: "money" | "percent"): boolean {
  const nums = numbersIn(quote);
  if (kind === "percent") {
    const target = Math.round(value * 1000) / 10; // 0.8 -> 80
    return nums.some((n) => Math.abs(n.value - target) < 0.6);
  }
  return nums.some((n) => !n.percent && Math.abs(n.value - value) < 1);
}

/**
 * Numbers in `text` that don't appear in `allowed`. Small integers (< 10) and
 * calendar years are ignored; percentages are compared as percentages.
 */
export function ungroundedNumbers(text: string, allowed: number[]): string[] {
  const allowedMoney = allowed.map((n) => Math.round(n));
  const bad: string[] = [];
  for (const n of numbersIn(text)) {
    if (n.value < 10) continue;
    if (!n.raw.includes("$") && n.value >= 1990 && n.value <= 2100 && Number.isInteger(n.value)) continue;
    if (n.percent) {
      const ok = allowed.some((a) => Math.abs(a * 100 - n.value) < 0.6 || Math.abs(a - n.value) < 0.6);
      if (!ok) bad.push(n.raw.trim());
      continue;
    }
    const ok = allowedMoney.some((a) => Math.abs(a - n.value) <= 1);
    if (!ok) bad.push(n.raw.trim());
  }
  return Array.from(new Set(bad));
}
