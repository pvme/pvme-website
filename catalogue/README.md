# PvME Guide Catalogue

Builds the website's guide index and provides a local editor for names, categories and combat styles. Follow the [website setup](../README.md), then run commands from the repository root:

```sh
npm run catalogue       # rebuild the index
npm run catalogue:dev   # open the editor at http://127.0.0.1:5173
npm run catalogue:test  # run catalogue tests
```

## Configure collections and navigation

Edit [collections.json](collections.json). Keep `schemaVersion: 1`; the three main sections are `collections`, `cardGroups` and `navigation`.

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
