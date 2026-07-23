import { useCallback, useEffect, useState } from "react";

interface CatalogSeries {
  id: string; source: string; label: string; unit: string;
  seasonalAdjustment: string; referenceLagMonths: number;
  suggestedSchedule: { kind: string; dayOfMonth: number; time: string; note: string };
}
interface Catalog {
  sources: { id: string; label: string }[];
  series: CatalogSeries[];
  runnerExists?: boolean;
}
interface TaskRow { name: string; nextRun: string; status: string; }
interface LogRow { file: string; ok: boolean; startedAt: string; source: string; referenceMonth: string; series: string[]; error?: string; }

interface SchedulerPanelProps { open: boolean; onToggle: () => void; onClose: () => void; }

const API = "/ui/api/scheduler";

/**
 * Dev-only scheduler console: configure indicator-fetch schedules from the
 * catalog of the source daemon's 14 series. "Run now" executes the runner
 * inline; "Schedule" registers a Windows Scheduled Task (DVA-*). The browser
 * configures — the OS executes. Hidden/disabled in production (host 403s).
 */
export function SchedulerPanel({ open, onToggle, onClose }: SchedulerPanelProps) {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [tasks, setTasks] = useState<TaskRow[]>([]);
  const [logs, setLogs] = useState<LogRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [lastRun, setLastRun] = useState<string | null>(null);

  // form state
  const [source, setSource] = useState("fred");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [month, setMonth] = useState("latest");
  const [kind, setKind] = useState<"once" | "daily" | "weekly" | "monthly">("monthly");
  const [time, setTime] = useState("07:00");
  const [dayOfMonth, setDayOfMonth] = useState(18);
  const [dayOfWeek, setDayOfWeek] = useState("MON");
  const [onceDate, setOnceDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [withRefresh, setWithRefresh] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const [cat, t, l] = await Promise.all([
        fetch(`${API}/catalog`).then((r) => r.json()),
        fetch(`${API}/tasks`).then((r) => r.json()),
        fetch(`${API}/logs`).then((r) => r.json()),
      ]);
      if (cat.error) setError(cat.error);
      else { setCatalog(cat); setError(null); }
      setTasks(t.tasks ?? []);
      setLogs(l.logs ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => { if (open) refresh(); }, [open, refresh]);

  // When the source changes, select all of its series and adopt the first
  // series' suggested schedule as the form default.
  useEffect(() => {
    if (!catalog) return;
    const ss = catalog.series.filter((s) => s.source === source);
    setSelected(new Set(ss.map((s) => s.id)));
    const sug = ss[0]?.suggestedSchedule;
    if (sug) {
      setKind((sug.kind as typeof kind) ?? "monthly");
      setTime(sug.time ?? "07:00");
      setDayOfMonth(sug.dayOfMonth ?? 18);
    }
  }, [source, catalog]);

  const toggleSeries = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const body = () => ({
    source,
    series: [...selected],
    month: month === "latest" ? "latest" : month,
    withRefresh,
  });

  const runNow = async () => {
    setBusy(true); setError(null); setLastRun(null);
    try {
      const r = await fetch(`${API}/run`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body()) });
      const j = await r.json();
      if (!r.ok || !j.ok) setError(j.error ?? j.stderr ?? `run failed (${r.status})`);
      setLastRun(j.stdout ?? null);
      await refresh();
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); }
  };

  const schedule = async () => {
    setBusy(true); setError(null);
    try {
      const recurrence: any = { kind, time };
      if (kind === "monthly") recurrence.dayOfMonth = dayOfMonth;
      if (kind === "weekly") recurrence.dayOfWeek = dayOfWeek;
      if (kind === "once") recurrence.date = onceDate;
      const r = await fetch(`${API}/tasks`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...body(), recurrence }) });
      const j = await r.json();
      if (!r.ok) setError(j.error ?? `schedule failed (${r.status})`);
      await refresh();
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); }
  };

  const deleteTask = async (name: string) => {
    setBusy(true); setError(null);
    try {
      const r = await fetch(`${API}/tasks/${encodeURIComponent(name)}`, { method: "DELETE" });
      const j = await r.json();
      if (!r.ok) setError(j.error ?? `delete failed (${r.status})`);
      await refresh();
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); }
  };

  const openTaskScheduler = async () => {
    await fetch(`${API}/open`, { method: "POST" }).catch(() => {});
  };

  const sourceSeries = catalog?.series.filter((s) => s.source === source) ?? [];

  return (
    <>
      <button
        type="button"
        className="sched-toggle"
        onClick={onToggle}
        title={open ? "Close scheduler" : "Scheduler (dev) — indicator fetch schedules"}
      >
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
          <line x1="16" y1="2" x2="16" y2="6" /><line x1="8" y1="2" x2="8" y2="6" /><line x1="3" y1="10" x2="21" y2="10" />
        </svg>
      </button>
      {open && (
        <div className="sched-panel" role="dialog" aria-label="Scheduler">
          <div className="sched-header">
            <h3>Scheduler <span className="sched-dev-badge">dev</span></h3>
            <button className="sched-close" onClick={onClose} aria-label="Close">×</button>
          </div>

          {error && <div className="sched-error" role="alert">{error}</div>}
          {catalog && !catalog.runnerExists && <div className="sched-error" role="alert">runner script missing: scripts/scheduled-indicator-run.mjs</div>}

          <section className="sched-section">
            <h4>Fetch indicators</h4>
            <div className="sched-row">
              <label>Source</label>
              <select value={source} onChange={(e) => setSource(e.target.value)}>
                {catalog?.sources.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
              </select>
            </div>
            <div className="sched-series-list">
              {sourceSeries.map((s) => (
                <label key={s.id} className="sched-series-item" title={`${s.unit}; ${s.seasonalAdjustment}; lag ${s.referenceLagMonths} mo. Suggested: monthly day ${s.suggestedSchedule.dayOfMonth} ${s.suggestedSchedule.time} (${s.suggestedSchedule.note})`}>
                  <input type="checkbox" checked={selected.has(s.id)} onChange={() => toggleSeries(s.id)} />
                  <span>{s.label}</span>
                </label>
              ))}
            </div>
            <div className="sched-row">
              <label>Month</label>
              <select value={month === "latest" ? "latest" : "explicit"} onChange={(e) => setMonth(e.target.value === "latest" ? "latest" : new Date().toISOString().slice(0, 7))}>
                <option value="latest">latest (release-lag aware)</option>
                <option value="explicit">specific…</option>
              </select>
              {month !== "latest" && <input type="month" value={month} onChange={(e) => setMonth(e.target.value)} />}
            </div>
            <div className="sched-row">
              <label>Recurrence</label>
              <select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
                <option value="once">once</option><option value="daily">daily</option>
                <option value="weekly">weekly</option><option value="monthly">monthly</option>
              </select>
              <input type="time" value={time} onChange={(e) => setTime(e.target.value)} />
              {kind === "monthly" && (
                <>day <input type="number" min={1} max={31} value={dayOfMonth} onChange={(e) => setDayOfMonth(Number(e.target.value))} className="sched-num" /></>
              )}
              {kind === "weekly" && (
                <select value={dayOfWeek} onChange={(e) => setDayOfWeek(e.target.value)}>
                  {["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"].map((d) => <option key={d}>{d}</option>)}
                </select>
              )}
              {kind === "once" && <input type="date" value={onceDate} onChange={(e) => setOnceDate(e.target.value)} />}
            </div>
            <label className="sched-row sched-check">
              <input type="checkbox" checked={withRefresh} onChange={(e) => setWithRefresh(e.target.checked)} />
              also trigger refresh (frozen skills) after fetch
            </label>
            <div className="sched-actions">
              <button onClick={runNow} disabled={busy || selected.size === 0}>Run now</button>
              <button onClick={schedule} disabled={busy || selected.size === 0}>Schedule task</button>
              <button onClick={openTaskScheduler} title="Open Windows Task Scheduler">Open Task Scheduler</button>
            </div>
            {lastRun && <pre className="sched-lastrun">{lastRun}</pre>}
          </section>

          <section className="sched-section">
            <h4>Scheduled tasks (DVA-*)</h4>
            {tasks.length === 0 ? <p className="sched-dim">No DVA-* tasks registered.</p> : (
              <table className="sched-table">
                <thead><tr><th>Task</th><th>Next run</th><th>Status</th><th /></tr></thead>
                <tbody>
                  {tasks.map((t) => (
                    <tr key={t.name}>
                      <td>{t.name}</td><td>{t.nextRun}</td><td>{t.status}</td>
                      <td><button className="sched-del" onClick={() => deleteTask(t.name)} disabled={busy}>delete</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          <section className="sched-section">
            <h4>Recent runs</h4>
            {logs.length === 0 ? <p className="sched-dim">No runs logged yet.</p> : (
              <ul className="sched-logs">
                {logs.map((l) => (
                  <li key={l.file} className={l.ok ? "sched-log-ok" : "sched-log-err"}>
                    <b>{l.ok ? "✓" : "✗"}</b> {l.startedAt?.slice(0, 16).replace("T", " ")} — {l.source} {l.referenceMonth} ({l.series?.length ?? 0} series){l.error ? ` — ${l.error}` : ""}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      )}
    </>
  );
}
