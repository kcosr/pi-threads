# Repository Rules

- This repo is a new external tool, not a Pi modification.
- Do not add a daemon metadata database, transcript copy, archive/tag store, audit log, or durable event replay without a new explicit design.
- Keep core service/domain logic separate from CLI rendering and transport adapters.
- Keep Pi worker protocol adaptation isolated in worker modules.
- Use cwd-aware worker scheduling for new sessions.
- Treat daemon `turnId` as Pi agent-run scoped.
- Keep live smoke opt-in; never run model-costing or destructive smoke by default.
- Update `README.md`, `CHANGELOG.md`, and smoke docs for user-facing behavior changes.
- Run `bun run check` for source changes, focused tests for changed test files, `bun run smoke:mock` after protocol/transport/CLI behavior changes, and `bun run verify` before release-oriented changes.
