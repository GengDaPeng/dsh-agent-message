# Repository Guidelines

## Project Structure & Module Organization

- `package.json` is the source of truth for exports, dependencies, runtime metadata, and available scripts.
- `lib/index.js` contains the host-side ESM plugin; `lib/client.js` contains the browser-side ModuleLoader bundle. Keep host and client responsibilities separate.
- `cordis.patch.yml` defines profile integration and supported configuration.
- `docs/` stores versioned design rationale. Refer to the applicable design document and record its decisions, constraints, alternatives, and validation; do not hard-code a specific design version in this guide.
- Keep `README.md` and `README.en.md` synchronized when user-visible behavior or installation changes.

## Build, Test, and Development Commands

Use the package manager selected by the committed lockfile and treat scripts in `package.json` as the current command reference. The minimum repository checks are:

```sh
node --check lib/index.js
node --check lib/client.js
git diff --check
```

Run any build, lint, or test scripts declared in `package.json` before delivery. Smoke-test host changes in a DSH profile and exercise client changes in the browser; do not add permanent tooling solely to duplicate these small checks.

## Coding Style & Naming Conventions

Match the surrounding file and avoid unrelated reformatting. Host code uses ESM and compact, single-purpose functions. Use `camelCase` for functions and variables, `UPPER_SNAKE_CASE` for fixed limits, and `snake_case` for exposed tool names. Preserve the client bundle wrapper, cleanup behavior, and accessibility labels. Keep user-facing Chinese wording consistent across code and documentation.

## Testing Guidelines

Every behavior change needs the smallest runnable check that would catch a regression. Prefer Node's built-in test runner and `test/*.test.js` for standalone logic unless `package.json` specifies another framework. Cover success, rejection, persistence, and cleanup paths affected by the change. For UI work, record the browser interaction tested and include a screenshot when appearance changes.

## Commit & Pull Request Guidelines

Use Conventional Commit prefixes with concise Chinese summaries, such as `fix: 修正离线投递竞态` or `docs: 补充配置说明`. Keep each commit focused. Pull requests must describe the behavior change, affected paths, validation performed, known limitations, and linked issue when available.

Before any `git push` or other update to a remote Git ref, obtain the user's explicit approval for that remote operation. Approval to edit, stage, or commit locally does not authorize a push.

## Security & Configuration

Never commit local DSH profiles, session logs, credentials, or tokens. Validate external identifiers and persisted events at trust boundaries, preserve authorization and lifecycle guards, and avoid exposing sensitive values in errors or debug output.
