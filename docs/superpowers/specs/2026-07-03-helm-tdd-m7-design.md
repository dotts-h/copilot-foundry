# helm-tdd M7 — Observable, fail-closed runs + eval-gated pattern embedding

**Date:** 2026-07-03 · **Status:** approved (Horia, 2026-07-03, all four scope answers = recommended options; "proceed with your rec until all done")
**Branch:** `helm-tdd-m7` · **Process:** same as M0-M6 (plan doc → per-task implementation under the `npm run typecheck && npm test` gate → orchestrator review per task → Opus whole-branch review → squash-merge). M5 plan-doc CORRECTION ground truths 1-5 are binding.

## Problem

Four gaps recorded from live M5/M6 runs, plus one experiment:

1. **Runs are opaque.** Leash denials are invisible (root-causing needed a custom stream-logging script), per-phase cost is only minable from transcripts, and raw gate output (test runner stderr/stdout) isn't captured — run-1 of the marketdesk dogfood was root-caused from the branch diff + transcripts instead of the ledger.
2. **The mutation gate can silently lie.** `checkConstantMutantGeneric` returns `attempted:false` and discards its `reason` when the inspection script errors (exit ≠ 0, unparseable output) — indistinguishable from the benign "no literal-arg call found" case. Downstream, errored operators are excluded from the score; zero attempted → score 1.0 → gate passes.
3. **js/go lack the constant mutant.** The operator that closes the TDD triangulation hole exists only for python; js/go have the 3 syntactic operators only.
4. **REFACTOR roams the whole impl file.** Renames, dedup of untouched branches, helper extraction outside the slice — behavior-preserving and gate-held every observed time, but unbounded (observed on marketdesk, governor, twiceshy, chat).
5. **Untested hypothesis:** embedding practicing-tdd-style pattern guidance (table-driven tests, seam assertions) in the RED prompt improves test quality. Prompt content must earn its tokens the same way gates do: baseline first, A/B eval, dogfood.

Plus a routing gap: the `/tdd` cockpit skill only fires on explicit "TDD this" phrasing; sessions implementing features inline in tested repos never consider helm-tdd.

## T1 — Ledger telemetry (first: T5's metrics depend on it)

`RunPhaseResult` gains optional `telemetry`:

```ts
export interface PhaseTelemetry {
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  turns?: number;
  denials: Array<{ tool: string; path?: string; reason: string }>;
}
```

- **ClaudeBackend:** denials pushed to a closure-local array inside the existing PreToolUse hook's deny branch; cost/usage/turns read from the SDK result message (`total_cost_usd` verified present in the M5 spike, currently discarded).
- **CursorBackend:** `costUsd` undefined — Cursor exposes no per-call meter; do not fake it. Shell-hook denials aren't observable in-process → `denials: []` (documented limitation).
- **Ledger:** each slice result carries per-phase telemetry (`red`, `green[]` one per repair iteration, `refactor`); run level carries `totalCostUsd` (sum of defined values) and `totalDenials`.
- **Raw gate output → artifact vault, not ledger.** Per slice, `writeArtifact` captures: RED classification runner output, each GREEN attempt's runner output, and the verify phase's full-suite output. Ledger stays lean and carries artifact pointers. (Rejected alternative: separate JSONL event log — new machinery the vault already provides.)

## T2 — Mutation gate fail-closed

`OperatorMutationResult` gains `outcome: "applied" | "not_applicable" | "error"` and `reason?: string`, propagated through the python gate and both js/go mutation modules. (`applied: boolean` is superseded by `outcome`; migrate consumers.)

- **Constant-operator `error`** → the run finishes with new terminal status **`mutation_gate_error`**; the reason lands in the ledger. An inspection error means the completion gate couldn't do its job — stop and say so.
- **Syntactic-operator `error`** → recorded + excluded from the score + visible in the ledger, but the run continues: those operators never gated acceptance, so no new hard policy.
- Score semantics unchanged for `applied`/`not_applicable`.

## T3 — js/go constant mutant (static extraction)

Python's variant executes the target function on literal args from the test to compute the constant. For js/go, do **static extraction** instead — no module loading, no compile-and-run of target code:

- **js:** using the TypeScript AST machinery already in `jsMutation.ts`, find an assertion of the form `expect(<target fn call>).toBe|toEqual|toStrictEqual(<literal>)`; mutate the target function body to `return <literal>`; run the scoped tests. Pass → mutant survived → constant-mutant gate fails.
- **go:** via the embedded go/ast script pattern already in `goMutation.ts`/`goSymbols.ts`, find a literal expected value compared against a call of the target function in the test file (direct comparison or table-entry `want:` field); mutate the function body to `return <literal>`; `go test` the package.
- No literal expectation found → `not_applicable` (fail-soft, python parity). The RED rule "two assertions with non-trivially-related expected values" makes literal expectations the common case.
- **Non-compiling mutants are discarded as `not_applicable`** (standard mutation-testing convention): a go mutant that fails to build (multi-value returns, type mismatch) means the mutation wasn't valid, not that tests caught it. `error` is reserved for the tooling itself failing (script crash, unparseable output). js needs no compile guard — vitest/esbuild strips types, so a wrong-typed literal fails tests at runtime, which is legitimately "killed".
- Wire into both runners' `computeMutationScore` as operator `"constant"`, subject to T2's outcome semantics (extraction tooling error → `error` → `mutation_gate_error`).

