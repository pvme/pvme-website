# PvME Website

RuneScape 3 PvM guides, Slayer methods, resources and tools.

## Setup

Use Node.js 24 and clone [pvme-guides](https://github.com/pvme/pvme-guides) beside this repository. For another location, set `GUIDES_DIR` in `.env`; see [.env.example](.env.example). Parser 0.5.0 is published and installed from the lockfile; no local parser tarball is required.

```sh
npm ci
npm run dev
```

Open **http://localhost:4321**. Use localhost consistently for authentication: 127.0.0.1 has a different origin and cookies. Astro uses strict port 4321. Restart Astro after configuration changes.

## Authentication and release switches

The compact account menu supports Discord and GitHub login, contributor name/avatar, session refresh and logout. It restores the shared Guide Editor API cookie with credentialed, uncached `/auth/me`. CSRF stays in memory. Both production page paths use `https://guide-api.pvme.io`; page prefixes are not CORS origins.

**Public authentication, authenticated editing and submission default closed in application code; the production [Pages workflow](.github/workflows/pages.yml) explicitly enables all three.** Production requires `PUBLIC_AUTHENTICATION=true` to show the account menu or restore sessions, `PUBLIC_AUTHENTICATED_EDITING=true` to initialise authenticated editing, and `PUBLIC_GUIDE_SUBMISSION=true` to connect submission. Editing depends on authentication; submission depends on both. Only the exact value `true` enables a switch. Release requires approval before committing/pushing the prepared workflow. To close a feature, set its workflow value to `false` and rebuild; closing authentication also closes editing and submission. The external Guide Editor remains available. These are build-time release controls; the backend enforces authorization.

As of 27 November 2026, parser 0.5.0 is published and used by both clients. The shared strict v2 backend is live at **`submitguideupdate-00066-kim`** on `https://guide-api.pvme.io`, with dependency patches, logging/cache hardening and session-secret rotation completed. The Guide Editor frontend is deployed. The owner revoked their old GitHub authorization, logged in again, submitted a real guide PR and checked it on GitHub; subsequent checks passed. This verifies that account’s flow, not every user’s grant revocation or every provider/device. Website release preparation does not require backend redeployment or parser changes. The strict website contract is documented below and fails closed against older backends.

Development always permits local authentication. Leaving authenticated editing false preserves the existing static-source editor and `local-development` draft keys. To exercise the integration, create ignored `.env.development.local`:

```dotenv
PUBLIC_AUTHENTICATED_EDITING=true
# Enable submission only against a verified local dry-run backend or the local mock.
PUBLIC_GUIDE_SUBMISSION=true
PVME_SUBMIT_SECRET=local-only-proxy-example
```

`PVME_SUBMIT_SECRET` is server-only and must never have a `PUBLIC_` prefix. Use the same local-only value in the backend. The development proxy has exactly one upstream, **http://localhost:8080**, and never falls back to production. `/api/guide-pr` mounts at the origin root even with `BASE_PATH=/pvme-website/`, before Astro's base guards. It forwards JSON, cookies, CSRF, query strings, manual redirects and every Set-Cookie separately. Only this development proxy removes Secure and changes SameSite=None to Lax. Host/origin must be localhost:4321. Preview/static production builds do not install the proxy or include dev-session completion.

## Local dry-run backend

Use an isolated PowerShell terminal in the existing adjacent Guide Editor checkout, without production credentials. Install its backend dependencies separately if needed; its declared runtime is Node 22.

```powershell
Set-Location ..\guide-editor
$env:DRY_RUN = 'true'
$env:PVME_SUBMIT_SECRET = 'local-only-proxy-example'
$env:AUTH_COOKIE_SECRET = 'local-only-cookie-example-change-for-your-machine'
$env:AUTH_COOKIE_SECURE = 'false'
$env:AUTH_COOKIE_SAMESITE = 'Lax'
$env:ALLOWED_ORIGIN = 'https://pvme.io,http://localhost:5173,http://localhost:4321'
$env:TRUSTED_ORIGIN = 'https://pvme.io'
$env:FRONTEND_ORIGIN = 'http://localhost:4321/pvme-website/'
$env:DISCORD_REDIRECT_URI = 'http://localhost:4321/api/guide-pr/auth/discord/callback'
$env:GUIDE_EDITOR_GITHUB_OAUTH_REDIRECT_URI = 'http://localhost:8080/auth/github/callback'
Remove-Item Env:\AUTH_COOKIE_DOMAIN -ErrorAction SilentlyContinue
npm --prefix cloud-functions/guide-pr start -- --port=8080
```

Confirm local health reports `mode: dry-run`. With the local submission switch enabled, website requests go only through localhost:4321 to localhost:8080. Never disable DRY_RUN or use production credentials for this verification.

Real login requires separately registered development provider applications. Configure Discord's `DISCORD_CLIENT_ID`/`DISCORD_CLIENT_SECRET` with callback `http://localhost:4321/api/guide-pr/auth/discord/callback`; add the 5173 callback if also using Guide Editor. Configure GitHub's `GUIDE_EDITOR_GITHUB_OAUTH_CLIENT_ID`/`GUIDE_EDITOR_GITHUB_OAUTH_CLIENT_SECRET` with the single callback `http://localhost:8080/auth/github/callback`. If using the existing fixed 5173 GitHub callback instead, keep that frontend running. No GitHub App credentials are needed for dry-run master reads. OAuth still makes real provider exchanges when invoked.

GitHub's encrypted local handoff is removed from the URL before requests, posted through the local proxy and never persisted. Referrer policy prevents leaking it in referrers. Production excludes local handoff completion. Login return URLs preserve the full page path, duplicate query parameters and fragment, including `/pvme-website/`; transient `submit`, `authError` and `githubSession` values are removed. Errors render as plain text. After login, reopen editing to restore the matching contributor draft.

## Inline editing, submission and drafts

Choose **Edit Page → Edit (in place)**. Authenticated mode revalidates eligibility before entering and before source rechecks. Discord requires PvME membership; GitHub scope/permission enforcement uses the existing backend. Anonymous readers keep the static page. Session restoration errors fail closed without opening an intrusive menu.

The established visual editor, structural controls, source validation, undo/redo and exact review diff remain. Authenticated sources come from `/guides/load`, never the static development snapshot. Existing PRs require **Load submitted update** or **Load live guide**. The explicitly selected source is refetched before payload preparation.

The inline checker validates the complete current guide on entry and after edits, with a short typing debounce. Issues are shown in the editing canvas on entry; the toolbar count returns to that list. Issues identify their heading/block and source line, with the same source locations shown on visual blocks. **Page source** opens the complete guide with line numbers and Apply/Cancel controls. Issue actions open that source location, and **Underline heading** makes an explicit undoable formatting change. Pending page/message/section source is checked without applying it. Parser diagnostics and website-local adaptations of Guide Editor's editorial rules remain separate from source content; validation never fixes text automatically. Editorial checks include headings, list indentation, spacing, links, emoji usage, Discord message/embed limits and Table of Contents conventions. Emoji availability uses the bundled catalogue; spreadsheet availability checks are omitted because the website has no authoritative spreadsheet dataset. Review shows unresolved issues and requires explicit acknowledgement for the current source before submission. This is separate from replacement consent and does not change the strict v2 payload or recovery export.

The exact UTF-8 source hash must match the immutable rendered map. Changed master/review text blocks inline editing without rebasing: retain/export the draft and open Guide Editor, or wait for a site rebuild. Reloading a static page alone does not update its maps.

With submission enabled, **Submit for review** refetches that source, preserves `EditSession.prepareUpdate` identity/fingerprint checks, revalidates the contributor immediately before POST and sends exact `originalContent` and complete edited `content` with `sourcePreservation: 'exact'`. The only submission endpoint is **`POST /v2/submissions`**; requests include `contractVersion: 2`, the contributor captured when editing opened, the unchanged `expectedReview` and explicit replacement boolean. There are **no automatic submission retries, including CSRF retries**, and no legacy fallback. Title limit: 120 characters; reason: 2,000; each source: 2 MiB of UTF-8 text. Pending requests prevent duplicates.

**Export update JSON** remains available for recovery even when fresh source loading or strict metadata is unavailable. It is marked `recoveryOnly: true`, includes captured contributor/review metadata when known, and does not invent a v2 assertion or replacement consent. Reload/validate source and obtain any required consent before turning an export into a submission. With submission disabled, the established export-only review action remains functional.

A loaded review uses its returned contributor branch to update the PR. Loading master with an existing review displays its PR link and requires a replacement checkbox. Consent binds the captured account, path, exact source fingerprint, source kind and **complete immutable review version**: repository, branch, 40-character head SHA, PR database ID, number and URL. Selected-source responses must carry validated `reviewState`; changes to any version field, even with identical source text, block the recheck. New reviews, disappearance and closure invalidate a prior assertion. Source edits, identity changes and failed submissions clear consent. Reloading requires a fresh explicit confirmation; no expected version is silently refreshed. Only an explicitly confirmed master operation sets `replaceExistingReview: true`. Returned branch names are retained, not reconstructed by the website.

Live `StrictGuideUpdate` permits `expectedReview: {state:'none'}` or the complete present version. The separate `LocalDryRunGuideUpdate` permits `{state:'unverified'}` only for master, replacement false, development mode and a local health response confirming DRY_RUN. This exception is checked again before submission and can never produce a validated real-PR result. It does not fabricate an assertion that no review exists. Old/missing/malformed metadata blocks authenticated editing/submission while retaining recovery options.

Real success distinguishes new PR creation from updating an existing PR, shows the returned link and disables repeat submission of that exact edit. **Return to guide** is the deliberate completion action: it retires only the captured identity/path/source/draft revision and restores published reading without a PR preview. A stored revision is eligible for retirement only when its source metadata, complete review version and edits match the submitting session. A newer draft saved by another tab **before submission begins** is retained even when it is already the current storage head. Ambiguous/legacy snapshots remain recoverable if they cannot be matched. Newer edits and other accounts' drafts remain. Retirement uses a revision-specific marker instead of deleting the shared draft head, so an interleaving cross-tab save cannot be erased by compare-then-delete. Retired source bytes may remain in storage but are no longer offered as active drafts; there is no broad storage cleanup.

Dry-run success clearly says no PR was created or updated and retains the draft. Draft namespaces use stable `github:<githubId>` or `discord:<discordId>`, with source/hash/branch and captured review-version metadata. Logout, expiry, OAuth and account changes retain the previous namespace. Account changes remove private canvases/previews before switching; reopen editing after logging back in to recover. Accepted in-flight results retain their original contributor and draft revision; they never transfer cleanup to the newly displayed account. Authenticated drafts are not painted automatically into the reading page. Existing development keys and older compatible drafts remain supported. Versioned drafts reject restoration onto changed review versions; old versionless drafts can recover edits only against fresh matching source, without manufacturing a historical review version or consent.

Finish or cancel unapplied source/property inputs before OAuth navigation. Storage failures retain a contributor-isolated recovery copy in tab memory, including after forced suspension, but cannot make it durable across page navigation: export before leaving if storage is unavailable.

## Strict failures and backend release requirements

| Error                                                                                      | Deliberate recovery; draft retained                                                                                                                                                                           |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CONTRIBUTOR_MISMATCH`, 401                                                                | Restore the captured contributor; reload the selected source and review again.                                                                                                                                |
| `CSRF_INVALID`                                                                             | Refresh the session deliberately, confirm the original contributor, then review/resubmit. Exactly one POST per attempt; no automatic refresh/retry. Logout retains its separate established refresh behavior. |
| `INVALID_CONTRACT`, `INVALID_CONTRIBUTOR`, `INVALID_REVIEW_STATE`, `STRICT_ROUTE_REQUIRED` | Correct the strict integration; never remove assertions or use a legacy route.                                                                                                                                |
| `REPLACEMENT_CONSENT_REQUIRED`                                                             | Reload and explicitly confirm the displayed immutable version.                                                                                                                                                |
| `REVIEW_STATE_CONFLICT`                                                                    | Publication may already have occurred. Inspect before retrying, reload source and obtain fresh consent.                                                                                                       |
| `SOURCE_CONFLICT`, other 409                                                               | Inspect/reload exact source; no automatic merge, rebase or overwrite.                                                                                                                                         |
| `FORK_SYNC_REQUIRED`                                                                       | Inspect the fork and use GitHub's **Sync fork → Update branch**, resolving workflow conflicts; then reload source/consent.                                                                                    |
| Other 403, 404, 413, 429                                                                   | Resolve permission/scope, inspect unavailable source/v2 support, reduce/export oversize source, or wait respectively. A missing v2 route never falls back.                                                    |

Network errors, malformed success responses, proxy failures and server/provider failures may represent uncertain publication. Inspect the contribution before manually retrying. Every failure/uncertain outcome retains the draft. Success must match contract version, captured contributor, path, owned returned branch, allowed PR URL, HTTP status and new/existing PR semantics (201 new, 200 existing). Dry-run separately validates HTTP 200, public identity, byte counts, title/source/branches and `reviewStateVerified: false`. Invalid results never trigger cleanup. Public-user responses are allowlisted, CSRF stays in memory, OAuth access tokens are never exposed, and requests are credentialed and uncached.

The live backend provides server-side contributor assertions and immutable review-version checks. Both clients use the strict contract. Website production assets, entry points and effective API routing must be checked after its approved deployment; production OAuth and a real website submission remain deliberate manual checks. Legacy backend compatibility routes remain available for cached clients; retiring them requires a separately reviewed backend change after both clients are deployed and verified and an agreed legacy-usage monitoring window is complete.

GitHub refs, master, fork preparation and PR metadata are separate resources with **no atomic transaction**. Non-force publication is not an exact-old-SHA compare-and-swap. PR closure/reopening/replacement after checks, external force rewinds/ref recreation, upstream movement and sequential metadata writes can still race; failures after publication can leave source without corresponding PR metadata. There is no automatic rollback. Idempotency keys and authoritative uncertain-result lookup remain future backend work. Duplicate prevention covers overlapping/repeated confirmed edits in the active workflow, not exactly-once or cross-device transactions. The owner’s completed Guide Editor acceptance and backend hardening are recorded above. Remaining website/provider/device checks are listed below; local tests do not prove production OAuth or exactly-once publication. No backend, parser or canonical-guide repository was modified by this website implementation.

## Checks and local browser fixture

```sh
npm run verify
npx tsx scripts/audit-source-maps.ts
npx tsx scripts/audit-page-canvas.ts
```

`verify` builds the catalogue/site, checks types, and runs website/catalogue tests. Site tests inspect `dist/`, so rebuild after route/template/asset changes. Focused tests cover source preservation, auth/CSRF, runtime validation, account/source choice, replacement, duplicate prevention, all recovery states, successful draft lifecycle, newer/cross-tab drafts, dry-run and release switches. No credentials are needed.

For native browser QA, build once, enable the local editing/submission switches and run `node tests/fixtures/guide-api-mock.mjs` on an unused localhost:8080. It returns synthetic contributors and PR results and never contacts GitHub. Visit port 8080 directly for `/__test?identity=99&review=1&scenario=dry-run`. Controls: `identity=anonymous` simulates expiry; `review=0` removes review metadata; `stale=1` changes review text; `head=b` changes the SHA without changing text; `prId`/`prNumber` change PR identity; `profile=long` enables a long Unicode name/public avatar. `reset=1` clears synthetic submitted text/counters and resets version/profile (set the long profile separately afterwards). Scenarios `success`, `delay`, `conflict`, `fork`, `network`, `server`, `dry-run`, `csrf`, `legacy`, `missing-meta` and `bad-result` exercise the matching states. The control returns a submission count; the fixture's legacy POST rejects strict writes. Do not run it alongside the actual backend; stop QA servers afterwards. These controls are only in the fixture, not the website or real backend.

The actual local Cloud Function test starts the adjacent Phase 6A Functions Framework on an ephemeral port with isolated DRY_RUN configuration, a test-only encrypted session and external fetches blocked. One public raw-master fixture is returned entirely in memory, with no outbound request. It exercises `/auth/me`, real unverified `/guides/load`, local health verification, exact v2 submission and draft retention; it also checks contributor mismatch, explicit CSRF, wrong version/review/replacement and strict-on-legacy-route rejection. It skips explicitly if adjacent backend dependencies are unavailable. It does **not** verify real OAuth, GitHub writes, live review discovery or production freshness. Mocked live-mode lifecycle tests and browser checks verify frontend states separately.

## Source-map findings and verification history

The three DPM failures were website renderer/provenance defects. The parser correctly retains `> ` inside Discord-style headings; the renderer intentionally strips it for presentation but previously annotated its original value as visible editable text. Inline mapping now requires the displayed text to equal the parser leaf. Plain quote-prefixed headings retain whole-line editing through explicit heading-offset provenance and the existing prefix-preserving line model. Hidden quote markers never become editable text. Canonical guides, parser output and the audit remain unchanged. Regression tests cover all three actual DPM guides, ordinary blockquotes, DOM equivalence and existing heading/link editing.

Phase 4 baseline verification passed 181 website and four catalogue tests; its final record passed 202 website and four catalogue tests with no type errors. It checked flag-off/on builds, uncached session restoration, contributor isolation, stale review fallback and logout in native Chrome. Its source-map audit had three failures in `dpm-advice/dpm-advice-mage.txt`, `dpm-advice/dpm-advice-necro.txt` and `dpm-advice/dpm-advice-range.txt`, all `Displayed value differs: '' !== '> '`. Its page-canvas audit passed 612 guides, 33,189 blocks and 1,339 edited embeds; two duplicate-JSON-property guides remained advanced-editor-only.

Phase 5 native Chrome checks confirmed a synthetic new-PR result/link, disabled duplicate action, completion restoring published reading without the submitted heading, explicit existing-review/live-source selection, refusal without replacement consent, explicit consent with dry-run feedback and uncertain upstream failure with recovery guidance. The mock recorded exactly three POSTs: success, dry-run and simulated network failure; the refused replacement sent no POST. No real PR URL was opened or real submission sent. QA servers were stopped afterwards.

Final Phase 5 verification on 26 November 2026 passed `npm run verify`: **224 website tests and four catalogue tests**, no type errors. The actual local Cloud Function dry-run test ran successfully as part of that suite. The unchanged source-map audit passed **all 612 guides**, verifying 68,642 text mappings, 592 link labels and 770 URLs with zero invalid guides. The page-canvas audit also passed all 612 guides, retaining its two existing advanced-only duplicate-property cases. Production builds with switches closed and fully enabled under `/pvme-website/` passed asset/flag checks; proxy secrets/headers, localhost backend code, mock identities and dev-session completion were absent. At that verification, the closed build remained in `dist/`; the enabled verification artifact is ignored under `.local/phase5-enabled-dist/`. `git diff --check` passed. No deployment, commit, push, production credential retrieval, real PR or GitHub write was performed.

## Phase 6B.1 implementation and verification record

Final local verification on 26 November 2026:

| Acceptance area          | Implementation and verified evidence                                                                                                                                                                                                                                                                                                  |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Strict v2 API            | Exclusive versioned POST, typed request/result validation, captured provider-qualified contributor, explicit in-memory CSRF, exact source, status/PR consistency and zero submission retries. Mocked tests reject outdated routes, malformed responses and mismatched identities without cleanup or downgrade.                        |
| Immutable review/consent | Complete validated `none`/`present` metadata and separate verified-local `unverified` exception. Tests reject changed head with identical bytes, changed repository/ref/PR ID/number/URL, appeared/disappeared reviews and expired consent; frozen captured assertions survive asynchronous revalidation unchanged.                   |
| Draft lifecycle          | Revision-specific retirement, captured-account receipts, newer/cross-tab saves, provider isolation, logout/expiry, unavailable-storage memory recovery, old/versioned draft recovery and recovery exports pass automated tests. Dry-run never retires drafts. Published reading is restored only by the deliberate completion action. |
| Structured failures      | All ten named v2 errors covered with no automatic retry; late review conflicts, malformed success and network/provider failures retain drafts and direct inspection before retry. No automatic consent refresh, merge, rebase or overwrite.                                                                                           |
| Actual local backend     | The adjacent Phase 6A Functions Framework test **ran and passed**, with synthetic encrypted auth, explicit CSRF, real guide loading/health/v2 dry-run validation and external networking blocked. No skipped tests. This is validation evidence, not publication evidence.                                                            |
| Complete suite           | `npm run verify`: **236 website tests + four catalogue tests**, zero failures/skips, zero type errors. One pre-existing `execCommand` deprecation hint remains. The recovered Phase 5 baseline was 224 + four.                                                                                                                        |
| Source maps              | Full corpus: **612 guides**, 68,642 text mappings, 592 link labels and 770 URLs; zero invalid guides.                                                                                                                                                                                                                                 |
| Page canvas              | Full corpus: **612 guides**, 33,189 blocks, 9,619 messages, 1,341 embeds, 8,251 property no-ops and 1,339 edited embeds; zero invalid guides. `archive/swiftgloves.txt` and `basic-guides/barrows-basic.txt` retain their existing advanced-only duplicate-JSON-property limitation.                                                  |
| Production matrix        | All four staging-base builds below pass account/edit-entry flag checks and production asset safety checks. At that verification, `dist/` was fully closed and no release configuration file was enabled.                                                                                                                                           |

| Build                           | Authentication | Editing | Submission | Local artifact               |
| ------------------------------- | -------------- | ------- | ---------- | ---------------------------- |
| Closed default                  | false          | false   | false      | `dist/`                      |
| Authentication only             | true           | false   | false      | `.local/phase6b-auth-only/`  |
| Authentication + editing        | true           | true    | false      | `.local/phase6b-editing/`    |
| Fully enabled verification only | true           | true    | true       | `.local/phase6b-submission/` |

All builds used `BASE_PATH=/pvme-website/` and a synthetic server-only secret sentinel. Each artifact passed `tests/auth-build.test.ts` with matching flag environment and `PHASE4_BUILD_DIR` pointing to that artifact. Scans reject the sentinel, proxy secrets/headers, localhost upstreams, mock identity/controls, proxy implementation markers and `/auth/dev-session`. The harmless shared API-client development-base string is not a proxy implementation or installed middleware; the Vite proxy remains serve-only and the development handoff module is absent from production assets. Enabled artifacts are ignored local review outputs, not deployments.

To reproduce a non-default configuration, set all three flags explicitly in an isolated shell, run `npx astro build --outDir .local/<configuration>`, then run `npx tsx --test tests/auth-build.test.ts` with `PHASE4_BUILD_DIR=.local/<configuration>` and the same flags. For default verification, set all flags to `false`, unset `PHASE4_BUILD_DIR`, and run `npm run verify`. For release verification, match the workflow’s explicit flags, `SITE_URL` and `BASE_PATH`.

Local evidence is ignored under `.local/phase6b-final-verify.log`, `.local/phase6b-final-source-audit.log`, `.local/phase6b-final-canvas-audit.log`, `.local/phase6b-final-ux-tests.log` and `.local/phase6b-final-<configuration>{,-safety}.log`. `git diff --check` passed. No other repository, production credentials, deployment, commit, push or real GitHub write was involved.

The targeted pre-Phase 6C draft-retirement follow-up reproduced and fixed a cross-tab regression: Tab B could save newer edits before Tab A began submitting, and Tab A incorrectly captured that unrelated storage revision for retirement. Retirement capture now requires matching source metadata, review version and edits. The regression confirms Tab A submits its older content while Tab B's newer draft remains unchanged and restorable after completion. Existing matching-revision retirement and saves during submission/completion still pass. The follow-up `npm run verify` passed **237 website tests + four catalogue tests**, with zero failures/skips and zero type errors, including the actual offline Functions Framework test; that run left a closed build in `dist/`. Evidence: `.local/phase6b-final-draft-regression-verify.log`. The four-configuration matrix and corpus audit results above are from the preceding Phase 6B.1 verification.

### UX fixes, evidence and limits

The existing design and framework remain. Long contributor names truncate visually with the complete name in the accessible label/title; avatars stay 24×24. Account menus dismiss on outside click/Escape. Completion focus returns to the original edit entry, including the queued native dialog-close event. Keyboard block actions can close with Escape and return to their summary. Section moves now retain selection/focus on the moved heading rather than an unrelated descendant/detached control. Moving a complete heading still preserves its children and undo history.

Edge scrolling now recomputes the highlighted drop zone on every scroll frame while a pointer is stationary. Returning near the original pointer-down position updates/stops edge scrolling; cancellation/lost capture clears drag state. Automated regressions cover stationary touch-pointer scrolling, updated targets, returning to the middle, cancellation without source changes, section movement/focus and undo. Existing automated coverage verifies narrow toolbar overflow, structural/text editing, review dialogs, replacement consent, pending/failure/dry-run/success and storage recovery.

Native Chrome observations from the first Phase 6B.1 session verified desktop toolbar layout, account Escape dismissal and the full long Unicode name in accessibility output; a mouse heading drag reported “Section moved” and Undo restored it. A forced `CSRF_INVALID` produced exactly **one POST** with retained-draft/manual-refresh guidance. A deliberate later attempt produced the synthetic strict new-PR success/link, disabled duplicate submission and **Return to guide** restored published reading without the inserted heading. No PR link was opened. These observations predate the final focus/drag fixes; those fixes passed regression tests but still need a native-browser rerun.

The resumed QA browser was minimised; the available native controller could not obtain a usable window or restore it, and the browser host was unavailable. Further native checks could not be completed. Do **not** treat automated pointer events or responsive toolbar unit tests as physical-device evidence. Remaining checks:

- Rerun keyboard focus/trapping/Tab/Escape through account, insertion, block actions, review/replacement and completion dialogs in native browsers, especially after structural changes.
- Inspect long-name/avatar layout and editing toolbar at 320/375/600-pixel widths, landscape, zoom and with an on-screen keyboard. Verify all review states and fallback/recovery actions remain reachable without horizontal clipping.
- Test real touch text selection, structural controls, long-distance dragging, stationary edge hold, direction reversal, cancellation and lost capture on iOS Safari and Android Chrome; test Firefox/Safari desktop and screen-reader announcements. Native mouse drag evidence is not a prolonged edge-hold test.
- The current website explicitly uses `color-scheme: dark` and has **no light-theme implementation/control**. Dark design tokens were preserved; a light-theme visual pass is unavailable and has not been claimed. Adding a light theme requires separate scope/design work. Check OS contrast/reduced-motion behavior on supported devices.
- Verify actual storage denial/quota exhaustion, multi-tab recovery and export before navigation in native browsers. Memory fallback cannot survive navigation when durable storage is unavailable.

## Website release and manual acceptance

- Before release, run `npm run verify`, both corpus audits and the production bundle safety checks with all three workflow switches enabled at the configured Pages base path. Review the complete diff and remote branch status, then obtain one final approval before staging, committing, pushing or changing repository settings.
- The approved push to `main` triggers **Deploy website**, which builds/tests and publishes `dist/` to GitHub Pages. The workflow supplies all three switches directly; no release-switch repository variables are required. After deployment, check the deployed asset hashes, account/editing entry points and production API origin/strict route.
- Manually verify website GitHub/Discord login, cancellation, logout and return path/query/fragment behavior on supported browsers/devices. The owner’s Guide Editor GitHub acceptance does not cover these website checks or other users’ grants.
- Manually review a small website edit, submit once, check the PR and return to the guide. For an existing contribution, verify source selection and version-bound replacement consent. Confirm recovery/export and newer drafts survive failures or account changes. Do not automate OAuth completion or real PR submission.
- Keep the native-browser/device limitations above explicit. Broader real lifecycle/race testing and legacy-route retirement require separately authorised scope. Monitor conflicts/errors after release and retain the ability to close each build switch.

## Project structure and deployment

- `src/components/`: shared shell, account UI, editor and review controls.
- `src/lib/guide-api.ts`, `submission-contract.ts`, `guide-submission.ts`: typed validated API, orchestration and lifecycle.
- `src/lib/review-state.ts`: immutable v2 review versions, ownership checks and local dry-run distinction.
- `src/lib/authenticated-source.ts`, `release-flags.ts`: selected-source revalidation and release switches.
- `scripts/guide-api-proxy.mjs`: server-only fixed localhost proxy before Astro base guards.
- `src/lib/edit-session.ts`, `draft-storage.ts`: immutable sources, exact updates and contributor drafts.
- `src/lib/renderer.ts`, `source-map.ts`, `source-lines.ts`: rendering and parser-owned UTF-16 ranges.
- `src/scripts/`: visual editing, previews, search and navigation.
- `catalogue/`: classification/collections/navigation; see its [README](catalogue/README.md).

[GitHub Actions](.github/workflows/pages.yml) builds/publishes `main` and refreshes guides nightly. `SITE_URL` and `BASE_PATH` repository variables select the destination. The workflow explicitly sets `PUBLIC_AUTHENTICATION`, `PUBLIC_AUTHENTICATED_EDITING` and `PUBLIC_GUIDE_SUBMISSION` to `true`; application/local defaults remain closed. Changing these values takes effect on the next build. Release preparation is local until the owner approves the commit/push.
