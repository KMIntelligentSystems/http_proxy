/**
 * productivity@1.0.0 — Manufacturing Productivity Proxy (seasonal random walk).
 *
 * glm-5-2-plan semantics (c): pure re-derivation, no model state.
 *   real_output_t   = m3_shipments_nsa_t / (ipman_t / 100)
 *   aggregate_hours_t = ces_employment_t * ces_hours_t
 *   productivity_t  = real_output_t / aggregate_hours_t
 *   forecast: prod(M) = prod(M-12)   (seasonal random walk anchor)
 *   PI: rolling-origin residuals over the last `piWindowMonths`, empirical quantiles.
 *
 * Reads { dataset, prior } on stdin (the broker assembles these from the
 * verified broadcast + the target's own indicator_history). Writes a canonical
 * SkillResult JSON to stdout. Deterministic — no RNG, no network, no fs.
 *
 * This is a REAL frozen skill (replaces the placeholder) implementing the
 * productivity composition from the interactive run behind sub-mfg-productivity.
 */
let input = "";
process.stdin.on("data", (d) => { input += d.toString(); });
process.stdin.on("end", () => {
  const { dataset, prior } = JSON.parse(input || "{}");
  const hist = prior?.history ?? {};

  // Resolve the four raw series from accumulated history (target's indicator_history).
  const shipments = seriesMonthly(hist["m3_total_shipments_nsa"]);
  const ipman = seriesMonthly(hist["fred_ipman"]);
  const employment = seriesMonthly(hist["bls_ces_mfg_employment"]);
  const hours = seriesMonthly(hist["bls_ces_mfg_hours"]);

  // Inner-join on date across all four (the binding constraint is CES hours from Mar 2006).
  const dates = Object.keys(shipments)
    .filter((d) => ipman[d] != null && employment[d] != null && hours[d] != null)
    .sort();

  // Compute the productivity proxy series.
  const prod = dates.map((d) => {
    const realOutput = shipments[d] / (ipman[d] / 100);
    const aggregateHours = employment[d] * hours[d];
    return { date: d, productivity: realOutput / aggregateHours };
  });

  // The new month from the broadcast (if present) extends the series.
  const newMonth = dataset?.referenceMonth;
  let point = null;
  if (newMonth) {
    const newInd = (dataset?.indicators ?? []).reduce((m, i) => { m[i.seriesId] = i; return m; }, {});
    const s = lastObs(newInd["m3_total_shipments_nsa"]);
    const ip = lastObs(newInd["fred_ipman"]);
    const e = lastObs(newInd["bls_ces_mfg_employment"]);
    const h = lastObs(newInd["bls_ces_mfg_hours"]);
    if (s != null && ip != null && e != null && h != null) {
      const realOutput = s / (ip / 100);
      const aggregateHours = e * h;
      point = realOutput / aggregateHours;
      prod.push({ date: newMonth, productivity: point });
    }
  }

  // Seasonal random walk: forecast = value 12 months prior. If the broadcast
  // brought the new observed point, the "forecast" is that observed value
  // (we are re-deriving the proxy, not predicting it); otherwise anchor to M-12.
  const anchor = point ?? seasonalAnchor(prod, newMonth, 12);
  if (anchor == null || !isFinite(anchor)) {
    process.stdout.write(JSON.stringify(errorResult("insufficient history for seasonal anchor")));
    return;
  }

  // Rolling-origin residual PI: for each t >= piWindow, the one-step seasonal-RW
  // error is prod[t] - prod[t-12]. Empirical quantiles of those errors.
  const piWindow = 36;
  const residuals = [];
  for (let i = piWindow; i < prod.length; i++) {
    const prev = prod[i - 12];
    if (prev) residuals.push(prod[i].productivity - prev.productivity);
  }
  const pi80 = [anchor + quantile(residuals, 0.10), anchor + quantile(residuals, 0.90)];
  const pi95 = [anchor + quantile(residuals, 0.025), anchor + quantile(residuals, 0.975)];

  const out = {
    point: anchor,
    pi80,
    pi95,
    drift: { features: [], widened: false },
    delta: { newMonth: point != null ? 1 : 0, revision: 0 },
    _chartSeries: { label: "Mfg productivity proxy (real output / aggregate hours)", values: prod.slice(-120).map((p) => ({ date: p.date, value: p.productivity })) },
    _nObs: prod.length,
    _nResiduals: residuals.length,
  };
  process.stdout.write(JSON.stringify(out));
});

// ---- helpers (pure) --------------------------------------------------------
function seriesMonthly(rows) {
  const m = {};
  for (const r of rows ?? []) {
    // normalise "YYYY-MM-DD" or "YYYY-MM" to "YYYY-MM"
    const d = String(r.date).slice(0, 7);
    m[d] = Number(r.value);
  }
  return m;
}
function lastObs(ind) {
  if (!ind?.observations?.length) return null;
  const obs = ind.observations[ind.observations.length - 1];
  return Number(obs.value);
}
function seasonalAnchor(prod, month, lag) {
  if (!month) return prod.length ? prod[prod.length - 1].productivity : null;
  const [y, m] = month.split("-").map(Number);
  const prev = new Date(y - Math.floor((m - lag) <= 0 ? 1 : 0), m - 1 - lag); // approx; use explicit:
  // explicit 12-month-prior
  const py = m - lag <= 0 ? y - 1 : y;
  const pm = ((m - lag - 1) + 12) % 12 + 1;
  const key = `${py}-${String(pm).padStart(2, "0")}`;
  const found = prod.find((p) => p.date === key);
  return found ? found.productivity : null;
}
function quantile(arr, q) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  if (lo === hi) return s[lo];
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}
function errorResult(msg) {
  return { point: 0, pi80: [0, 0], pi95: [0, 0], drift: { features: [], widened: false }, delta: { newMonth: 0, revision: 0 }, error: msg };
}
