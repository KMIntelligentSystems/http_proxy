import { useState, useEffect, useCallback } from "react";

export type LookupSlot = {
  id: string;
  label: string;
  source: string;
  keyField: string;
  displayField: string;
};

export type SurveyDef = {
  id: string;
  label: string;
  description: string;
  lookupSlots?: LookupSlot[];
};

export type StatToggle = {
  id: string;
  label: string;
  description: string;
};

export type TimeSeriesMetric = {
  key: string;
  datatype: string;
  label: string;
};

export type LookupConfig = {
  version: number;
  surveys: SurveyDef[];
  commonSlots?: LookupSlot[];
  statistics: StatToggle[];
  timeSeriesMetrics: TimeSeriesMetric[];
};

export type LookupItem = { key: string; display: string };
export type LookupData = Record<string, LookupItem[]>;

export function useLookupConfig() {
  const [config, setConfig] = useState<LookupConfig | null>(null);
  const [lookupData, setLookupData] = useState<LookupData>({});
  const [selections, setSelections] = useState<Record<string, string>>({});
  const [statToggles, setStatToggles] = useState<Record<string, boolean>>({});
  const [tsMetrics, setTsMetrics] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);

  // Fetch the config on mount
  useEffect(() => {
    fetch("/ui/lookups-config.json")
      .then((r) => r.json())
      .then((cfg: LookupConfig) => {
        setConfig(cfg);
        // Pre-load common slots (NAICS)
        const common = cfg.commonSlots ?? [];
        common.forEach((slot) => loadLookupSlot(slot));
        setLoading(false);
      })
      .catch((err) => {
        console.error("Failed to load lookup config", err);
        setLoading(false);
      });
  }, []);

  const loadLookupSlot = useCallback((slot: LookupSlot) => {
    fetch(`/ui/${slot.source}`)
      .then((r) => r.json())
      .then((data: Record<string, unknown>[]) => {
        setLookupData((prev) => ({
          ...prev,
          [slot.id]: data.map((d) => ({
            key: String(d[slot.keyField] ?? ""),
            display: String(d[slot.displayField] ?? ""),
          })),
        }));
      })
      .catch((err) => console.error(`Failed to load ${slot.source}`, err));
  }, []);

  // When survey changes, load its slots and clear downstream selections
  const setSurvey = useCallback(
    (surveyId: string) => {
      // Update survey selection
      setSelections((prev) => {
        const next = { ...prev, survey: surveyId };
        // Clear all selections that came from the previous survey's slots
        const allSlotIds = Object.keys(next).filter((k) => k !== "survey" && k !== "naics");
        allSlotIds.forEach((k) => delete next[k]);
        return next;
      });

      if (!config) return;

      // Clear old survey lookup data
      setLookupData((prev) => {
        const next = { ...prev };
        const allSlotIds = Object.keys(next).filter((k) => k !== "naics");
        allSlotIds.forEach((k) => delete next[k]);
        return next;
      });

      // Load slots for the selected survey
      const survey = config.surveys.find((s) => s.id === surveyId);
      if (survey?.lookupSlots) {
        survey.lookupSlots.forEach((slot) => loadLookupSlot(slot));
      }
    },
    [config, loadLookupSlot]
  );

  const setSelection = useCallback((slotId: string, value: string) => {
    setSelections((prev) => ({ ...prev, [slotId]: value }));
  }, []);

  const toggleStat = useCallback((statId: string) => {
    setStatToggles((prev) => ({ ...prev, [statId]: !prev[statId] }));
  }, []);

  const toggleMetric = useCallback((metricKey: string) => {
    setTsMetrics((prev) =>
      prev.includes(metricKey) ? prev.filter((k) => k !== metricKey) : [...prev, metricKey]
    );
  }, []);

  // Get the current survey's slots
  const activeSlots = config
    ? (config.surveys.find((s) => s.id === selections.survey)?.lookupSlots ?? [])
    : [];

  // Build the context string to inject into the agent prompt
  const buildLookupContext = (): string => {
    const parts: string[] = [];
    for (const [slotId, value] of Object.entries(selections)) {
      if (value) parts.push(`${slotId}: ${value}`);
    }
    const stats = Object.entries(statToggles)
      .filter(([, v]) => v)
      .map(([k]) => k);
    if (stats.length) parts.push(`statistics: ${stats.join(", ")}`);
    const metrics = tsMetrics;
    if (metrics.length) parts.push(`metrics: ${metrics.join(", ")}`);
    return parts.join("; ");
  };

  return {
    config,
    lookupData,
    selections,
    statToggles,
    tsMetrics,
    loading,
    activeSlots,
    setSurvey,
    setSelection,
    toggleStat,
    toggleMetric,
    buildLookupContext,
  };
}
