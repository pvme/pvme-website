# Editor development

Start with the [website setup](../README.md). Most page and renderer work can use
the default local editor. Use the mock below to test authentication and submission
without signing in or creating a real PR.

## Run the browser mock

Run `npm run build` once so tests and fixtures have current generated data.
Create the ignored `.env.development.local` file in the website root:

```dotenv
PUBLIC_AUTHENTICATED_EDITING=true
PUBLIC_GUIDE_SUBMISSION=true
PVME_SUBMIT_SECRET=local-only-proxy-example
```

In one terminal, run from the website root:

```sh
node tests/fixtures/guide-api-mock.mjs
```

In another, run `npm run dev`. The mock occupies **localhost:8080**; do not run
the real backend on that port at the same time. Open **http://localhost:4321**,
choose a guide and use **Edit Page → Edit (in place)**. The mock supplies a synthetic
contributor and submission result. It never contacts GitHub.

Change mock state by visiting this URL directly:

```text
http://localhost:8080/__test?identity=99&review=1&scenario=dry-run
```

| Control                               | What to exercise                                               |
| ------------------------------------- | -------------------------------------------------------------- |
| `identity=anonymous`                  | Session expiry                                                 |
| `identity=99`                         | Another contributor                                            |
| `review=0` / `review=1`               | No existing review / existing review                           |
| `stale=1`                             | Source differs from the built page                             |
| `head=b`, `prId=1002`, `prNumber=124` | Review version changes without text changes                    |
| `profile=long`                        | Long contributor name and avatar                               |
| `reset=1`                             | Clear submitted text/counters and reset review version/profile |

The `scenario` control accepts `success`, `delay`, `conflict`, `fork`, `network`,
`server`, `dry-run`, `csrf`, `legacy`, `missing-meta` and `bad-result`. Control
responses include the submission count. Stop the mock after testing and remove
or disable the local editing/submission settings when returning to default work.

For the real local backend, use the adjacent Guide Editor project's setup
instructions and a separate development provider registration. Keep `DRY_RUN=true`,
use local credentials, and confirm `GET /` reports `mode: "dry-run"` before testing.
Real OAuth still contacts providers even when submission is a dry run.

## Request routing and switches

The development proxy in [guide-api-proxy.mjs](../scripts/guide-api-proxy.mjs)
forwards `/api/guide-pr` only to `http://localhost:8080`; it has no production
fallback. That prefix stays at the origin root even with `BASE_PATH` configured.
`PVME_SUBMIT_SECRET` is server-only and must never have a `PUBLIC_` prefix.
The real backend must use the same local secret. Static production builds exclude
the proxy and development session handoff, and use `https://guide-api.pvme.io`.

| Switch                         | Behavior                                                        |
| ------------------------------ | --------------------------------------------------------------- |
| `PUBLIC_AUTHENTICATION`        | Account UI/session restoration; always available in development |
| `PUBLIC_AUTHENTICATED_EDITING` | Authenticated editing; requires authentication                  |
| `PUBLIC_GUIDE_SUBMISSION`      | API submission; requires authenticated editing                  |

Only the exact value `true` enables a production switch. With authenticated editing
off, development uses local guide snapshots and separate local draft keys.

## Rules to preserve when changing the editor

- Preserve exact source bytes outside deliberate edits. Renderer source maps use
  parser ranges and must match the complete source hash. A changed live/review
  source requires rebuilding or the advanced-editor fallback, not an automatic rebase.
- Validate the complete edited guide on entry and after changes, including source
  edits, recovery and undo/redo. Diagnostics never rewrite text. Parser and website
  editorial diagnostics distinguish errors from warnings; unmappable issues open page source.
  Unresolved issues need acknowledgement for the current source before submission.
- Load authenticated source through `/guides/load`. Recheck the selected source
  and contributor before submission. Keep CSRF explicit and in memory, credentials
  included and session/source responses uncached.
- Submit only to `POST /v2/submissions` with `contractVersion: 2`, exact original
  and edited source, `sourcePreservation: 'exact'`, captured contributor, immutable `expectedReview` and explicit
  replacement consent. Do not add legacy fallback or automatic retries, including
  retries after CSRF failures. Limits: title 120 characters, reason 2,000, each
  source 2 MiB of UTF-8 text.
- Bind replacement consent to the account, path, source kind/fingerprint and complete
  review version: repository, branch, head SHA, PR ID, number and URL. Any changed
  version invalidates consent, even if the text is identical. Keep the returned branch.
- Keep drafts isolated by provider/account and source/review version. Logout and
  failures retain drafts. Only deliberate completion of a validated real success
  retires the matching submitted revision; newer/cross-tab drafts survive. Dry-run
  success keeps drafts. Memory recovery cannot survive navigation if storage fails.
- Recovery exports remain available but are marked `recoveryOnly: true`; they do
  not invent review assertions or consent. The local dry-run `unverified` review
  state is permitted only for master, without replacement, after verifying local
  dry-run health. It must never be accepted as a real PR result.

For 401/contributor changes, restore the captured account and reload source. For
CSRF failures, deliberately refresh the session before retrying. For source/review
conflicts, reload and review again. Network failures or malformed results can
mean publication is uncertain: inspect the PR before retrying and retain the draft.
The backend does not provide atomic GitHub transactions or exactly-once submission.

## Verification

Run `npm run verify` and both corpus audits from the main README after editor
changes. The optional test of the adjacent backend uses isolated dry-run settings,
an ephemeral port and blocked external requests. It does not test real OAuth.

Check production flags and bundle safety with the same environment used to build:

```powershell
# Use an isolated terminal. Set SITE_URL and BASE_PATH to the intended destination.
$env:PUBLIC_AUTHENTICATION = 'true'
$env:PUBLIC_AUTHENTICATED_EDITING = 'true'
$env:PUBLIC_GUIDE_SUBMISSION = 'true'
$env:PVME_SUBMIT_SECRET = 'build-safety-sentinel-local-only'
npm run catalogue
npm run previews:prepare
npx astro build --outDir .local/enabled-build
$env:PHASE4_BUILD_DIR = '.local/enabled-build'
npx tsx --test tests/auth-build.test.ts
```

Repeat for all switches off, authentication only, and authentication plus editing
when changing release behavior. `PHASE4_BUILD_DIR` is the existing test variable
for selecting a build directory. These commands create local artifacts, not a deployment.

Browser QA should cover issue navigation, formatting/structural/embed edits,
source mode, undo/redo, recovery, replacement consent and completion. Check
keyboard focus/Escape, narrow layouts, touch dragging, screen readers and storage
denial on supported browsers/devices; DOM tests do not establish device behavior.
The site currently has a dark theme only. Duplicate JSON properties in embeds can
require the advanced editor. Spreadsheet availability checks are omitted because
the website has no authoritative spreadsheet dataset.

After an authorized release, check the deployed assets, flags and API routing.
Real website OAuth and a real PR submission are separate manual acceptance steps.
