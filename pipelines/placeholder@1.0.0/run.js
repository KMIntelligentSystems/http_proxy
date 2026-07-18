/**
 * Placeholder pinned skill for run_nowcast_skill (P1).
 *
 * Reads { dataset, prior } on stdin, writes a canonical SkillResult JSON to
 * stdout. This is a stand-in so the refresh pipeline is end-to-end
 * demonstrable before P2 packages the real frozen STL / LASSO / SARIMA /
 * seasonal-RW skills. The broker runs this in a subprocess with a stripped env
 * (no API keys, no DB paths) and a wall-clock cap — the lockdown disciplines
 * the source daemon's airlock already proves, ported to the receiving side.
 *
 * P2 will replace this with pipelines/<id>@<version>/run.js keyed by
 * contractId and digest-checked before spawn.
 */
let input = "";
process.stdin.on("data", (d) => { input += d.toString(); });
process.stdin.on("end", () => {
  const { dataset } = JSON.parse(input || "{}");
  // A trivial, deterministic "forecast": the last observed value of the first
  // indicator series, with a fixed-width PI. Drift is empty (no training
  // support bound to check against in the placeholder).
  const first = dataset?.indicators?.[0];
  const obs = first?.observations ?? [];
  const last = obs.length ? obs[obs.length - 1].value : 0;
  const point = typeof last === "number" ? last : 0;
  const w = Math.max(Math.abs(point) * 0.02, 1);
  const out = {
    point,
    pi80: [point - w, point + w],
    pi95: [point - 2 * w, point + 2 * w],
    drift: { features: [], widened: false },
    delta: { newMonth: 0, revision: 0 },
  };
  process.stdout.write(JSON.stringify(out));
});
