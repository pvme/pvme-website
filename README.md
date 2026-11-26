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

**Public authentication, authenticated editing and submission are all disabled by default.** Production requires `PUBLIC_AUTHENTICATION=true` to show the account menu or restore sessions, `PUBLIC_AUTHENTICATED_EDITING=true` to initialise authenticated editing, and `PUBLIC_GUIDE_SUBMISSION=true` to connect submission. Editing depends on authentication; submission depends on both. Only the exact value `true` enables a switch. Keep all three closed until genuine OAuth, the security follow-up and the backend safeguards below are reviewed. The external Guide Editor remains available. These are build-time release controls; the backend enforces authorization.

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

The exact UTF-8 source hash must match the immutable rendered map. Changed master/review text blocks inline editing without rebasing: retain/export the draft and open Guide Editor, or wait for a site rebuild. Reloading a static page alone does not update its maps.

With submission enabled, **Submit for review** refetches that source, preserves `EditSession.prepareUpdate` identity/fingerprint checks, revalidates the contributor immediately before POST and sends exact `originalContent` and complete edited `content` with `sourcePreservation: 'exact'`. Title limit: 120 characters; reason: 2,000; each source: 2 MiB of UTF-8 text. Pending requests prevent duplicates. **Export update JSON** remains available for recovery even when fresh source loading fails. With submission disabled, the established export-only review action remains functional.

A loaded review uses its returned contributor branch to update the PR. Loading master with an existing review displays its PR link and requires a replacement checkbox. Consent binds the account, source fingerprint, source kind, branch and known PR metadata. Source edits, identity changes and failed submissions clear it; rechecked metadata must match. Only an explicitly confirmed master operation sets `replaceExistingReview: true`. Recovery exports never grant replacement consent. Returned branch names are retained, not reconstructed by the website.

Real success distinguishes new PR creation from updating an existing PR, shows the returned link and disables repeat submission of that exact edit. **Return to guide** is the deliberate completion action: it retires only the captured identity/path/source/draft revision and restores published reading without a PR preview. Newer edits and other accounts' drafts remain. Retirement uses a revision-specific marker instead of deleting the shared draft head, so an interleaving cross-tab save cannot be erased by compare-then-delete. Retired source bytes may remain in storage but are no longer offered as active drafts; there is no broad storage cleanup.

Dry-run success clearly says no PR was created or updated and retains the draft. Draft namespaces use stable `github:<githubId>` or `discord:<discordId>`, with source/hash/branch metadata. Logout, expiry, OAuth and account changes retain the previous namespace. Account changes remove private canvases/previews before switching; reopen editing after logging back in to recover. Authenticated drafts are not painted automatically into the reading page. Existing development keys and older compatible drafts remain supported.

Finish or cancel unapplied source/property inputs before OAuth navigation. Storage failures retain a contributor-isolated recovery copy in tab memory, including after forced suspension, but cannot make it durable across page navigation: export before leaving if storage is unavailable.

## Failure recovery and backend requirements

401 asks the same contributor to sign in again. Permission/scope 403s require session refresh or re-authentication; only the documented `login session could not be verified` 403 gets one CSRF refresh/retry, with the original identity still required. Missing resources (404) offer reload/Guide Editor. Conflicts (409 and `SOURCE_CONFLICT`) require inspection/reload and retain immutable source. `FORK_SYNC_REQUIRED` directs the contributor to GitHub's **Sync fork → Update branch**, resolving workflow conflicts before retrying. Oversize sources (413) require reducing/exporting the draft; 429 asks the contributor to wait.

Network errors, malformed success responses, proxy failures and server/provider failures may represent uncertain publication. Inspect or reload the contribution in Guide Editor before manually retrying. There is no automatic rebase, merge, overwrite, arbitrary-error retry or background submission. Every failure/uncertain outcome retains the draft. Public-user responses are validated and allowlisted; tokens and unexpected fields are discarded. Submission results validate path, source/branch constraints, real PR URL and result shape; dry-run results separately validate byte counts and public identity. Invalid results never trigger cleanup. API requests are credentialed and uncached.

Two backend safeguards remain outside this repository's scope:

