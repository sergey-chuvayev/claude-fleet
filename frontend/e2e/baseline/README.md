# Visual baseline of the legacy UI

Screenshots of the current `public/` app (0.54.0) served against the fixture packs in `frontend/src/test/fixtures/`, for human comparison with the React build (plan section 9). They are a reference, not an assertion: a pass needs a person looking at old and new side by side.

```bash
npm i playwright && npx playwright install chromium-headless-shell   # once; or set PLAYWRIGHT_DIR
node frontend/e2e/baseline/capture.mjs            # all shots
node frontend/e2e/baseline/capture.mjs today      # one shot
```

Output: `screens/<viewport>/<shot>.png` for 1440x900, 1280x800, 900x900 and 390x844, plus `screens/manifest.json`.

| Shot | Pack | What it shows |
| --- | --- | --- |
| `sessions` | fleet-mixed | the session list with the first row (a pending approval) selected |
| `sessions-approval` | fleet-mixed | the same approval row selected explicitly |
| `launch-modal` | fleet-mixed | the New agent modal opened over the list |
| `conversation` | conversation-heavy | 200 messages, streaming reply, queued follow-ups, approval, PR strip with failing CI |
| `team-overview` | teams-heavy | a team initiative with 25 delegations |
| `today` | day-full | the Day board with Waiting on you cards and the Day agent |
| `projects` | projects-collision | Alpha launch with colliding deliverables |
| `progress` | day-full | the weekly report |
| `worktrees` | fleet-mixed | the Worktrees tab |

The browser clock is fixed to the fixture clock, animations are off, motion is reduced, and the locale is `en-GB` in UTC. Fonts are the machine's own: regenerate on the same OS before diffing two sets. Not covered: the team editor open, narrow modal height, 200% zoom and long-title rows; add shots to `SHOTS` in `capture.mjs` as the React build reaches them.
