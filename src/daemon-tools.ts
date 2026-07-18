/**
 * Daemon integration tool — wakes the daemon and pulls the resulting dataset.
 *
 * Registered in web-main.ts as `pull_indicator_dataset`.  The orchestrator
 * agent can call this when it needs fresh leading-indicator data for a
 * nowcast / forecast boost.
 *
 * Flow:
 *   1. Build + HMAC-sign a RunRequest
 *   2. POST to daemon /run
 *   3. Extract datasetId from JobOutcome
 *   4. HMAC-sign + GET /datasets/:id
 *   5. Return the full IndicatorDataset as structured JSON
 */

import crypto from "node:crypto";

const DAEMON_URL = process.env["DAEMON_URL"] ?? "http://127.0.0.1:8791";
const HMAC_KEY = process.env["DAEMON_HMAC_KEY"] ?? "dev-insecure-hmac-key-change-me";
// The target refresh-daemon that owns indicator_history. The React side mirrors
// pulled indicators here so the target can extend its YTD series without sharing
// the React filesystem. If unset or unreachable, the mirror is skipped (the
// interactive run is never broken by a missing target).
const REFRESH_DAEMON_URL = process.env["REFRESH_DAEMON_URL"] ?? "http://127.0.0.1:8792";

/** HMAC-SHA256 hex of the payload. */
function hmacSign(payload: string): string {
  return crypto.createHmac("sha256", HMAC_KEY).update(payload).digest("hex");
}

/** Build a signed RunRequest body. */
function buildRunRequest(opts: {
  source: string;
  month: string;
  targets?: string[];
  series?: string[];
  model?: string;
}): object {
  const body = {
    schemaVersion: 1,
    requestId: `rr-${crypto.randomUUID()}`,
    source: opts.source,
    referenceMonth: opts.month,
    targets: opts.targets ?? ["m3_new_orders"],
    ...(opts.series ? { series: opts.series } : {}),
    ...(opts.model ? { model: opts.model } : {}),
    issuedAt: new Date().toISOString(),
  };
  const signable = JSON.stringify(body);
  return {
    ...body,
    signature: { alg: "HMAC-SHA256", value: hmacSign(signable) },
  };
}

export interface PullResult {
  ok: boolean;
  datasetId?: string;
  contentHash?: string;
  referenceMonth?: string;
  target?: string;
  source?: string;
  seriesIncluded?: string[];
  indicators?: unknown[];
  error?: string;
}

/**
 * Wake the daemon for a source + month and pull the resulting dataset.
 */
export async function pullIndicatorDataset(opts: {
  source: string;
  month: string;
  series?: string[];
  model?: string;
}): Promise<PullResult> {
  // 1. POST RunRequest
  const runReq = buildRunRequest({
    source: opts.source,
    month: opts.month,
    series: opts.series,
    model: opts.model,
  });

  let runResp: Response;
  try {
    runResp = await fetch(`${DAEMON_URL}/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(runReq),
    });
  } catch (err) {
    return { ok: false, error: `daemon /run unreachable: ${err}` };
  }

  if (!runResp.ok) {
    const text = await runResp.text().catch(() => "(no body)");
    return { ok: false, error: `daemon /run returned ${runResp.status}: ${text.slice(0, 300)}` };
  }

  const outcome: any = await runResp.json();
  if (!outcome?.ok || !outcome?.outcome?.datasetId) {
    return {
      ok: false,
      error: outcome?.outcome?.note ?? "daemon returned no datasetId",
    };
  }

  const datasetId: string = outcome.outcome.datasetId;

  // 2. Pull dataset
  const sig = hmacSign(datasetId);
  let pullResp: Response;
  try {
    pullResp = await fetch(`${DAEMON_URL}/datasets/${datasetId}`, {
      headers: { "X-Daemon-Sig": sig },
    });
  } catch (err) {
    return { ok: false, error: `daemon pull unreachable: ${err}` };
  }

  if (!pullResp.ok) {
    return { ok: false, error: `daemon pull returned ${pullResp.status}` };
  }

  const dataset: any = await pullResp.json();

  const result: PullResult = {
    ok: true,
    datasetId,
    contentHash: outcome.outcome.contentHash,
    referenceMonth: dataset.referenceMonth,
    target: dataset.target,
    source: dataset.source,
    seriesIncluded: outcome.outcome.seriesIncluded,
    indicators: dataset.indicators,
  };

  // Mirror the pulled indicators to the target refresh-daemon's indicator_history
  // table. This is the transparent capture: whatever the interactive statistician
  // just used gets recorded so the target can extend its YTD series going forward.
  // Best-effort — never breaks the interactive run if the target is unreachable.
  mirrorIndicatorsToHistory(result).catch(() => {});

  return result;
}

/**
 * POST the pulled indicators to the target refresh-daemon's /refresh/bootstrap
 * endpoint (HMAC-authed, same key). The target upserts into indicator_history.
 * Silent on failure — the interactive pull's success is not coupled to the
 * target's availability.
 */
async function mirrorIndicatorsToHistory(result: PullResult): Promise<void> {
  if (!result.ok || !result.indicators?.length) return;
  const body = JSON.stringify({
    series: result.indicators.map((ind: any) => ({
      seriesId: ind.seriesId,
      observations: (ind.observations ?? []).map((o: any) => ({
        date: o.date,
        value: o.value,
        isPreliminary: o.isPreliminary ?? false,
      })),
    })),
  });
  const sig = hmacSign(body);
  try {
    const resp = await fetch(`${REFRESH_DAEMON_URL}/refresh/bootstrap`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Daemon-Sig": sig },
      body,
    });
    if (resp.ok) {
      const j: any = await resp.json();
      console.log(`[daemon-tools] mirrored ${j.seeded ?? 0} indicator obs to target history`);
    } else {
      console.warn(`[daemon-tools] target history mirror returned ${resp.status}`);
    }
  } catch (err) {
    // Target not running — fine in dev. The data is still in the source daemon's
    // sandbox DB and will arrive via the next broadcast if the target comes up.
    console.warn(`[daemon-tools] target history mirror skipped: ${err instanceof Error ? err.message : String(err)}`);
  }
}