- **Atomic contributor assertion:** `/auth/me` revalidation and POST are separate requests. Cookies can change across tabs or Guide Editor in between. Explicit nonempty CSRF normally rejects another login's cookie, but frontend identity checks are not an atomic server-side identity guarantee. The backend reads the session at submission start; `GuideUpdate` does not require the contributor identity the website expected, and real success does not return it. Require an expected provider/contributor ID and compare it with the same session used for authorization/writes, preserve it on retries, and return it in validated results. Do not claim frontend revalidation eliminates the race.
- **Immutable replacement consent:** `/guides/load` exposes branch/PR URL, not a review-head commit or immutable review version. Submission captures the current open PR/head after the request begins; master replacement checks master text and boolean consent, not the head seen when consent was given. An update completed before that capture can therefore be replaced even if it happened after consent. Existing non-force publication protects against competing changes after the captured head; branch-name checks alone do not protect the earlier window. Extend load/submission with expected review-head commit and PR identity/version, reject stale consent, and retain non-force publication against that expected head. Reloading must require fresh consent.

These safeguards, genuine OAuth/browser checks and the historical security follow-up block public submission release. Backend idempotency/result lookup would also improve recovery after uncertain outcomes. Current duplicate prevention covers overlapping and repeated confirmed edits in the active workflow, not cross-device submissions or server transactions. Git object and PR metadata updates remain non-transactional as described in the integration contract. No backend or parser repository was modified.

## Checks and local browser fixture

```sh
npm run verify
npx tsx scripts/audit-source-maps.ts
npx tsx scripts/audit-page-canvas.ts
```

`verify` builds the catalogue/site, checks types, and runs website/catalogue tests. Site tests inspect `dist/`, so rebuild after route/template/asset changes. Focused tests cover source preservation, auth/CSRF, runtime validation, account/source choice, replacement, duplicate prevention, all recovery states, successful draft lifecycle, newer/cross-tab drafts, dry-run and release switches. No credentials are needed.

For native browser QA, build once, enable the local editing/submission switches and run `node tests/fixtures/guide-api-mock.mjs` on an unused localhost:8080. It returns synthetic contributors and PR results and never contacts GitHub. Visit port 8080 directly for `/__test?identity=99&review=1&scenario=dry-run`. Controls: `identity=anonymous` simulates expiry; `review=0` removes review metadata; `stale=1` changes review text; `reset=1` clears synthetic submitted text/counters. Scenarios `success`, `delay`, `conflict`, `fork`, `network` and `server` exercise the matching states. The control returns a submission count. Do not run it alongside the actual backend; stop QA servers afterwards. These controls are only in the fixture, not the website or real backend.

The actual local Cloud Function test starts the adjacent Functions Framework on an ephemeral port with isolated DRY_RUN configuration, a test-only encrypted session and all external fetches forbidden. It checks the website session/CSRF/exact payload and validation response contract; it skips explicitly if adjacent backend dependencies are unavailable. It does **not** verify real OAuth, GitHub writes, existing PR discovery or production freshness. Mocked live-mode lifecycle tests and browser checks verify frontend states separately.

## Source-map findings and verification history

The three DPM failures were website renderer/provenance defects. The parser correctly retains `> ` inside Discord-style headings; the renderer intentionally strips it for presentation but previously annotated its original value as visible editable text. Inline mapping now requires the displayed text to equal the parser leaf. Plain quote-prefixed headings retain whole-line editing through explicit heading-offset provenance and the existing prefix-preserving line model. Hidden quote markers never become editable text. Canonical guides, parser output and the audit remain unchanged. Regression tests cover all three actual DPM guides, ordinary blockquotes, DOM equivalence and existing heading/link editing.

Phase 4 baseline verification passed 181 website and four catalogue tests; its final record passed 202 website and four catalogue tests with no type errors. It checked flag-off/on builds, uncached session restoration, contributor isolation, stale review fallback and logout in native Chrome. Its source-map audit had three failures in `dpm-advice/dpm-advice-mage.txt`, `dpm-advice/dpm-advice-necro.txt` and `dpm-advice/dpm-advice-range.txt`, all `Displayed value differs: '' !== '> '`. Its page-canvas audit passed 612 guides, 33,189 blocks and 1,339 edited embeds; two duplicate-JSON-property guides remained advanced-editor-only.

