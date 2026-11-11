# Limit Break

A planner that fits each day to how you actually feel. Installable web app (PWA) with a comic-book design.

This repo holds only the app. It has no personal goals or schedule: those live in a private data repo and load once Sync is connected in Settings.

## Run it

```bash
npm install
npm run dev      # local development
npm test         # planner, schedule and sync tests
npm run build    # production build in dist/
```

Append `?now=2026-11-17T09:00` to the URL to pretend it is another time.

## Hosting

Pushing to `main` runs `.github/workflows/deploy.yml`, which tests, builds and publishes to GitHub Pages (Settings > Pages > Source: GitHub Actions).

## Sync

Data is stored on each device and merged record by record into `data.json` in a private repo, through a fine-grained token limited to that repo (Contents: read and write). The token stays on the device and is only sent to api.github.com.

## Where things live

- `src/model/seed.ts`: empty starting state and default settings.
- `src/model/schedule.ts`: the fixed day (wake, meals, commitments with travel, Off Duty, sleep).
- `src/model/planner.ts`: horizon forecast, the day's layout, Orders.
- `src/model/learn.ts`: learning layer (durations, level capacity, level prediction, flares).
- `src/model/merge.ts`, `src/model/sync.ts`: record-level merge and GitHub sync.
- `src/model/vm.ts`, `src/ui/`: shelf > collection > contents > page > panel.
- `tests/fixture.ts`: made-up sample data for tests.
