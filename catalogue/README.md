# PvME Guide Catalogue

Builds the website's list of guides. Includes an editor for checking guide names, categories and combat styles.

Edit [collections.json](collections.json) to group guides and links into pages, choose their tabs and change where guide links open.

## collections.json

Leave `schemaVersion` set to `1`. Put groups in `collections`, card rows in `cardGroups` and tab/link settings in `navigation`.

Each group works the same way. Add a group to the `collections` list, for example:

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

This creates `/bosses/god-wars-dungeon-2/`:

- `parent` says which page the group sits under. It can also be `/slayer/`, `/resources/`, `/tools/` or another page.
- `subjectId` sets the last part of the group's web address. Inside `members`, it identifies an existing boss or creature under that page; use its existing ID.
- `title`, `description` and `icon` control how the group looks. `aliases` adds alternative names for search.
- Optional `parentLabel` changes the name shown in the link back to the parent page.

You can also group guides by category and add links. These options work under any parent page:

```json
{
  "parent": "/resources/",
  "subjectId": "dpm-advice",
  "title": "DPM Advice",
  "icon": "chart",
  "description": "Damage output guidance and style-specific advice",
  "guideCategories": ["DPM Advice"],
  "members": [
    { "name": "Rotation Builder", "href": "https://pvme.io/rotation-builder/" }
  ],
  "searchable": true
}
```

Other options:

- `guidePaths`: include particular guide files, using their locations inside `pvme-guides`.
- `guideOrder`: put particular files first, in the order listed. For example, `"guideOrder": ["dpm-advice/dpm-advice-faq.txt"]`. Other guides stay alphabetical.
- `sourcePath`: add a shared guide, such as `afk/afk-gwd1.txt`. Set a member's `sharedGuideTitle` to show that guide on the member's own page too.
- `members`: use `href` for a website link instead of `subjectId`. You can also add a short `description` and an `id` to identify the link.
- To link to a guide, use `"guidePath": "basic-guides/ed2-basic.txt"` instead of `subjectId` or `href`. Add `"heading": "Black Stone Dragon (Info)"` to jump to that heading. Links follow the guide's current web address automatically.
- `searchable: true`: add a search box for the group.
- `featuredStyles: true`: show style upgrade orders as cards above the other guides.
- `catchAll: true`: collect guides not already in another group under that parent. Use this on its own, without other choices of guides or members. For custom parent pages, it considers all guides.

Empty groups stay hidden. Resource groups and tabs appear in the order listed; boss and Slayer groups appear alphabetically.

To separate cards into rows, add settings to `cardGroups`. For example:

```json
[
  { "parent": "/resources/", "label": "Other", "remaining": true },
  {
    "parent": "/resources/",
    "label": "Combat styles",
    "heading": "Combat styles",
    "cards": ["style-necromancy", "style-magic", "style-ranged", "style-melee"],
    "columns": 4
  }
]
```

`cards` lists card IDs in display order. `remaining: true` collects every card not named in another row. `heading` adds a visible title; `columns` sets the desktop row width (smaller screens use fewer columns). A single row of named cards appears above the remaining cards. With several named rows, the rows follow the order listed. Cards left out of the settings still appear below them.

To show a collection's members as cards under a heading, use `"collection": "player-tools"` instead of `cards`. Tools uses this for its player and contributor groups; adding a tool to the collection automatically adds its card to the right group.

Tab and link settings go in `navigation`:

- `bossTabs` / `slayerTabs`: choose the tabs and their names and icons. Use `mode: "pages"` to list whole guides, or `mode: "methods"` to list their methods.
- `dropdown: true` keeps a tab's choices in a dropdown even when there is only one; `showStyles: false` hides its combat-style icons.
- `overview`: choose which guides appear as overviews. `tabRules`: put guides into tabs based on their folder, guide type or whether they contain methods.
- `guides`: make an exception for one file. Its `tabs` setting takes priority over the usual rules. For example, inside `navigation.guides`:

  ```json
  {
    "rs3-full-boss-guides/telos/p5-movement-and-timing.txt": {
      "tabs": ["boss-mechanics"]
    }
  }
  ```

- `preferredTab` chooses which tab a guide's links open.
- `routes`: choose which guide types have their own pages (`standaloneTypes`), and the word used before shared guide names in web addresses (`collectionGuideSegment`).

## Contribute

Follow the [website setup](../README.md), then run these commands in the main project folder:

```sh
npm ci
npm run catalogue:dev
```

Open http://127.0.0.1:5173 to use the editor. Make your changes and run `npm run catalogue:test` to check they work. Then send a pull request on GitHub for the team to review.
