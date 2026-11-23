# PvME Website

A website for RuneScape 3 PvM guides, Slayer methods, resources and tools.

## Contribute

Install Node.js 24. Download [pvme-guides](https://github.com/pvme/pvme-guides) into a folder named `pvme-guides` beside this project's folder. If you keep it elsewhere, put its folder location in `.env` as `GUIDES_DIR=your-folder-location`.

In this project's folder, run:

```sh
npm ci
npm run dev
```

Open http://127.0.0.1:4321 to see the website. It updates as you save changes.

Before sharing your changes, run `npm run verify` to build the website and run all checks. Then send a pull request on GitHub so the team can review them.

GitHub Actions publishes pushes to `main` at https://pvme.github.io/pvme-website/ and refreshes the guides nightly. In the repository's Pages settings, choose **GitHub Actions** as the source. To move to pvme.io later, set repository variables `SITE_URL=https://pvme.io` and `BASE_PATH=/`, then configure the custom domain and DNS before running the workflow again.
