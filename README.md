# PvME Website

RuneScape 3 PvM guides, Slayer methods, resources and tools.

## Setup

Use Node.js 24 and clone [pvme-guides](https://github.com/pvme/pvme-guides) beside this repository. For another location, set `GUIDES_DIR` in `.env`; see [.env.example](.env.example).

```sh
npm ci
```

This branch currently needs the local parser build with editing APIs. After installing dependencies, install its tarball without changing the manifest or lockfile:

```sh
npm install --no-save --package-lock=false --cache .npm-cache --offline --no-audit --no-fund ../pvme-guide-parser/pvme-guide-parser-0.4.2.tgz
npm run dev
```

Open http://127.0.0.1:4321. The site reloads when files change. Keep the parser tarball installed when rebuilding or testing; `npm ci` replaces it.

## Inline editing

Inline editing is available but is UI-only for now (not hooked up to API/Github PRs yet). Run `npm run dev` locally, then choose **Edit Page → Edit (in place)**. Click a message to edit its text, headings and nested bullets together, or switch to source editing. Embeds and media have contextual controls; insertion rows add new content. Drafts save locally and restore when the source revision still matches.

The toolbar provides undo/redo, confirmed discard, Done and Submit changes. Review highlights individual source edits and lets you discard them separately. **Submit for review currently downloads a validated update JSON file; it does not publish a change or create a pull request.**

Builds include read-only source JSON for published catalogue guides, matching the source revision used to render each page. Editing never writes to the canonical guide files.

## Checks

```sh
npm run verify
```

This builds the catalogue and website, checks types, and runs the website and catalogue tests. Use it before opening a pull request.

For a quick rerun after a successful build:

```sh
npm test
npm run catalogue:test
```

Site tests inspect `dist/`, so rebuild after changing routes, templates or production assets. Run a single test file with `npx tsx --test tests/source-lines.test.ts`.

Tests are grouped by behavior: source mapping and editing, drafts and review, canvas interactions, search/navigation, and built-site links. Shared fixtures and DOM helpers live in [tests/helpers.ts](tests/helpers.ts). Keep assertions about observable behavior and source preservation; avoid copying layout implementation into tests.

Optional, read-only audits of all guides:

```sh
npx tsx scripts/audit-source-maps.ts
npx tsx scripts/audit-page-canvas.ts
```

## Project structure

- `src/layouts/`: homepage, directory and guide layouts, sharing `SiteShell`.
- `src/lib/renderer.ts`: guide rendering and source-map generation.
- `src/lib/edit-session.ts`: validated edits, immutable source snapshots and update preparation.
- `src/lib/source-lines.ts`, `page-canvas.ts`, `json-source.ts`: text, section and embed edits.
- `src/scripts/`: browser editing, previews, search and navigation.
- `catalogue/`: guide classification, collections and navigation settings. See its [README](catalogue/README.md).

Source maps use parser-owned UTF-16 ranges against the exact original source. Sessions verify its SHA-256 fingerprint before applying edits, and rejected edits leave the previous draft intact. Source formatting, line endings, protected references and unrelated content must survive round trips.

## Deployment

[GitHub Actions](.github/workflows/pages.yml) builds and publishes `main`, and refreshes guides nightly. Configure GitHub Pages to use **GitHub Actions**. Repository variables `SITE_URL` and `BASE_PATH` control the destination; the workflow defaults to https://pvme.github.io/pvme-website/.
