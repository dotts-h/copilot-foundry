# copilot-foundry

A vendor-neutral TDD workflow for coding agents. `helm-tdd` runs `RED → GREEN → REFACTOR`
as a finite-state machine that owns the loop, exposes a single async entry point to a
cockpit (Claude Code), and executes phases on a swappable backend (Cursor/Composer 2.5 by
default, Claude Agent SDK as fallback) behind a structural leash and a constant-mutant
completion gate that closes the triangulation hole plain TDD leaves open.

## Status

Early build. `apps/tdd` (helm-tdd) M0 (proving skeleton), M1 (walking skeleton: feature-mode
map/baseline/scope/plan pipeline, formalized RED/GREEN gates, RED linter, disk-backed async runs),
and M2 (REFACTOR ratchet, per-slice CHECKPOINT patches, the VERIFY ladder, and an ACCEPT
traceability ledger -- the FSM now runs map through accept) are complete. M3 (harden/bugfix/legacy)
is next.

## Layout

```
packages/   shared platform: core FSM, backend adapters, artifact vault, repo map, memory
apps/       helm-tdd (this milestone) and helm-qa (future)
skills/     generated thin router skills for Claude Code / Codex / Gemini CLI
```

See `docs/superpowers/plans/` for the active implementation plan.

## License

MIT — see [LICENSE](LICENSE).
