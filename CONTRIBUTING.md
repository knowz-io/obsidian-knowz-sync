# Contributing to Knowz Sync

Thanks for taking an interest. Bug reports and pull requests are both welcome.

## Reporting a bug

Open a [GitHub issue](https://github.com/knowz-io/obsidian-knowz-sync/issues) and include:

- your Obsidian version and platform (desktop or mobile), and the plugin version;
- what you expected to happen and what happened instead;
- anything the console printed (**Ctrl/Cmd + Shift + I** → Console).

**Never paste your API key, your vault ID, or the contents of
`.obsidian/plugins/knowz-sync/data.json` into an issue.** If a report needs one of those to
make sense, say so and we will find another way.

## Getting set up

```bash
npm install
npm test          # the suite
npm run typecheck # tsc --noEmit
npm run build     # production bundle -> main.js
npm run dev       # rebuild on change, with an inline sourcemap
```

To try a change in a real vault, build and copy `main.js` and `manifest.json` into
`<vault>/.obsidian/plugins/knowz-sync/`, then reload Obsidian. Use a scratch vault rather than
one you care about — the plugin uploads notes.

## Before you open a pull request

All four must pass, because CI runs them and the community directory's automated scanner reads
the shipped `main.js`:

1. `npm run typecheck`
2. `npm test`
3. `npm run build`
4. The Hygiene workflow — no real hostnames, GUIDs, email addresses, or credentials anywhere in
   the tree. Use `https://api.example.test` and `00000000-0000-0000-0000-00000000000N` in
   fixtures.

Please also:

- **Add a test.** Every behaviour here is covered, and the sync logic is the kind that fails
  quietly and destructively. A test that still passes when you revert your change is not
  covering it.
- **Say why in a comment,** not what. The existing comments explain the reasoning behind
  non-obvious choices, and several of them exist because someone previously "fixed" the code
  back into a bug.
- **Keep `minAppVersion` honest.** Raise it only when the code genuinely uses a newer Obsidian
  API. The directory rejects a release that calls an API newer than the declared floor, and a
  runtime fallback does not satisfy that rule.

## Changes that affect what leaves the vault

If your change alters what is transmitted, where it goes, or what is stored, it **must** update
the Disclosures section of the README in the same pull request. That section is a requirement of
Obsidian's developer policy, not documentation courtesy, and the plugin is re-scanned on every
release.

## Releasing

Maintainers only. Bump `manifest.json`, `package.json`, and `versions.json` together, tag
`x.y.z` with no `v` prefix, and push — the Release workflow builds and attaches `main.js` and
`manifest.json`. Never move a tag that has already been published.

## License

Contributions are accepted under the [MIT License](LICENSE).
