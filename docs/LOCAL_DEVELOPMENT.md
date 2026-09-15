# Local Development

## Prerequisites

- Node.js 22.22.3+ (or 24.15.0+ / 26+) and npm 10+ — required by Angular 22's build tooling (developed against Node 22.23.1 / npm 12).
- Optional: [Claude Code CLI](https://claude.com/claude-code) on `PATH` for real execution mode.

## Install

```bash
npm install
```

This is an npm workspaces monorepo (`server/`, `web/`) — one install at the repo root sets up both.

## Environment variables

See [../README.md#environment-variables](../README.md#environment-variables) for the full list. None are required to run locally; every default is safe (mock execution, port 4400/4300, local JSON storage).

To try real Claude Code execution:

```bash
CLAUDE_EXECUTION_MODE=real npm run dev:server
```

Real execution runs against an isolated git worktree on a dedicated branch (`agent/task-<id>`) — your repository's checked-out working tree and current branch are never modified, and changes are never auto-merged. See [REAL_EXECUTION.md](REAL_EXECUTION.md) for exactly how, including the repository-safety guard, timeout and cancellation behavior. Still: point it at a repository whose history you're comfortable with, since `implement()` does write real commits onto that isolated branch.

## Database setup

None required. The MVP uses a JSON-file task store (`data/tasks-index.json`) and per-task artifact directories (`tasks/<task-id>/`) — both created automatically on first run.

## Start the backend

```bash
npm run dev:server
```

Listens on `http://localhost:4400`. Health check: `curl http://localhost:4400/api/health`.

## Start the frontend

```bash
npm run dev:web
```

Serves `http://localhost:4300`, proxying `/api/*` to `http://localhost:4400` (`web/proxy.conf.json`).

## Start both together

```bash
npm run dev
```

## Run tests

```bash
npm test              # everything (server + web)
npm run test:server   # vitest — routing engine, repository inspector, reconciliation,
                       # path sanitization, event bus, API integration, end-to-end happy path,
                       # git-worktree isolation, real-executor hardening (mocked + fixture-CLI)
npm run test:web      # jest — dashboard, create-task, task-detail components
npm run test:e2e      # playwright — full browser flow against the mock executor, headless
```

CI (`.github/workflows/ci.yml`) runs all of these on every push and pull request.

## Build for production

```bash
npm run build
```

Backend compiles to `server/dist/`; frontend builds to `web/dist/web/`.

## Run the first example task

See [../README.md#run-the-first-example-task](../README.md#run-the-first-example-task).

## Troubleshooting

- **Port already in use**: the default ports are `4400` (API) and `4300` (UI); override with `PORT=<n> npm run dev:server` or `npm run dev:web -- --port <n>`.
- **"Repository path does not exist" on task creation**: the `repository` field must be an absolute, existing local directory readable by the server process — not a GitHub URL.
- **Task stuck in `blocked`**: check `task.error` (shown in the UI's error banner) — this is deliberate (ambiguous routing, reconciliation needing a user decision, or exhausted review retries), not a bug to route around silently.
- **`npm install` crashes with `Cannot read properties of null (reading 'edgesOut')`**: a known npm arborist bug triggered by Angular 22's optional peer dependencies (e.g. `vitest`) on some npm 10.x builds. Fix by installing with a newer npm: `npx npm@latest install` (no global change needed).
- **Build fails or `ng serve` errors after a fresh install because `esbuild`/`fsevents` didn't install their native binary**: npm 11+'s `install-scripts` guard blocks postinstall scripts by default. Approve the toolchain's own scripts (all standard native deps of esbuild/Vite/Jest, not arbitrary packages): `npx npm@latest install-scripts approve @parcel/watcher esbuild fsevents lmdb msgpackr-extract unrs-resolver`.
- **`npm run test:e2e` fails with a browser-not-found error**: Playwright's Chromium binary isn't downloaded yet — run `npx playwright install --with-deps chromium` from `e2e/` (or the repo root) once.
- **Real execution says a repository path is unsafe**: this is the guard described in [REAL_EXECUTION.md](REAL_EXECUTION.md#repository-safety-guard) — it deliberately rejects your home directory, system directories and the platform's own source tree. Point it at a specific project directory instead.
