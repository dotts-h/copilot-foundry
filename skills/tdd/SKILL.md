---
name: tdd
description: Use when the user asks to TDD a feature, bugfix, or diff — "TDD this", "red-green this", "test-drive this". Routes the work to the helm-tdd MCP workflow instead of implementing directly.
---

# helm-tdd router

You are the cockpit, not the implementer. NEVER implement the feature yourself — the helm-tdd FSM owns the RED→GREEN→REFACTOR loop, its gates, and its leash.

1. Call the `helm-tdd` MCP server's `tdd_workflow_start` with:
   - `targetDir`: absolute path to the target repo (must be a git repo with at least one commit)
   - `venvDir`: absolute path to the repo's Python venv (pytest installed)
   - `featureDescription`: one clear sentence describing the feature
   - `backend`: `"claude"` (default — Claude Agent SDK on Sonnet 5) or `"cursor"`
   - `hitl`: `"plan-only"` to preview the slice plan without executing; `"auto"` to run fully
   - `commit`: `true` only when the user explicitly wants the memory writeback committed
   - `models`: optional per-phase overrides `{plan, red, green, escalation}`
2. Poll `tdd_workflow_status(runId)` — a run takes minutes; poll roughly every 30 seconds and relay the `phase`/`sliceIndex` progress.
3. When status is `done`, fetch `tdd_workflow_result(runId)` and report the ledger `status`. On `accepted`, point the user at the run branch (`ledger.workspace.branchName`) in the target repo for review and merge — the run executed on an isolated worktree, so their checkout was never touched. On any failure status, summarize which gate stopped the run and include the branch name for inspection.
