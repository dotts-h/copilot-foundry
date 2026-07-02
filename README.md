# copilot-foundry

A vendor-neutral TDD workflow for coding agents. `helm-tdd` runs `RED → GREEN → REFACTOR`
as a finite-state machine that owns the loop, exposes a single async entry point to a
cockpit (Claude Code), and executes phases on a swappable backend (Claude Agent SDK/Sonnet 5 by
default, Cursor/Composer 2.5 as the alternative) behind a structural leash and a constant-mutant
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

M5 makes the Claude Agent SDK (Sonnet 5, subscription auth) the default backend behind a hard
PreToolUse leash; leash enforcement now lives behind the Backend seam; runs execute on isolated
worktrees and deliver a `helm-tdd/<runId>` branch; and `skills/tdd/SKILL.md` is the cockpit
router (the Layout section's `skills/` line is now real).

M6 makes feature mode bilingual: a `TestToolchain` seam abstracts every language-coupled
operation the FSM and gates perform, with `pythonToolchain` (pytest) and `goToolchain`
(`go test -json`) implementations behind it, selected via the new `language` input on the MCP
surface; `venvDir` is now python-only (go reads its module from `go.mod` on PATH). v1 Go gaps:
no mutation gate and no refactor ratchet -- the RED linter and two-assertion RED prompt still
guard triangulation. `mode: "harden"` and the M0 kata FSM remain Python-only.

## Layout

```
packages/   shared platform: core FSM, backend adapters, artifact vault, repo map, memory
apps/       helm-tdd (this milestone) and helm-qa (future)
skills/     generated thin router skills for Claude Code / Codex / Gemini CLI
```

See `docs/superpowers/plans/` for the active implementation plan.

## License

MIT — see [LICENSE](LICENSE).
