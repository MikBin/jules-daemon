# AGENTS.md
Scope: entire repository (npm workspaces monorepo: `packages/*`, `apps/*`; Node `>=20`; TypeScript ESM).

Build/lint/test:
- Install deps: `npm install`
- Build all projects: `npm run build`; run all tests: `npm run test`; watch tests: `npm run test:watch`
- Run a single test file: `npm run test -- apps/jules-daemon/src/db/database.test.ts`; run a single test case: `npm run test -- packages/contracts/src/contracts.test.ts -t "parses a valid event"`
- Lint command is `npm run lint` (currently fails until `eslint.config.(js|mjs|cjs)` is added).

Architecture:
- `packages/contracts`: shared Zod contracts (`EventV1`, `TaskV1`, `StoryV1`, `AgentV1`, `JulesSession`) and inferred TS types.
- `apps/jules-daemon`: core daemon library with API port (`JulesApiClient`), monitor (`SessionMonitor`), router (`EventRouter`), and SQLite persistence.
- `apps/jules-daemon/src/db`: `sql.js` wrapper + migration schema (`agents`, `stories`, `tasks`, `task_dependencies`, `events`, `leases`, `inbox_messages`).
- `apps/mcp-server`: stdio MCP server exposing `jules_get_pending_events` (reads JSONL event files).

Code style/conventions:
- Use strict TypeScript and keep imports ESM-compatible with explicit `.js` extension in local import paths.
- Prefer named exports/re-exports via `index.ts`; avoid default exports.
- Match existing formatting: double quotes, semicolons, trailing commas, concise JSDoc on public interfaces/classes.
- Naming: classes/interfaces/types in `PascalCase`, functions/vars in `camelCase`; keep persisted contract/database fields in `snake_case`.
- Validate external payloads with Zod schemas; derive types with `z.infer` instead of duplicating interfaces.
- Error handling: fail fast for invalid data, but in polling/routing loops catch/log per-item failures and continue.
- Treat `dist/` and `coverage/` as generated artifacts; edit source under `src/`.

Cross-tool rule files: no `.cursor/rules`, `.cursorrules`, `CLAUDE.md`, `.windsurfrules`, `.clinerules`, `.goosehints`, or `.github/copilot-instructions.md` were found.
