import fs from "node:fs";
import path from "node:path";

/**
 * Load project-local .env files into process.env before Pi model/auth registry
 * creation. Existing process.env values win over file values.
 */
export function loadProjectEnv(cwd = process.cwd()) {
  const candidates = [
    path.join(cwd, ".env"),
    path.join(cwd, "data", ".env"),
  ];

  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;

    let text = "";
    try {
      text = fs.readFileSync(file, "utf-8");
    } catch {
      continue;
    }

    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;

      const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (!match) continue;

      const key = match[1];
      let value = match[2].trim();
      value = value.replace(/^["']|["']$/g, "");

      if (process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
  }
}
