# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

## Navigation and ownership

- `README.md` is the sole owner of product configuration, identity, lifecycle, correctness, cleanup, and support boundaries.
- `lib/core.mjs` owns validated state and cache mechanics; `lib/admin.mjs` owns command dispatch.
- `extensions/firstmate-rust-cache.mjs` is the default-off Pi integration; `bin/` contains operator and fail-open compiler-wrapper mechanics.
- `test/` is behavioral evidence. Run `npm run check && npm test`; integration requires sccache 0.17+ and makes no provider or LLM calls.
- This is a Pi package, not Firstmate's narrow `process-event-adapter/1` package. Do not imply unsupported worker hooks or modify Firstmate core.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
