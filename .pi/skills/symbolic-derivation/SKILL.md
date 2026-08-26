---
name: symbolic-derivation
description: Author mathematical formulas AS DATA and let an external symbolic engine (Symbolica) derive, verify, evaluate, and render them — back-transforms and their biases, delta-method standard errors and intervals, Jensen/smearing corrections, machine-verified identities, and report-ready LaTeX generated from the same expression objects. Use whenever a run would otherwise hand-code the same formula three times (code + prose + chart labels) or rely on the agent remembering a correction the machine can derive. Engine — Symbolica Python bindings by default; Rust crate reserved for the frozen airlock path; SymPy as fallback where Symbolica's calculus surface is too narrow. Status — Complete (validated 2026-08-14 against data/adl-nowcast-2026-06; test report conversations/symbolic-layer-test-2026-08-14.md; licensed via SYMBOLICA_LICENSE env var 2026-08-15).
---

# Symbolic Derivation — CAS-as-a-tool

The agent (an LLM) is good at choosing *what* to derive and bad at multi-step algebra.
This skill moves the algebra to a deterministic engine: **formulas are authored as data
(expression strings), the engine performs every manipulation, and every claimed identity
is machine-verified** — "no LLM-authored algebra", the same philosophy the refresh
architecture already applies to numbers.

Validated 2026-08-14: engine verified `d(S12·e^g)/dg = S12·e^g` (identity checked via
`.expand() == 0`), derived the Jensen correction `e^(σ²/2)` that the June-2026 ADL run
had missed, auto-generated LaTeX, and reproduced the run's numpy point level
**bit-identically** (693,992.12249652). Script kept at
`data/adl-nowcast-2026-06/symbolic-layer-test.py`.

## 1. When to use / when not

**Use for:**
- **Transforms and back-transforms** (log YoY ↔ level, logit ↔ probability, index ↔
  growth): inverse, derivative, and bias correction derived, not recalled.
- **Delta-method SEs/PIs**: differentiate the prediction function, apply the
  covariance/sandwich, map through monotone transforms.
- **Jensen / smearing corrections** (Duan 1983) after exp/logit back-transforms.
- **Identity verification**: "contributions sum exactly to the point", "YoY growth is
  season-free to first order" — checkable instead of asserted.
- **LaTeX for `analysis.md` and chart labels** generated from the same expression
  objects the code uses → prose/code/label drift killed by construction.
- **Parametric small linear systems** (normal equations with symbolic entries) —
  Symbolica solves these over rational-polynomial fields.

**Do not use for:**
- Anything with **no closed form** — LASSO/elastic-net coordinate descent, walk-forward
  orchestration, empirical quantiles. The numeric core (numpy/sklearn/statsmodels)
  stays; this skill covers the *surrounding* math.
- **Symbolic integration, limits, ODEs, probability machinery** — Symbolica lacks
  these; fall back to SymPy (`pip install sympy`, BSD) for that sub-task only.
