import { useState, useEffect, useRef, useCallback } from "react";
import { fetchModels, switchModel, onModelChange, getCurrentModel, type ModelInfo } from "../lib/agent-bridge";

export function ModelSelector() {
  const [current, setCurrent] = useState<ModelInfo | null>(getCurrentModel);
  const [available, setAvailable] = useState<ModelInfo[]>([]);
  const [filter, setFilter] = useState("");
  const [open, setOpen] = useState(false);
  const [switching, setSwitching] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Load models once on mount
  useEffect(() => {
    fetchModels()
      .then((data) => {
        setCurrent(data.current);
        setAvailable(data.available);
      })
      .catch(() => {});
  }, []);

  // Stay in sync with WS agent_state broadcasts
  useEffect(() => onModelChange(setCurrent), []);

  // Close on outside click
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
        setFilter("");
      }
    };
    if (open) document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  // Focus input when opened
  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  const filtered = filter.trim()
    ? available.filter(
        (m) =>
          m.id.toLowerCase().includes(filter.toLowerCase()) ||
          m.name.toLowerCase().includes(filter.toLowerCase()) ||
          m.provider.toLowerCase().includes(filter.toLowerCase())
      )
    : available;

  const handleSelect = useCallback(async (m: ModelInfo) => {
    const key = `${m.provider}:${m.id}`;
    if (current && current.provider === m.provider && current.id === m.id) {
      setOpen(false);
      setFilter("");
      return;
    }
    setSwitching(true);
    try {
      await switchModel(key);
    } catch {
      // WS will update the label automatically
    }
    setSwitching(false);
    setOpen(false);
    setFilter("");
  }, [current]);

  const displayLabel = current
    ? `${current.name}`
    : "No model";

  return (
    <div className="model-selector" ref={containerRef}>
      <button
        className="model-label-btn"
        onClick={() => setOpen((o) => !o)}
        disabled={switching}
        title={current ? `${current.provider}:${current.id}` : "Select model"}
      >
        {switching ? (
          <span className="model-switching">Switching…</span>
        ) : (
          <>
            <span className="model-label-text">{displayLabel}</span>
            <span className="model-caret">{open ? "▴" : "▾"}</span>
          </>
        )}
      </button>

      {open && (
        <div className="model-dropdown">
          <input
            ref={inputRef}
            className="model-search"
            type="text"
            placeholder="Filter models…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") { setOpen(false); setFilter(""); }
              if (e.key === "Enter" && filtered.length === 1) handleSelect(filtered[0]);
            }}
          />
          <ul className="model-list">
            {filtered.map((m) => {
              const isActive = current && current.provider === m.provider && current.id === m.id;
              return (
                <li
                  key={`${m.provider}:${m.id}`}
                  className={`model-item${isActive ? " model-item-active" : ""}`}
                  onClick={() => handleSelect(m)}
                >
                  <span className="model-item-name">{m.name}</span>
                  <span className="model-item-id">{m.provider}:{m.id}</span>
                </li>
              );
            })}
            {filtered.length === 0 && (
              <li className="model-item model-item-empty">No models match</li>
            )}
          </ul>
        </div>
      )}
    </div>
  );
}
