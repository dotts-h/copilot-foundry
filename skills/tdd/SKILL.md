---
name: tdd
description: Use when the user asks to TDD a feature, bugfix, or diff — "TDD this", "red-green this", "test-drive this". Routes the work to the helm-tdd MCP workflow instead of implementing directly.
---

# helm-tdd router

You are the cockpit, not the implementer. NEVER implement the feature yourself — the helm-tdd FSM owns the RED→GREEN→REFACTOR loop, its gates, and its leash.

## Supported languages

Language is auto-detected from the target repo when omitted (`go.mod` → Go; Python markers → Python; `package.json` up to git root → JS/TS). Override with `language`: `"python"`, `"js"`, or `"go"`.

| Language | Test runner | Notes |
|----------|-------------|-------|
| **python** | pytest + venv | `venvDir` required. Point `targetDir` at the repo or package root. |
| **js** (TS, Svelte, RN, etc.) | vitest or jest | `venvDir` not used. In monorepos, set `targetDir` to the **package directory** (where that package's `package.json` lives). |
| **go** | `go test` | `venvDir` not used. **`go.mod` must be at the target repo root** — the Go runner anchors commands at the git worktree root (`workDir`). Top-level test granularity only: indented `--- PASS:` subtest lines from `go test -v` are intentionally not parsed. |

## Workflow

1. Call the `helm-tdd` MCP server's `tdd_workflow_start` with:
   - `targetDir`: absolute path to the target repo (must be a git repo with at least one commit)
   - `venvDir`: absolute path to the repo's Python venv (pytest installed) — **python only**, optional when language is not python
   - `language`: optional `"python"` \| `"js"` \| `"go"` — auto-detected when omitted
   - `featureDescription`: one clear sentence describing the feature
   - `backend`: `"claude"` (default — Claude Agent SDK on Sonnet 5) or `"cursor"`
   - `hitl`: `"plan-only"` to preview the slice plan without executing; `"auto"` to run fully
   - `commit`: `true` only when the user explicitly wants the memory writeback committed
   - `models`: optional per-phase overrides `{plan, red, green, escalation}`
2. Poll `tdd_workflow_status(runId)` — a run takes minutes; poll roughly every 30 seconds and relay the `phase`/`sliceIndex` progress.
3. When status is `done`, fetch `tdd_workflow_result(runId)` and report the ledger `status`. On `accepted`, point the user at the run branch (`ledger.workspace.branchName`) in the target repo for review and merge — the run executed on an isolated worktree, so their checkout was never touched. On any failure status, summarize which gate stopped the run and include the branch name for inspection.

## Example invocations

**Python**

```json
{
  "targetDir": "/abs/path/to/my-python-repo",
  "venvDir": "/abs/path/to/my-python-repo/.venv",
  "featureDescription": "add a slugify helper with tests",
  "language": "python"
}
```

**TypeScript / vitest (monorepo package)**

```json
{
  "targetDir": "/abs/path/to/monorepo/apps/web",
  "featureDescription": "add a formatCurrency helper with vitest coverage"
}
```

**Go**

```json
{
  "targetDir": "/abs/path/to/go-service",
  "featureDescription": "add a Multiply function with table tests",
  "language": "go"
}
```
