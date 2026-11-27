# PvME Website

An Astro site for RuneScape 3 boss guides, Slayer methods, resources and tools.
Guide content lives in [pvme-guides](https://github.com/pvme/pvme-guides); this
repository turns it into searchable pages and provides the website editor.

## Start developing

Use **Node.js 24**. Clone `pvme-guides` beside this checkout:

```text
Dev/
  pvme-website/
  pvme-guides/
```

Run from `pvme-website`:

```sh
npm ci
npm run dev
```

Open **http://localhost:4321**. The dev server requires that port. Use `localhost`
consistently for authentication; `127.0.0.1` has a different origin and cookies.
The parser is installed by npm; no adjacent parser checkout is required.

For another guide location, copy [.env.example](.env.example) to `.env` and set
`GUIDES_DIR`. Restart the dev server after environment or catalogue changes,
especially changes to generated routes or page names.

## How the site works

1. The catalogue reads guide files and detects subjects, methods and combat styles.
   Website configuration supplies collections, navigation and editorial overrides.
2. `@pvme/guide-parser` parses the guide syntax. The website renderer turns that
   output into HTML and source maps for inline editing.
3. Astro builds static pages, search data and preset previews into `dist/`.
   Browser scripts handle filters, navigation and editing.
4. Authenticated editing loads fresh source from the shared Guide Editor API.
   Submission uses its strict v2 API; GitHub writes happen in that backend.

`npm run dev` and `npm run build` prepare the catalogue and preset previews
automatically. Generated files in `catalogue/public/data/`, `public/preset-previews/`
and `dist/` are ignored; edit their inputs instead.

## Where to make changes

| Change                                              | Start here                                                                        |
| --------------------------------------------------- | --------------------------------------------------------------------------------- |
| Pages and layouts                                   | `src/pages/`, `src/layouts/`                                                      |
| Shared UI and appearance                            | `src/components/`, `src/styles/`                                                  |
| Search, filters and browser interactions            | `src/scripts/`                                                                    |
| Guide rendering and source mapping                  | `src/lib/renderer.ts`, `src/lib/source-map.ts`                                    |
| Inline editor and diagnostics                       | `src/scripts/page-canvas-editor.ts`, `src/lib/guide-validation.ts`                |
| Auth, submissions and drafts                        | `src/lib/guide-api.ts`, `src/lib/guide-submission.ts`, `src/lib/draft-storage.ts` |
| Boss/Slayer groups, tabs, names and classifications | [Catalogue configuration](catalogue/README.md)                                    |
| Card and page header images                         | `src/assets/bosses/`, `src/assets/slayer/`                                        |

Boss artwork filenames match the boss URL slug, for example `ivar.webp`.
Existing boss images use 1200 × 675 WebP files. Solo/Group classifications are
explicit in [boss-party-types.json](catalogue/boss-party-types.json), independent
of guide titles or which guides are available.

For content changes, edit the appropriate guide in your local `pvme-guides`
checkout, then regenerate the catalogue and restart the site. Website-only names
and classifications belong in catalogue configuration. Keep changes to these
repositories separate when reviewing and committing.

## Commands and checks

| Command                 | Purpose                                                          |
| ----------------------- | ---------------------------------------------------------------- |
| `npm run dev`           | Prepare data and start the development server                    |
| `npm run build`         | Prepare data, check types and build `dist/`                      |
| `npm run preview`       | Serve the built static site                                      |
| `npm test`              | Run website tests; tests that inspect pages need a current build |
| `npm run verify`        | Build, then run website and catalogue tests                      |
| `npm run catalogue`     | Regenerate catalogue data after guide/configuration changes      |
| `npm run catalogue:dev` | Open the catalogue inspector/editor                              |
| `npm run format`        | Format website source, tests and the main README                 |

Run `npm run verify` before sharing changes. When changing rendering or editing,
also run the full guide audits:

```sh
npx tsx scripts/audit-source-maps.ts
npx tsx scripts/audit-page-canvas.ts
git diff --check
```

These audits check source mapping and editing against the local guide corpus.
Tests use synthetic API responses and do not require OAuth or real GitHub writes.
The optional adjacent-backend test skips if its dependencies are unavailable.

## Editing, authentication and release

Development supports local editing through **Edit Page → Edit (in place)**.
For authenticated editing, mocked submission, recovery behavior and API
constraints, see [Editor development](docs/editor-development.md).

Production authentication, authenticated editing and submission each have a
build-time switch. Application defaults are closed; the
[Pages workflow](.github/workflows/pages.yml) explicitly enables all three.
Changing a switch requires rebuilding. See the editor guide for verification
commands before changing these settings.

The workflow builds and tests on pushes to `main`, manual runs and the daily
schedule, then deploys `dist/` to GitHub Pages with fresh guide content.
`SITE_URL` and `BASE_PATH` repository variables set the public origin and path.
Local builds do not deploy anything.
