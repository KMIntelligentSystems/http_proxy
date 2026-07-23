---
name: pipeline-freeze
description: "Freeze an interactively-validated statistical model into a refresh contract: write the self-contained pinned skill, recompute the contract's pipelineDigest, and verify hermetically. Use ONLY on explicit user instruction ('freeze this into the <contract> contract') — never autonomously. Covers semantics (a) frozen-rescore weights, (b) refit-pinned skills, and (c) re-derive skills."
---

# Pipeline Freeze Skill

Freezing is the **explicit, human-instructed** act that converts a flow-1
(interactive) modeling result into a flow-2 (unattended refresh) contract.
The interactive session is where judgment lives; the freeze is its
transcription. The frozen artifact must need **no judgment at run time** —
the oracle that later executes it can only proceed or abstain.

## Trigger and gate

- Trigger: the user says "freeze" (or approves a freeze proposal) for a
  spec that was validated interactively in this or a prior session.
- NEVER freeze autonomously, speculatively, or as a side effect of another
  task. If a model looks ready but the user hasn't said freeze, *propose*
  and stop.

## Prerequisites

1. **A validated spec.** The model was run interactively (`run_sarima`, or
   the statistician via `execute_python`) and its output was reviewed by
   the user — ideally reproduced against a reference (a prior model card,
   a published forecast) within a stated tolerance. Record the deltas.
2. **A current backbone.** The series the skill will consume are persisted
   (`npm run data:load-index-csvs`) and synced (`sync_indicator_history`),
   so the hermetic verification in step 5 runs on real data.
3. **A target contract.** `data/contracts/<name>.contract.json` exists
   (semantics, requiredSeries, envLock pinned). If not, propose its fields
   to the user before creating it.

## Procedure

1. **Validate.** Re-run the interactive fit on the current backbone.
   Compare against the reference (model card / prior). State the deltas
   explicitly (e.g. "point −0.02%, PI bounds ~0.07% vs card mqnf8wxi").
   If diagnostics reveal a quality issue (e.g. residual autocorrelation),
   surface it — the user decides whether to freeze anyway.
2. **Write the skill** `pipelines/<name>@<version>/run.py` (or `run.js`):
   - **SELF-CONTAINED — the broker's `pipelineDigest` hashes ONLY the
     entrypoint file.** Inline everything; no project imports. (Any shared
     code would escape the digest. The alternative — upgrading the broker
     to hash the whole pipeline dir — is a separate, user-approved change.)
   - Protocol: read `{ dataset, prior }` on stdin (broker-assembled:
     verified broadcast + the target's own `indicator_history`); write ONE
     canonical SkillResult JSON to stdout: `point`, `pi80`, `pi95`,
     `drift`, `delta`, optional `_`-prefixed diagnostics. No network, no
     filesystem, no RNG.
   - Conventions must match the interactive tool EXACTLY (same
     transformation, trend mapping, burn-in exclusion, quantile method) so
     flow-1 and flow-2 outputs are directly comparable. `sarima_fit.py`'s
     header documents the SARIMA conventions.
   - Semantics quick reference:
     - **(a) frozen-rescore** — frozen weights (e.g. `weights.json`) +
       re-derived features; NO refit. Weights file is produced by an
       interactive fit-and-extract session and reviewed by the user.
     - **(b) refit-pinned** — refit with pinned params + env on each
       append (SARIMA/STL pattern); output = f(data, params, env).
     - **(c) re-derive** — pure function of inputs, no model state
       (productivity seasonal-RW pattern).
3. **Verify byte-stability.** Same stdin twice → byte-identical stdout.
   (The canonical result hash covers stdout; any nondeterminism breaks
   reproducibility and the signature chain.)
4. **Freeze the digest.** `sha256` the entrypoint → update the contract's
   `pipelineDigest`; update the pipeline `manifest.json` `status` field
   (from "scaffold" to "implemented <date>" + the validation evidence).
   Show the user the diff — this is the human checkpoint.
5. **Hermetic e2e.** Run the skill through the daemon against throwaway
   state: `REFRESH_DB`/`REFRESH_RESULTS_DIR` in a temp dir, seed via the
   bridge, trigger (mock broadcast or `/refresh/run`), assert the job
   reaches `candidate` with a sane point and a signed hash quadruple.
   Pattern: `scripts/smoke-sarima-skill.mjs` / `scripts/smoke-run-refresh.mjs`.
6. **Update the knowledge surfaces** (AGENTS.md milestone-hygiene rule):
   contract status in AGENTS.md § "Refresh architecture", any new caveats
   in MEMORY.md § "Refresh data plane", and this skill if the procedure
   itself changed.

## Anti-patterns

- **Runtime adaptivity in the skill.** No automdl/auto-outlier-detection,
  no web lookups, no "check for a newer spec". Discoveries belong to the
  NEXT interactive session, then a re-freeze.
- **LLM-set parameters.** The oracle never passes model params; the spec
  is baked into the skill/contract at freeze time.
- **Silent spec drift.** Editing a frozen run.py without updating
  `pipelineDigest` makes the broker reject the skill (fail-closed) — that
  is the system working. Always re-freeze the digest with the edit.
- **Freezing from an unvalidated spec.** "It compiles" is not validation;
  reproduce a reference or run the acceptance comparison first.
