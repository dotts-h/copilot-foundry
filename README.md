# copilot-foundry

A vendor-neutral TDD workflow for coding agents. `helm-tdd` runs `RED → GREEN → REFACTOR`
as a finite-state machine that owns the loop, exposes a single async entry point to a
cockpit (Claude Code), and executes phases on a swappable backend (Cursor/Composer 2.5 by
default, Claude Agent SDK as fallback) behind a structural leash and a constant-mutant
completion gate that closes the triangulation hole plain TDD leaves open.

## Status

Early build. `apps/tdd` (helm-tdd) M0 (proving skeleton), M1 (walking skeleton), M2 (REFACTOR
ratchet, CHECKPOINT, VERIFY ladder, ACCEPT ledger), and M3 (a generic constant-mutant completion
gate closing the triangulation hole for the full pipeline, extended mutation operators, a dry-run
writeback phase into `memory/`, and a standalone legacy-characterization primitive) are complete --
the FSM now runs map through writeback for feature mode. M4 (scale-out: per-phase model overrides,
more languages, helm-qa handoff, package extraction) is next.

## Layout

```
packages/   shared platform: core FSM, backend adapters, artifact vault, repo map, memory
apps/       helm-tdd (this milestone) and helm-qa (future)
skills/     generated thin router skills for Claude Code / Codex / Gemini CLI
```

See `docs/superpowers/plans/` for the active implementation plan.

## License

MIT — see [LICENSE](LICENSE).