## T4 — REFACTOR scope bounding (revert + record)

**Allowed region** in the impl file = the slice function's span **plus newly-added top-level functions reachable from the post-refactor slice function via calls** (extracted helpers, including helper-calls-helper). Any refactor diff hunk outside the allowed region → restore the pre-refactor file content (the refactor is not yet committed at gate time; GREEN state kept), record `refactorScopeViolation: { hunks }` in the slice result. The run continues — a lost cleanup is cheap; the gate is the message.

- Spans from a new per-runner `functionSpan(filePath, functionName)` helper reusing the AST machinery each runner already has for mutation (python `end_lineno`, TS node ranges, go/ast `End()`); post-refactor spans re-extracted (pre-refactor spans are stale after edits above the function).
- The extracted-helpers allowance is deliberate: helper extraction is the most common legitimate refactor and appeared in every observed roam; strict-span-only would revert nearly every real refactor and reduce the gate to noise.
- Cross-file edits remain the existing diff-guard's job; this bounds within the impl file.
- REFACTOR prompt additionally names the bound ("clean up only `<functionName>` and helpers you extract from it") so the agent is told the rule the gate enforces.

## T5 — practicing-tdd embedding experiment (embed only what wins)

**Hypothesis:** a per-language pattern fragment appended to `redPromptRules` — table-driven/parametrized-test guidance for ≥3-case behaviors (go: table tests; js: `test.each`; py: `@pytest.mark.parametrize`) plus one seam line ("assert on observable behavior, not internals") — improves test quality without dilution.

- **Arms:** A = current prompts (control), B = +fragment. Two arms only (plan-prompt arm deferred — weaker hypothesis, doubles cost).
- **Sets:** positive = 2 kata-tier features per language shaped for the pattern (multi-case pure functions with edge cases); negative = 1 per language where table-driven pressure is wrong (single-behavior, side-effectful). The negative set measures dilution — precision, not just recall (the twiceshy df-gate lesson).
- **Reps:** 3 per feature per arm → 54 runs total; bulk on the **Cursor backend** ($0 Anthropic pool), ~6 SDK spot-check runs (kata-scale ≈ $0.23 each). Same backend within a comparison — never mix backends across arms of the same feature.
- **Metrics** (from T1 telemetry + ledger): mutation score, red-lint results, GREEN repair iterations, cost, terminal status — **plus manual reading of the generated tests** (automated counts overstate both failure and success).
- **Decision rule:** embed the fragment only if the positive set improves consistently AND the negative set regresses on nothing. Then one real-repo dogfood run per language on the winning prompt before merge (branches left for review, not merged).
- **Harness:** `apps/tdd/eval/` — node driver importing `dist` `runFeature` directly (the validated direct-driver pattern), feature fixtures, JSON results + summarizer. Manual invocation only; never CI.

## T6 — /tdd trigger sharpening (no hook)

Broaden `skills/tdd/SKILL.md`'s `description` to fire on feature/bugfix-implementation phrasing in tested python/js/go repos (not just "TDD this"), and add one routing boundary line: helm-tdd for well-scoped behavior changes in supported languages; inline TDD (practicing-tdd) otherwise. Description states triggering conditions only — no workflow summary (SDO rule). Verify with before/after one-shot subagent probes on 3-4 realistic prompts. **No bypass hook** — build one only if real bypass cases accumulate after this change, and then only with its own precision eval (twiceshy push lesson).

## Non-goals

`already_green` policy; js/go scope-phase import parser; harden-mode integration; worktree-prune chasing; embedding any prompt content that has not won its eval; any UserPromptSubmit hook.

## Build order

T1 → T2 → T3 (T2/T3 touch the same modules — sequential, not parallel) → T4 → dist build + kata E2E ×3 languages → T5 harness + experiment → embedding decision (+ dogfood if won) → T6 → Opus whole-branch review → PR → squash-merge → rebuild dist from main.

## Risks

- **Cursor limits mid-eval** (no gauge, reactive-only detection): pause and resume the experiment rather than switching backends mid-arm.
- **T4 false positives** on unusual-but-legitimate refactors: acceptable by design (revert cost = one lost cleanup); the ledger record is the data to revisit the bound.
- **Repo drift:** PRs #11-#14 landed after the design exploration snapshot (Go RED-gate diagnostics, 900s Claude timeout, baseline-relative impacted-subgraph verify) — plan tasks must be written against current `main`, not memory.
