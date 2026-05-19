import type { LookupConfig, LookupData, LookupSlot } from "../hooks/useLookupConfig";

type Props = {
  config: LookupConfig | null;
  lookupData: LookupData;
  selections: Record<string, string>;
  statToggles: Record<string, boolean>;
  tsMetrics: string[];
  activeSlots: LookupSlot[];
  loading: boolean;
  onSurveyChange: (surveyId: string) => void;
  onSelect: (slotId: string, value: string) => void;
  onToggleStat: (statId: string) => void;
  onToggleMetric: (key: string) => void;
};

export function LookupPanel({
  config,
  lookupData,
  selections,
  statToggles,
  tsMetrics,
  activeSlots,
  loading,
  onSurveyChange,
  onSelect,
  onToggleStat,
  onToggleMetric,
}: Props) {
  if (loading) return <div className="lookup-loading">Loading lookups…</div>;
  if (!config) return <div className="lookup-loading">Lookup config unavailable</div>;

  const commonSlots = config.commonSlots ?? [];

  return (
    <>
      {/* Survey selector */}
      <div className="lookup-group">
        <label htmlFor="sel-survey">Survey</label>
        <select
          id="sel-survey"
          value={selections.survey ?? ""}
          onChange={(e) => onSurveyChange(e.target.value)}
        >
          <option value="">Select…</option>
          {config.surveys.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </select>
      </div>

      {/* Common slots (NAICS) — always visible */}
      {commonSlots.map((slot) => (
        <div className="lookup-group" key={slot.id}>
          <label htmlFor={`sel-${slot.id}`}>{slot.label}</label>
          <select
            id={`sel-${slot.id}`}
            value={selections[slot.id] ?? ""}
            onChange={(e) => onSelect(slot.id, e.target.value)}
          >
            <option value="">All</option>
            {(lookupData[slot.id] ?? []).map((item) => (
              <option key={item.key} value={item.key}>
                {item.key} — {item.display}
              </option>
            ))}
          </select>
        </div>
      ))}

      {/* Survey-specific slots */}
      {activeSlots.map((slot) => (
        <div className="lookup-group" key={slot.id}>
          <label htmlFor={`sel-${slot.id}`}>{slot.label}</label>
          <select
            id={`sel-${slot.id}`}
            value={selections[slot.id] ?? ""}
            onChange={(e) => onSelect(slot.id, e.target.value)}
          >
            <option value="">All</option>
            {(lookupData[slot.id] ?? []).map((item) => (
              <option key={item.key} value={item.key}>
                {item.key} — {item.display}
              </option>
            ))}
          </select>
        </div>
      ))}

      {/* Time series metrics (pill toggles — oe-drilldown pattern) */}
      {config.timeSeriesMetrics?.length > 0 && (
        <div className="lookup-group">
          <label>Time Series Metrics</label>
          <div className="metric-pills">
            {config.timeSeriesMetrics.map((m) => (
              <button
                key={m.key}
                className={`pill ${tsMetrics.includes(m.key) ? "active" : ""}`}
                onClick={() => onToggleMetric(m.key)}
                type="button"
              >
                {m.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Statistical techniques */}
      {config.statistics.length > 0 && (
        <div className="lookup-group">
          <label>Statistics</label>
          {config.statistics.map((stat) => (
            <label key={stat.id} className="stat-toggle" title={stat.description}>
              <input
                type="checkbox"
                checked={statToggles[stat.id] ?? false}
                onChange={() => onToggleStat(stat.id)}
              />
              {stat.label}
            </label>
          ))}
        </div>
      )}
    </>
  );
}
