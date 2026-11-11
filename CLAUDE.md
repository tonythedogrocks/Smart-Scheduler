# Limit Break (app repo)

This repo is **public**. It holds only the app code.

## Before any work

Read `CONTEXT.md` in the private data repo (the one the app syncs to) at the start of every session. Ask the owner for that repo's name if it isn't attached. It holds the product decisions, the reasoning behind them, and open work.

## Privacy rule

- Never commit anything personal here: no health, body, schedule, faith, school, money, names, places or goals. Not in code, comments, tests, commit messages, README or this file.
- Personal goals, missions, events, labels and achievements live in the private data repo and load through Sync.
- Tests use made-up data only (`tests/fixture.ts`).
- Before every commit, read the diff for personal details.

## Working on the code

- `npm test`, `npx tsc`, `npm run build` must all pass before pushing to `main`; pushing deploys to GitHub Pages.
- Keep it $0: no paid APIs.
- Sync merges record by record; any new data collection must be added to `COLS` in `src/model/merge.ts` and defaulted in `withDefaults` in `src/model/seed.ts`, and code must tolerate data written by older app versions.
- Ask the owner before changing any wording in the app.
