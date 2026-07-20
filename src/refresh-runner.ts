/**
 * run_refresh tool support — the interactive (flow-1) trigger for the
 * unattended (flow-2) pipeline, per the user's model:
 *
 *   user prompt → orchestrator: pull_indicator_dataset (fresh indicators are
 *   mirrored into indicator_history) → run_refresh (frozen skills execute
 *   against the refreshed history) → the signed results + history returned
 *   here are handed to the coder sub-agent, which builds the updated chart as
 *   a normal artifact → the human saves/discards (the native publish gate).
 *
 * This module only talks to the refresh-daemon's HTTP surface — it never
 * touches refresh.db directly. Trigger is HMAC-authed; reads are open.
 */
import crypto from "node:crypto";
import { loadContracts } from "./refresh/broker.js";

const REFRESH_DAEMON_URL = process.env["REFRESH_DAEMON_URL"] ?? "http://127.0.0.1:8792";
const HMAC_KEY = process.env["DAEMON_HMAC_KEY"] ?? "dev-insecure-hmac-key-change-me";

function hmacSign(payload: string): string {
  return crypto.createHmac("sha256", HMAC_KEY).update(payload).digest("hex");
}

const TERMINAL = new Set(["candidate", "abstained", "failed", "rejected"]);

export interface RefreshRunOutcome {
  ok: boolean;
  daemonUrl: string;
  triggered: { contractId: string; enqueued: boolean; datasetId?: string; referenceMonth?: string; reason?: string | null }[];
  jobs: { id: string; contractId: string; state: string }[];
  results: {
    contractId: string;
    subjectId: string;
    referenceMonth: string;
    state: string;
    point?: number;
    pi80?: [number, number];
    pi95?: [number, number];
    analysisMd?: string;
    hashes?: { inputHash: string; contractHash: string; envHash: string; outputHash: string; signature: string };
    history?: Record<string, { date: string; value: number }[]>;
    error?: string;
  }[];
  error?: string;
}

export async function runRefresh(opts: {
  contractId?: string;
  referenceMonth?: string;
  timeoutMs?: number;
}): Promise<RefreshRunOutcome> {
  const timeoutMs = opts.timeoutMs ?? 90_000;
  const out: RefreshRunOutcome = { ok: true, daemonUrl: REFRESH_DAEMON_URL, triggered: [], jobs: [], results: [] };

  // 1. Trigger.
  const body = JSON.stringify({
    ...(opts.contractId ? { contractId: opts.contractId } : {}),
    ...(opts.referenceMonth ? { referenceMonth: opts.referenceMonth } : {}),
  });
  let trigger: any;
  try {
    const resp = await fetch(`${REFRESH_DAEMON_URL}/refresh/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Daemon-Sig": hmacSign(body) },
      body,
    });
    trigger = await resp.json();
    if (!resp.ok || !trigger?.ok) {
      out.ok = false;
      out.error = `daemon /refresh/run ${resp.status}: ${JSON.stringify(trigger).slice(0, 300)}`;
      return out;
    }
  } catch (err) {
    out.ok = false;
    out.error = `refresh daemon unreachable: ${err instanceof Error ? err.message : String(err)}`;
    return out;
  }
  out.triggered = trigger.results ?? [];
  const enqueued = out.triggered.filter((t) => t.datasetId);
  if (enqueued.length === 0) return out; // nothing ready — report only

  // 2. Poll job states to terminal.
  const wanted = new Map(enqueued.map((t) => [`job-${t.contractId}-${t.datasetId}`, t]));
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    await new Promise((r) => setTimeout(r, 2000));
    try {
      const resp = await fetch(`${REFRESH_DAEMON_URL}/refresh/jobs`);
      const { jobs } = (await resp.json()) as any;
      out.jobs = (jobs ?? []).filter((j: any) => wanted.has(j.id)).map((j: any) => ({ id: j.id, contractId: j.contract_id, state: j.state }));
      if (out.jobs.length >= wanted.size && out.jobs.every((j) => TERMINAL.has(j.state))) break;
    } catch { /* transient — keep polling */ }
  }

  // 3. Collect signed results + history for the coder hand-off.
  const contracts = loadContracts();
  for (const t of enqueued) {
    const contract = contracts.find((c) => c.contractId === t.contractId);
    const job = out.jobs.find((j) => j.id === `job-${t.contractId}-${t.datasetId}`);
    const entry: RefreshRunOutcome["results"][number] = {
      contractId: t.contractId,
      subjectId: contract?.subjectId ?? "",
      referenceMonth: t.referenceMonth ?? "",
      state: job?.state ?? "unknown",
    };
    if (entry.state === "candidate" && contract) {
      try {
        const r = await (await fetch(`${REFRESH_DAEMON_URL}/refresh/result?subjectId=${encodeURIComponent(contract.subjectId)}&month=${encodeURIComponent(entry.referenceMonth)}`)).json() as any;
        entry.point = r.point;
        entry.pi80 = r.pi80;
        entry.pi95 = r.pi95;
        entry.analysisMd = r.analysisMd;
        entry.hashes = { inputHash: r.inputHash, contractHash: r.contractHash, envHash: r.envHash, outputHash: r.outputHash, signature: r.signature };
        const qs = contract.requiredSeries.map((s) => `series=${encodeURIComponent(s)}`).join("&");
        const ps = (await (await fetch(`${REFRESH_DAEMON_URL}/refresh/prior-state?subjectId=${encodeURIComponent(contract.subjectId)}&${qs}`)).json()) as any;
        const history: Record<string, { date: string; value: number }[]> = {};
        for (const [sid, rows] of Object.entries(ps.history ?? {})) {
          history[sid] = (rows as any[]).slice(-120).map((o: any) => ({ date: String(o.date).slice(0, 7), value: Number(o.value) }));
        }
        entry.history = history;
      } catch (err) {
        entry.error = `result collection failed: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
    out.results.push(entry);
  }
  out.ok = out.results.every((r) => r.state === "candidate" || r.state === "abstained");
  return out;
}
