# Practice refinement implementation plan

> For agentic workers: use subagent-driven-development for independent tasks, then integrate and verify in the current task.

**Goal:** Simplify the personal library and support selecting a measure without losing earlier recorded practice segments.
**Architecture:** Preserve local repository contracts; add optional rendered-measure selection and explicit session-owned recording segments with a shared seek transition.
**Tech Stack:** Existing React, TypeScript, Zustand, OSMD, Web Audio, Vitest.
**Spec:** ../specs/2026-09-13-practice-refinement-design.md

## Global constraints

- Reuse the clean isolated codex/personal-score-library worktree from dev at 0ce4d66.
- Do not change web-deploy, cloud deployment, unrelated designs, or private user fixtures.
- Existing user approval covers this plan; proceed without repeated design gates.
- No new dependencies unless a concrete need is demonstrated; preserve current visual tokens.

## Tasks and file ownership

1. Score interaction worker: inspect rendered geometry, add failing tap/drag/boundary tests, implement optional onMeasureSelect in ScoreSheet and OSMDScore, run relevant tests. No performance/store edits.
2. Recording worker: add failing segment lifecycle/flush/race/replay tests; extend recorder and session state, implement common seek/count-in transition and segment selection in PerformPage/ResultPage. Use the agreed ScoreSheet callback. Run relevant tests and document lifecycle decisions.
3. Parent: simplify PersonalLibrary and library.css, extract accessible action menu if useful, test actual preserved workflows rather than superficial markup, visually inspect representative quantities and widths.
4. Independent read-only review of each completed task and the combined diff. Resolve actionable issues. Run full tests, lint and web/desktop builds.
5. Parent: Computer Use in built-in browser, user MXL and local fixtures, menus/import/edit/folders/cards/list/pagination, real measure clicks, seek/countdown/segments and responsive layouts. Record evidence and limitations in a validation report.
6. Commit reviewed work, fast-forward dev, push dev via the existing authenticated GitHub route; verify remote dev and unchanged web-deploy. Keep localhost available.
