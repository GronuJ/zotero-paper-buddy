# Contributing

Thanks for helping. Bug reports, ideas and pull requests are all welcome.

## Reporting bugs and ideas

Open an [issue](https://github.com/GronuJ/zotero-paper-buddy/issues). For bugs, include your Zotero version, the plugin version, your provider and model, and any other plugins that change the PDF reader. Remove API keys from anything you paste.

## Project layout

```
addon/                  Everything that ships in the .xpi
  manifest.json         Plugin ID, version, supported Zotero versions, update URL
  bootstrap.js          Zotero startup and shutdown hooks
  prefs.js              Default settings
  content/buddy.js      All plugin logic: sidebar panel, popup, API calls, notes
  content/panel.css     Panel styles
  content/prefs.xhtml   Settings pane
  content/prefs-pane.js Settings pane logic
  locale/en-US/         Fluent strings
scripts/build.mjs       Builds the .xpi and update.json into build/
```

The plugin is plain JavaScript with no dependencies and no bundler.

## Development setup

You need Zotero 7 or later, Node.js 18 or later, and `zip`.

1. Clone the repository.
2. Build the plugin:
   ```
   npm run build
   ```
   This writes `build/zotero-paper-buddy-<version>.xpi`.
3. Install that file in Zotero through **Tools › Plugins › gear icon › Install Plugin From File…**.
4. After changing code, build again, install over the old version and restart Zotero. Open PDF tabs keep old popup styles until Zotero restarts.

Tips for faster iteration:

- Use a separate Zotero profile for testing (start Zotero with `-P`), so you don't mix test annotations into your library.
- Plugin errors are logged to **Help › Debug Output Logging** and the Error Console.
- **Tools › Developer › Run JavaScript** lets you inspect `Zotero.ClaudePaperBuddy` while Zotero is running.

## Pull requests

1. Fork the repository and create a branch from `main`.
2. Keep each pull request to one change, and describe what you tested in Zotero (version, provider, what you clicked).
3. Run `npm run check` before pushing. CI runs the same check and a build on every pull request.
4. Don't change the version in `addon/manifest.json`. That happens when a release is made.

Please match the existing code style: tabs for indentation, double quotes, and short comments only where the code isn't obvious.

## Releasing (maintainers)

Every release is delivered to all users automatically. Installed copies check the `update_url` in `addon/manifest.json`, which points at the `update.json` attached to the latest GitHub release.

1. Bump `version` in `addon/manifest.json`, for example to `0.6.1`, and commit it to `main`.
2. Tag and push:
   ```
   git tag v0.6.1
   git push origin v0.6.1
   ```
3. The Release workflow checks that the tag matches the manifest, builds the `.xpi` and `update.json`, and publishes them as a GitHub release.

Zotero installs the update within about a day, or right away through **Tools › Plugins › gear icon › Check for Updates**.

Never change the plugin ID in `manifest.json`. Zotero uses it to match updates to installed copies.