- Heavy numerics: evaluate expressions numerically with numpy once derived (or use the
  engine's evaluator for cross-checks, §3 step 4).

## 2. Engine policy

| Surface | When |
|---|---|
| **Symbolica Python bindings** (`pip install symbolica`) | Default. Inside statistician runs, next to numpy/sklearn. |
| **Symbolica Rust crate** | Only when a derivation enters the frozen refresh path (airlock verb or digest-pinned pipeline) — no Python runtime, kernel codegen, exact rational arithmetic. |
| **SymPy** | Fallback for calculus/statsSymbolic gaps (integration, distributions). Never mix engines inside one derivation chain. |

**License**: **LICENSED (hobbyist key) as of 2026-08-15.** The native engine reads
env var `SYMBOLICA_LICENSE` at import; the key is persisted in `HKCU\Environment`
via `setx`, so every process launched from a post-2026-08-15 shell starts licensed
(no banner, all cores, no instance lock). Gotcha: `set_license_key()` in 2.2.0 is
**per-process only** (writes nothing to disk despite its docstring) — do not rely
on it; the env var is the mechanism. Symbolica is source-available; unlicensed =
restricted mode (1 core, banner on stdout). Commercial use requires a paid
license — **resolve before any production/frozen use.**

## 3. ProcedureS

Work in Python via the `py` launcher (MEMORY.md: skills run on `py`, `PYTHON_BIN` env).

1. **Fix the console (and the banner, if ever unlicensed).** Since 2026-08-15 the
   machine is licensed via the `SYMBOLICA_LICENSE` env var, so no banner prints —
   the only preamble still required is the console encoding fix: the pretty-printer
   emits Unicode math italic (𝑒, 𝜎) that crashes cp1252 Windows consoles.

   ```python
   import sys
   from symbolica import S, E, N
   sys.stdout.reconfigure(encoding='utf-8')  # Unicode math italic; or PYTHONUTF8=1
   ```

   **Unlicensed fallback** (validated 2026-08-14; keep for any machine without the
   key): the banner bypasses `sys.stdout` — it is a native write to fd 1
   (`contextlib.redirect_stdout` swallows 0 bytes) — so only fd-level redirection
   suppresses it:

   ```python
   import os, sys
   _devnull = os.open(os.devnull, os.O_WRONLY)
   _saved = os.dup(1)
   os.dup2(_devnull, 1)                      # native banner writes to fd 1 → devnull
   from symbolica import S, E, N
   os.dup2(_saved, 1); os.close(_saved); os.close(_devnull)
   sys.stdout.reconfigure(encoding='utf-8')
   ```

2. **Author formulas as data.** Symbols via `S('name')`, expressions via `E('...')` or
   arithmetic on symbols. These strings are what would later be hashed/frozen — keep
   them human-readable and minimal.

   ```python
   g, S12, sigma2 = S('g'), S('S12'), S('sigma2')
   level      = S12 * E('exp(g)')            # back-transform
   mean_level = S12 * E('exp(g + sigma2/2)') # Jensen-corrected mean
   ```

3. **Derive, then verify every identity by machine check** —
   `(lhs − rhs).expand()` must render as `0`:

   ```python
   dlevel   = level.derivative(g)
   assert str((dlevel - level).expand()) == '0'          # delta-method factor = level
   bias     = (mean_level / level).expand()              # -> e^(1/2·sigma2), derived
   var_lvl  = (dlevel**2 * sigma2).expand()              # delta Var(level)
   ```

4. **Numerics: numpy computes; the engine cross-checks.** Substitute with `N(...)` and
   call `.evaluate({})` — the constants dict argument is required; the result is
   complex, take `.real` after confirming a zero imaginary part:

   ```python
   v = level.replace(g, N(ghat)).replace(S12, N(S12_value)).evaluate({})
   assert abs(v.imag) < 1e-12
   engine_level = v.real          # must match the numpy computation to float precision
   ```

   **Bit-agreement (or float-precision agreement) between engine and numpy is the
   acceptance test** for the symbolic chain before anything downstream trusts it.

5. **Compare derived vs empirical, and treat disagreement as diagnosis.** Analytic
   normal PIs are symmetric and centered at the point; empirical quantile PIs carry
   skew and model bias. In the validation run the symbolic 80% PIs bracketed the
   empirical ones, but the 95% *upside* did not — which isolated the COVID-rebound skew
   and a +0.6–0.8 pp mean-error bias. Report both; the direction of disagreement is
   information, not failure.

6. **Emit LaTeX from the same objects** for `analysis.md` and chart briefs:

   ```python
   level.to_latex()       # '$$e^{g} S12$$'  (rename symbols for prettier output)
   ```

## 4. Reporting contract (model cards)

Add a `formulas` section to `model_card.json` whenever this skill is used:

```json
"formulas": [
  {
    "name": "level_back_transform",
    "expression": "S12*exp(g)",
    "engine": "symbolica 2.2.0",
    "derivations": {"d_dg": "S12*exp(g)", "delta_var": "S12^2*exp(2*g)*sigma2"},
    "verified_identities": ["d(level)/dg - level == 0", "mean/level == exp(sigma2/2)"],
    "engine_vs_numpy_max_abs_diff": 0.0
  }
]
```

Caveats in `analysis.md` must state which intervals/corrections are analytic (and under
what distributional assumption) vs empirical, and what their disagreement diagnosed.

## 5. Known failure modes (validated)

| Failure | Symptom | Fix |
|---|---|---|
| License banner (native fd-1 write) | Corrupted stdout JSON; `redirect_stdout` swallows 0 bytes | **Resolved 2026-08-15** by `SYMBOLICA_LICENSE` env var; on unlicensed machines use the fd-level `os.dup2` fallback preamble (§3) |
| cp1252 crash printing expressions | `UnicodeEncodeError` on 𝑒/𝜎 | `PYTHONUTF8=1` or §3 preamble |
| `.evaluate()` TypeError | Missing `constants` arg | Call `.evaluate({})` |
| Complex return from evaluate | `(693992.12+0j)` | Assert imag≈0, take `.real` |
| Silent wrong algebra | — | Never report an unverified identity; `.expand()==0` or it didn't happen |
| Single-instance contention | `exit(127)`; "Cannot start new unlicensed Symbolica instance since there is already another one running on the machine" | **Resolved 2026-08-15** by the license (two concurrent instances verified exit 0). Unlicensed = one instance **per machine**, enforced natively; find the lock holder with `powershell "Get-Process python | %{$p=$_; try{$p.Modules|?{$_.FileName -like '*symbolica*'}|%{$p.Id}}catch{}}"` and serialize runs. |

## References

- Symbolica docs: <https://docs.rs/symbolica/latest/symbolica/> · guide:
  <https://symbolica.io/docs/>
- Validation test: `conversations/symbolic-layer-test-2026-08-14.md` · assessment:
  `conversations/symbolic-processing-assessment-2026-08-14.md` · script:
  `data/adl-nowcast-2026-06/symbolic-layer-test.py`
- Duan, N. (1983). Smearing estimate: a nonparametric retransformation method.
  *JASA* 78(383).