Phase 5 native Chrome checks confirmed a synthetic new-PR result/link, disabled duplicate action, completion restoring published reading without the submitted heading, explicit existing-review/live-source selection, refusal without replacement consent, explicit consent with dry-run feedback and uncertain upstream failure with recovery guidance. The mock recorded exactly three POSTs: success, dry-run and simulated network failure; the refused replacement sent no POST. No real PR URL was opened or real submission sent. QA servers were stopped afterwards.

Final Phase 5 verification on 26 November 2026 passed `npm run verify`: **224 website tests and four catalogue tests**, no type errors. The actual local Cloud Function dry-run test ran successfully as part of that suite. The unchanged source-map audit passed **all 612 guides**, verifying 68,642 text mappings, 592 link labels and 770 URLs with zero invalid guides. The page-canvas audit also passed all 612 guides, retaining its two existing advanced-only duplicate-property cases. Production builds with switches closed and fully enabled under `/pvme-website/` passed asset/flag checks; proxy secrets/headers, localhost backend code, mock identities and dev-session completion were absent. The closed build remains in `dist/`; the enabled verification artifact is ignored under `.local/phase5-enabled-dist/`. `git diff --check` passed. No deployment, commit, push, production credential retrieval, real PR or GitHub write was performed.

## Phase 6 end-to-end testing and release checklist

- Keep all production switches false while reviewing the website, backend atomic contributor assertion and immutable review-head consent. Resolve the historical security follow-up with the responsible operators: determine whether old `/auth/me` token exposure affected deployed GitHub sessions and arrange grant revocation, session-secret rotation and cache/log review as appropriate. No production credentials, sessions or configuration were inspected here.
- Register isolated development OAuth apps and test genuine Discord/GitHub login, cancel/error, nonce/state expiry, handoff, logout and cookie/privacy behavior on localhost:4321 and the existing 5173 frontend. Check path/query/fragment preservation at root and staging base paths, then shared sessions at approved staging/production origins without publicly enabling editing.
- Repeat actual local backend verification with DRY_RUN and safely configured development authentication. Confirm no write calls; keep dry-run evidence separate from PR lifecycle evidence.
- With separate explicit authorization in a disposable repository/backend environment, verify real new PRs, existing updates, replacement with stale-head rejection, fork/workflow conflicts, concurrent editors, session switching during POST, network loss after publication and newer draft preservation. No GitHub writes are authorized or performed in Phase 5.
- Check pending/failure/dry-run/success/recovery on desktop/mobile and supported themes, including keyboard focus, long contributor names/avatars and unavailable storage.
- Run verify and both audits; build closed, auth-only, editing-enabled and fully enabled configurations into isolated artifacts. Inspect bundles for secrets, local proxy code and development-session completion.
- Obtain explicit deployment/release authorization after those checks. Review enabling authentication, editing and submission separately. Monitor conflicts/errors and retain the ability to close each switch. Do not deploy or enable public editing during local review.

## Project structure and deployment

- `src/components/`: shared shell, account UI, editor and review controls.
- `src/lib/guide-api.ts`, `submission-contract.ts`, `guide-submission.ts`: typed validated API, orchestration and lifecycle.
- `src/lib/authenticated-source.ts`, `release-flags.ts`: selected-source revalidation and release switches.
- `scripts/guide-api-proxy.mjs`: server-only fixed localhost proxy before Astro base guards.
- `src/lib/edit-session.ts`, `draft-storage.ts`: immutable sources, exact updates and contributor drafts.
- `src/lib/renderer.ts`, `source-map.ts`, `source-lines.ts`: rendering and parser-owned UTF-16 ranges.
- `src/scripts/`: visual editing, previews, search and navigation.
- `catalogue/`: classification/collections/navigation; see its [README](catalogue/README.md).

[GitHub Actions](.github/workflows/pages.yml) builds/publishes `main` and refreshes guides nightly. `SITE_URL` and `BASE_PATH` repository variables select the destination. Release switches require explicitly reviewed build configuration and default closed. No deployment is needed for local review.
