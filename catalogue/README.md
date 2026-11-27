# PvME Guide Catalogue

The catalogue connects source guides to website pages. It detects subjects,
methods and styles, applies website overrides, and exports the index consumed by
Astro. Follow the [website setup](../README.md), then run commands from the
**website root**:

```sh
npm run catalogue       # rebuild the index
npm run catalogue:dev   # open the editor at http://127.0.0.1:5173
npm run catalogue:test  # run catalogue tests
```

Generated data lives in `catalogue/public/data/`; do not edit it directly.
After changing guide files or configuration, run `npm run catalogue` and restart
the website dev server so routes and page labels refresh.

## Choose the right configuration

| File                                           | Purpose                                                             |
| ---------------------------------------------- | ------------------------------------------------------------------- |
| [boss-party-types.json](boss-party-types.json) | Explicit Solo/Group filters for boss cards                          |
| [collections.json](collections.json)           | Groups of guides, directory rows, tabs and destinations             |
| [overrides.json](overrides.json)               | Website-only guide names, categories, styles and method corrections |
| [src/subjects.ts](src/subjects.ts)             | Canonical encounter identities and shortened boss slugs             |

The inspector shows detection results and offers corrections. Catalogue overrides
leave guide text unchanged. Its source-editing operations can also modify files
in your local `GUIDES_DIR`; review the selected target and preview before applying.

## Set boss party types

Boss directory Solo/Group filters are configured separately in
[boss-party-types.json](boss-party-types.json), keyed by the boss URL slug.
Set each value to `"solo"`, `"group"`, or `"both"`. `null` means unassigned:
the card remains visible without a party classification. Collection cards have
their own entries. No party type is inferred from guide titles, filenames,
method headings or collection members.
Tests check that all current boss cards have a JSON entry; use `null` for new
entries until their classification is decided.

## Change a website label

Merge an entry under `files` in `overrides.json`, keyed by source path. Keep the
other entries. For example:

```json
{
  "schemaVersion": 1,
  "files": {
    "rs3-full-boss-guides/fight-kiln.txt": {
      "fields": {
        "title": "Fight Kiln",
        "subject": "Fight Kiln"
      }
    }
  }
}
```

`title` names the guide; `subject` names its boss or creature. These do not rewrite
the source heading. If changing a boss slug, also update its party-type key and
matching artwork filename in `src/assets/bosses/`, and check generated links.

## Configure collections and navigation

Edit `collections.json`. Keep `schemaVersion: 1`; the three main sections are
`collections`, `cardGroups` and `navigation`.

A collection creates a page beneath its `parent`:

```json
{
  "parent": "/bosses/",
  "subjectId": "god-wars-dungeon-2",
  "title": "God Wars Dungeon 2",
  "aliases": ["GWD2"],
  "icon": "bosses",
  "description": "Guides for the bosses in God Wars Dungeon 2",
  "members": [
    { "subjectId": "helwyr", "name": "Helwyr" },
    { "subjectId": "telos", "name": "Telos" }
  ]
}
```

This creates `/bosses/god-wars-dungeon-2/`. Use existing subject IDs for bosses or creatures. Members can instead link to a website with `href`, or a guide with `guidePath` and an optional `heading`.

Other collection options:

- `guideCategories` or `guidePaths`: include guides by category or repository-relative path.
- `guideOrder`: list the guide paths to show first; the rest remain alphabetical.
- `sourcePath`: include a shared guide; a member's `sharedGuideTitle` also exposes it on that member's page.
- `parentLabel`, `searchable`, `featuredStyles`: customize the parent link, add search or show style upgrade cards.
- `catchAll`: collect remaining guides under the parent; use it without explicit members or guide selections.

Empty collections stay hidden. Resource groups follow configuration order; boss and Slayer collections sort alphabetically.

`cardGroups` arranges directory cards into rows. Each row identifies a `parent` and either `cards` (ordered card IDs), `collection` (members of a collection), or `remaining: true`. Optional `heading` and `columns` control the presentation. Unlisted cards remain visible below the configured rows.

`navigation` configures guide tabs and destinations:

- `bossTabs` / `slayerTabs`: labels, icons and `mode` (`pages` or `methods`). `dropdown` keeps choices in a menu; `showStyles` controls combat-style icons.
- `overview` and `tabRules`: default guide placement. `guides` overrides individual repository-relative paths with `tabs` or `preferredTab`.
- `routes`: standalone guide types and the URL segment for shared collection guides.

The existing JSON entries are working examples; [collection definitions](src/collection-definitions.ts) and [navigation definitions](src/navigation-definitions.ts) describe the supported settings. Run `npm run verify` from the root before sharing changes.

## Change detection rules

Start with `src/detect.ts` and `src/rules.ts` for method/style detection, or
`src/subjects.ts` for encounter grouping. Detection results are cached. Bump
`RULES_VERSION` in `src/rules.ts` when changing detection rules; use
`npm run catalogue -- --force` to bypass the cache while developing.
