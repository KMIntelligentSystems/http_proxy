/**
 * run_sarima tool support — flow-1 (interactive) SARIMA exploration.
 *
 * Spawns the checked-in fitter pipelines/shared/sarima_fit.py with a JSON
 * payload on stdin and returns the canonical result. This is the INTERACTIVE
 * path: the agent sets the params, the human reviews the artifacts. Nothing
 * here is frozen; freezing is the later, explicit act of transcribing a
 * validated spec into pipelines/<name>@<version>/run.py + the contract digest.
 * (At freeze time the run.py must be self-contained — the broker's
 * pipelineDigest hashes only the entrypoint file.)
 *
 * Series resolution: pass inline observations, or a seriesId from the checked-
 * in data/series-map.json (reads the validated backbone from artifacts.db via
 * the same artifact_latest path the refresh-history bridge uses).
 */
import path from "node:path";
import { spawn } from "node:child_process";
import { readBackboneObservations } from "./refresh-history-bridge.js";

export interface SarimaParams {
  seriesId?: string;
  observations?: { date: string; value: number }[];
  order: [number, number, number];
  seasonal_order: [number, number, number, number];
  transformation?: "none" | "log";
  trend?: "n" | "c" | "drift";
  horizon?: number;
  piLevels?: number[];
}

export interface SarimaOutcome {
  ok: boolean;
  result?: Record<string, unknown>;
  error?: string;
  provenance?: { seriesId?: string; artifactId?: string; range?: [string, string]; nObs: number };
}

const SCRIPT = path.resolve(process.cwd(), "pipelines", "shared", "sarima_fit.py");

export async function runSarima(params: SarimaParams): Promise<SarimaOutcome> {
  // Resolve observations.
  let observations = params.observations;
  let provenance: SarimaOutcome["provenance"];
  if (!observations || observations.length === 0) {
    if (!params.seriesId) return { ok: false, error: "provide either seriesId or observations" };
    const backbone = readBackboneObservations(params.seriesId);
    if (!backbone) {
      return { ok: false, error: `seriesId '${params.seriesId}' not found in the persisted backbone (run scripts/load-index-csvs.mjs)` };
    }
    observations = backbone.observations;
    provenance = { seriesId: params.seriesId, artifactId: backbone.artifactId, range: backbone.range, nObs: observations.length };
  } else {
    provenance = { nObs: observations.length };
  }

  const payload = JSON.stringify({
    observations,
    order: params.order,
    seasonal_order: params.seasonal_order,
    transformation: params.transformation ?? "none",
    trend: params.trend ?? "n",
    horizon: params.horizon ?? 1,
    piLevels: params.piLevels ?? [0.8, 0.95],
  });

  const py = process.env["PYTHON_BIN"] ?? "py";
  return new Promise((resolve) => {
    const child = spawn(py, [SCRIPT], { stdio: ["pipe", "pipe", "pipe"], timeout: 120_000 });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => { out += d.toString(); if (out.length > 4_000_000) child.kill(); });
    child.stderr.on("data", (d) => { err += d.toString(); });
    child.on("error", (e) => resolve({ ok: false, error: `python spawn failed: ${e.message}` }));
    child.on("close", (code) => {
      let parsed: any = null;
      try { parsed = JSON.parse(out); } catch { /* fall through */ }
      if (parsed?.error) return resolve({ ok: false, error: String(parsed.error), provenance });
      if (code !== 0 || !parsed) {
        return resolve({ ok: false, error: `sarima_fit exited ${code}: ${err.slice(0, 400) || out.slice(0, 400)}`, provenance });
      }
      resolve({ ok: true, result: parsed, provenance });
    });
    child.stdin.end(payload);
  });
}
