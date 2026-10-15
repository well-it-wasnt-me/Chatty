# Contributing

Contributions are welcome. Bugs are also welcome, technically, but please file them instead of introducing new and exciting ones.

## Getting Started

```bash
git clone https://github.com/well-it-wasnt-me/chatty.git
cd chatty
pnpm install
pnpm dev          # real mode
pnpm dev -- --demo # demo mode
```

## Commands

| Command | What It Does |
|---------|--------------|
| pnpm dev | Run in development (tsx) |
| pnpm build | TypeScript compile to dist/ |
| pnpm typecheck | tsc --noEmit |
| pnpm lint | eslint . |
| pnpm test | vitest run |
| pnpm test:watch | vitest watch |

## Code Standards

- TypeScript strict. No `any`. No `@ts-ignore` unless absolutely necessary (comment why).
- Pure functions where possible. Side effects at the edges (App.tsx, index.tsx, adapters).
- Reducer is pure. No async in reducer. Async in App.tsx effects.
- Adapter methods either succeed or throw readable errors. No silent failures.
- Log only scalar metadata. Never message contents, QR codes, tokens, session keys.
- Capabilities explicit. If an adapter cannot do something, capability is false and method absent.

## Adding a Platform

1. Define seam interface in `src/adapters/<platform>/types.ts` (structural, minimal).
2. Implement real binding in `src/adapters/<platform>/real-<platform>.ts` (wraps SDK, maps to seam).
3. Create adapter in `src/adapters/<platform>/<platform>-adapter.ts` extending BaseAdapter.
4. Add capabilities constant (honest - only what actually works).
5. Wire in adapter-factory.ts (createAdapters, createAdapterForAccount).
6. Add config schema entries in config/config.ts.
7. Write tests with mock seam.
8. Update docs/platform.md.

## Testing

- Unit tests: pure functions, reducer, seam mocks, command filtering.
- Adapter tests: mock seam, verify connect/send/history/auth flows.
- Integration: manual smoke scripts in scripts/ (require real binaries/creds).
- Run `pnpm test` before pushing.

## Commit Messages

Prefix with type:
- feat: new feature
- fix: bug fix
- refactor: code change no behavior change
- chore: maintenance (deps, config, ci)
- docs: documentation only
- test: test changes

Examples:
- feat: add start-conversation for Slack via users.list
- fix: demo accounts skipped in real mode
- refactor: extract protocol commands to protocol.ts

## Versioning

Automated with Release Please and Conventional Commits. Use `feat:` for a minor release and `fix:` for a patch release; append `!` or add a `BREAKING CHANGE:` footer for a major release. It opens or updates a release PR, maintains the changelog, and bumps the version when that PR lands. A published GitHub release triggers npm publishing and platform binary builds. Configure `NPM_TOKEN` in repository secrets before publishing. No commit-message astrology required.

## Pull Requests

- Pass typecheck, lint, test, build
- Update relevant docs
- No unrelated formatting changes
- Keep PRs focused. One feature/fix per PR.

## Code Style

- ASCII only in comments and strings. No unicode, no emoji, no elongated dashes.
- Comments should sound like a tired, practical person at the bar explaining why the obvious shortcut is how the last three projects caught fire. ASCII only. No typographic drama.
- Function names: verbNoun. Types: PascalCase. Constants: SCREAMING_SNAKE.
- Early returns. Guard clauses. No pyramid of doom.
- Prefer composition over inheritance. BaseAdapter is the only inheritance.

## Security

- Never log secrets. Logger child per adapter with accountId suffix.
- Token files mode 0600. Data dirs mode 0700.
- Auth responses (passwords, codes) never logged - not even length.
- SQLite params always bound. No string interpolation in queries.

## Performance

- Reducer must be fast (runs every keystroke). No heavy computation.
- Repositories use prepared statements. No ad-hoc queries in hot paths.
- Message cache capped at 500 per conversation. Prune on insert.
- Dedupe set capped at 5000. Prune oldest half when exceeded.
- Adapters unref timers so process can exit cleanly.

## Debugging

- Log file: CHATTY_LOG_FILE (default dataDir/chatty.log), level CHATTY_LOG_LEVEL (default info).
- Structured JSON logs. Use jq.
- Demo mode for TUI iteration without credentials.
- Headless smoke: `timeout 3 pnpm dev --real` (exits 1 without TTY - expected).

## License

MIT. By contributing you agree your contributions are licensed MIT.