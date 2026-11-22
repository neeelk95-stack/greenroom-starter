/**
 * Next.js reads .env.local on its own; the command-line scripts (npm run agent,
 * npm run eval, npm run models:check) don't. Importing this module first loads
 * .env.local and then .env, without overriding anything already set in the
 * shell. Keys stay on your machine; nothing here prints them.
 */
import fs from "node:fs";
import path from "node:path";

/** KEY=value lines; # comments; optional quotes and "export". */
export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    const [, key, rest] = m;
    let value = rest.trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, "");
    }
    out[key] = value;
  }
  return out;
}

function load(file: string) {
  let text: string;
  try {
    text = fs.readFileSync(path.join(process.cwd(), file), "utf-8");
  } catch {
    return;
  }
  for (const [key, value] of Object.entries(parseEnv(text))) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

load(".env.local");
load(".env");
