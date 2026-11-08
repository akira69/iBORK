# Dashboard appearance implementation plan

> Execute inline with superpowers:executing-plans, then obtain one independent whole-change review.

**Goal:** Deliver the approved GridStack + Recharts recommendation, with polished defaults and identical manual/chat/MCP appearance capabilities on every browser dashboard.

**Design approved in conversation:** Keep GridStack. Replace hand-built power SVGs with responsive Recharts plots. Share compact card styling; expose density, value size, accent, title/legend visibility and optional plot height. Existing layouts inherit defaults. Real widgets render both preview and saved views. Preserve partial history, missing-data gaps, server bindings and the preview/Apply boundary.

**Architecture:** Optional bounded `appearance` on each existing version-1 widget. A shared browser validator and Go tool validator accept the same enum/boolean/height fields. Widget context supplies presentation to chart descendants without changing polling or statistics. Manual controls update the existing draft/layout path; the Assistant uses the existing proposal tool with extended schema and embedded guidance.

**Limits:** density compact/comfortable; valueSize small/medium/large; accent teal/blue/violet/amber/slate; showTitle/showLegend booleans; plotHeight optional integer 120–800 pixels (omitted means fill). Default compact, medium, teal, visible title/legend, automatic height. No generated CSS/HTML or hardware changes. No Tailwind/shadcn framework migration; adapt chart presentation using existing CSS tokens.

## Tasks

1. Contract and Assistant: add failing browser layout and Go proposal tests for round-trip appearance, malformed values and fixed/wall styling; implement optional schema, sanitization, validation and guidance. Preserve old layouts and original draft after rejection.
2. Editor and cards: add Appearance popover on every widget through DashboardGrid; share context/CSS variables, polished defaults and compact one-row behavior. Test saved/reloaded appearance and draft/current/discard/apply behavior across device, fleet and fixed dashboards.
3. Charts: install compatible pinned Recharts/react-is; replace FleetHistory and PowerUsage SVGs, preserve independent fleet contributor segments and missing bucket breaks; default fill with bounded manual plot height, legends and accessible descriptions. Verify zero/missing/partial data and growing/shrinking charts in browser.
4. Qualification: lint, format, build, frontend unit/browser suites, Go race/vet, duplication and dependency security checks; visually inspect desktop/narrow real components. Independent review, fix material findings, then commit, protected PR release and backed-up deployment under existing user authorization.

## Review focus

- Appearance fields survive normalization, geometry-only changes, reload and Assistant round trips.
- Fixed dashboards may change style but retain their inventory and server bindings.
- Plot resizing never changes recorded energy or joins missing/contributor-changing intervals.
- Hidden title keeps accessible naming and edit controls; small widgets do not overflow.
- Invalid model/localStorage appearance cannot inject styles or destroy a valid preview.

## Progress

- Planning: verified clean isolated public worktree, branched from current main; read current validators and shared render path.
- Contract complete: browser round-trip and Go proposal tests failed before implementation and pass with bounded appearance, including invalid proposals and wall inventory preservation.
- Editor/charts complete: shared manual controls, Assistant/MCP styling, Recharts plots, device/fleet/fixed/wall persistence, adaptive plot height and compact defaults.
- Qualification: 147 frontend unit and 163 browser tests pass; Go race suite/vet, lint/build/format/duplication, npm audit and govulncheck pass (no reachable Go vulnerabilities). Real qwen3-coder:30b created six blue, large-value cards and refined to small values while retaining bindings and accents; synthetic telemetry, zero controls.
- Independent review found one Fit-content regression from CSS size containment. The tall-readings regression failed at one row, then passed after removing containment and selecting compact presentation from existing widget row count. No other material review findings. Desktop and phone rendered screenshots inspected.
