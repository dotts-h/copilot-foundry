# copilot-foundry

A vendor-neutral TDD workflow for coding agents. `helm-tdd` runs `RED → GREEN → REFACTOR`
as a finite-state machine that owns the loop, exposes a single async entry point to a
cockpit (Claude Code), and executes phases on a swappable backend (Cursor/Composer 2.5 by
default, Claude Agent SDK as fallback) behind a structural leash and a constant-mutant
completion gate that closes the triangulation hole plain TDD leaves open.

## Status

`apps/tdd` (helm-tdd) M0 through M4 are complete -- the design doc's original M0-M4 roadmap is
fully shipped. The FSM runs `map -> baseline -> scope -> plan -> [RED -> GREEN -> REFACTOR ->
CHECKPOINT -> mutation-gate]* -> verify -> accept -> writeback` for feature mode, with a
structural leash proven to hold against a real, adversarial live `cursor-agent` run; a generic,
language-agnostic RED/GREEN/leash primitive (`packages/core`) proven against both Python and
JavaScript targets; per-phase model overrides exposed on the MCP surface; and a documented handoff
seam a future `helm-qa` app can build on. `mode: "harden"` and full multi-language support for the
big feature-mode pipeline (currently Python-only end-to-end; `packages/core` proves the primitive
generalizes, not yet wired into `runFeature`) remain standalone primitives for a future milestone,
not yet integrated into the main pipeline -- deliberately, matching this project's own "prove
minimally, generalize only when a second real consumer needs it" discipline throughout M0-M4.

## Layout

```
packages/   shared platform: core FSM, backend adapters, artifact vault, repo map, memory
apps/       helm-tdd (this milestone) and helm-qa (future)
skills/     generated thin router skills for Claude Code / Codex / Gemini CLI
```

See `docs/superpowers/plans/` for the active implementation plan.

## License

MIT — see [LICENSE](LICENSE).
