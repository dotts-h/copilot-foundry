# helm-tdd eval harness

Manual prompt-content experiment driver for arm A vs arm B comparisons. Not run in CI.

## Prerequisites

1. Build dist output (the harness imports from `../dist/`):

   ```bash
   cd apps/tdd && npm run build
   ```

2. Python fixture bootstrap (once per machine):

   ```bash
   cd apps/tdd/eval/fixtures/python
   python3 -m venv .venv
   .venv/bin/pip install pytest
   ```

   The driver passes `venvDir: eval/fixtures/python/.venv` to `runFeature`.

## Prompt seam

Arm B appends language-specific guidance via `HELM_TDD_RED_EXTRA`. In production this env var is unset/empty.

`buildRedPrompt` in `src/featureFsm.ts` appends it immediately after `runner.redPromptRules`:

```ts
runner.redPromptRules +
(process.env.HELM_TDD_RED_EXTRA ? " " + process.env.HELM_TDD_RED_EXTRA : "") +
"Do NOT implement ..."
```

Arm A leaves the variable unset; arm B sets it in `run-eval.mjs` before each `runFeature` call.

## Features

`features.json` defines three kata-tier behaviors (`parse_duration`, `format_bytes`, `counter`) with per-language descriptions. Fixtures are minimal git-initializable repos under `fixtures/{python,js,go}/`.

## Running experiments

```bash
cd apps/tdd
node eval/run-eval.mjs --arm A --language py --feature parse_duration --reps 3 --backend cursor
node eval/run-eval.mjs --arm B --language js --feature format_bytes --reps 3 --backend cursor --exp my-exp-1
```

Options:

- `--arm A|B` — control vs table-driven/parametrize guidance
- `--language py|js|go`
- `--feature <key>` — key from `features.json`
- `--reps N` — sequential runs with a fresh fixture copy each (default 1)
- `--backend cursor|claude`
- `--exp <name>` — results subdirectory under `eval/results/` (default: timestamp)

Each run writes JSON to `eval/results/<expName>/` with:

`{ arm, language, feature, rep, status, perSlice, totalCostUsd, durationMs, branch, workspacePath }`

`perSlice` entries carry `mutationScore`, `redLint`, `greenIterationsUsed`, and `refactorScopeViolation` from the ledger (T1/T3 fields).

## Summarizing

```bash
node eval/summarize.mjs eval/results/my-exp-1
```

Prints a TSV table per arm×language×feature: run count, accepted rate, mean mutation score, mean green iterations, red-lint blocking count, mean cost (when present), and branch names for manual test reading.

## Vitest exclusion

Eval code lives under `eval/`, outside `test/` and the vitest `include` glob (`test/**/*.test.ts`). `npm test` count is unchanged.
