# Knowz Sync for Obsidian

Your vault is already the best record of what you know. This connects it to
[Knowz](https://knowz.io) and turns it into something you can *ask*.

Sign in, and your notes become a retrieval system: chunked and embedded into a vector store,
searchable by meaning rather than keyword, traversable as a graph that inherits your
`[[wikilinks]]`, and reachable by AI agents that answer from your own writing instead of
guessing. The same corpus powers enterprise AI chat, so a team can ask questions of everything
it has collectively written.

Obsidian stays the source of truth. Nothing about how you write changes — Knowz becomes the
intelligence layer on top of it.

## What you get with a Knowz account

- **Semantic search.** Find the note you meant, not the one that happened to share a word.
- **Vector embeddings and chunking.** Long notes are split intelligently, so retrieval returns
  the passage that answers the question rather than a whole document.
- **Agentic retrieval.** Agents plan multi-step lookups across your corpus and cite what they
  used.
- **A knowledge graph.** Your wikilinks become real relationships, so connected ideas surface
  together.
- **AI chat over your notes**, individually or across a team, with enterprise controls.
- **AI enrichment.** Summaries and extracted entities generated as notes arrive.

These are Knowz platform capabilities and need a Knowz account. What this plugin does is put
your vault there and keep it current:

## What the plugin does

- **Syncs your Markdown notes** to a Knowz vault of your choosing.
- **Preserves your link graph.** Wikilinks are read from Obsidian's own resolved-link index —
  not scraped with regular expressions — so links resolve exactly the way Obsidian resolves
  them.
- **Keeps up as you write.** Create, edit, rename, and delete are picked up from vault events
  and pushed in a coalesced batch, so a burst of edits becomes one upload rather than fifty.
- **Titles notes the way you'd expect.** Front-matter `title` wins, then a leading H1, then
  the filename.
- **Stays out of the way.** Your Obsidian configuration folder, `.trash/`, and `.smart-env/`
  are excluded automatically,
  and note content is transmitted verbatim — no rewriting, no reformatting.

## Requirements

- Obsidian 1.13.0 or later, on desktop or mobile.
- A Knowz account. The plugin does nothing without one — see below.

## Getting a Knowz account

The plugin needs three things from Knowz: an **API base URL**, a **personal API key**, and a
**vault ID**. All three come from the Knowz web app, and it takes about two minutes.

**1. Create an account.** Sign up at [app.knowz.io/register](https://app.knowz.io/register), or
from [knowzai.com](https://knowzai.com). Confirm your email address, then sign in.

*Self-hosting Knowz instead?* Everything below is the same — do it in your own deployment's web
app, and set the plugin's **API base URL** to your own API instead of `https://api.knowz.io`.

**2. Create the vault you want to sync into.** Go to **Settings → Vaults** and create one, or
pick an existing vault. A Knowz vault is the destination collection; it is separate from your
Obsidian vault, and one Obsidian vault syncs into one Knowz vault.

**3. Copy the vault ID.** Still on **Settings → Vaults**, use the **copy vault ID** button on
that vault's row. It is a GUID — this is what goes in the plugin's **Vault ID** field.

**4. Create a personal API key.** Go to **Settings → API keys → Create API Key**:

- Choose **Personal (`ukz_`)**, *not* Workspace (`kz_`). Workspace keys are rejected by the
  sync endpoints, which need to know which user is writing — the request fails with "user
  identity could not be established".
- Give it a name you will recognise later, such as `Obsidian`.
- Set **Expiration (days)**. Do set one; the key is stored in your vault in plain text, so a
  key that expires limits the damage if a copy of the vault leaks. See
  [About your API key](#about-your-api-key).
- **Copy the key immediately.** It is shown once and cannot be retrieved afterwards. If you
  lose it, delete it and create another.

**5. Check that git sync is available on your plan.** The plugin uses the Knowz git-sync
endpoints (`integrations.enableGitSync`), which are tier-gated. If the feature is off for your
tenant, the plugin's first request returns HTTP 403 — upgrade the plan or ask your Knowz
administrator to enable it.

You now have all three values. Install the plugin, then paste them into its settings.

## Install

### From the Obsidian community directory

Open **Settings → Community plugins → Browse**, search for **Knowz Sync**, and install.

### Using BRAT

1. Install and enable the **BRAT** community plugin.
2. Choose **Add Beta plugin** and enter `knowz-io/obsidian-knowz-sync`.
3. Enable **Knowz Sync** under **Settings → Community plugins**.

### Manually

1. Download `main.js` and `manifest.json` from the
   [latest release](https://github.com/knowz-io/obsidian-knowz-sync/releases/latest).
2. Create `<vault>/.obsidian/plugins/knowz-sync/` and copy both files into it.
3. Restart Obsidian and enable **Knowz Sync** under **Settings → Community plugins**.

To build from source instead: `npm install && npm run build`.

## Setup

Open **Settings → Knowz Sync** and fill in the three values from
[Getting a Knowz account](#getting-a-knowz-account). The settings are also reachable by
searching Obsidian's settings for "Knowz", "API key", or "excluded paths".

| Setting | What it's for | Where it comes from |
|---------|---------------|---------------------|
| **API base URL** | Your Knowz environment, normally `https://api.knowz.io`. | Leave as-is unless you self-host. |
| **Personal API key** | An expiring `ukz_` key. | Knowz → Settings → API keys. |
| **Vault ID** | The GUID of the destination Knowz vault. | Knowz → Settings → Vaults → copy vault ID. |
| **Sync on startup** | Run a full sync each time Obsidian launches. Off by default. | Your choice. |
| **Excluded paths** | Folders and file patterns to keep out of Knowz. One per line. | See [Excluding notes](#excluding-notes). |

Then run a sync from the ribbon icon or the **Sync vault** command. Before the first
upload the plugin tells you how many notes it is about to send and where, and waits for you to
agree. Nothing leaves your vault until you do.

To see exactly what would be sent at any time, run **Preview which notes would sync**.

### Excluding notes

Your Obsidian configuration folder (normally `.obsidian/`, wherever you have it), `.trash/`,
and `.smart-env/` are excluded automatically. Add your own patterns
under **Excluded paths**, one per line:

| Pattern | Matches |
|---------|---------|
| `Journal/` | that folder and everything inside it |
| `*.private.md` | any file with that name pattern, in any folder |
| `Work/*/draft.md` | `draft.md` one folder below `Work/` |
| `Work/**/draft.md` | `draft.md` at any depth below `Work/` |
| `note-?.md` | `note-a.md`, but not `note-ab.md` |

Matching is case-insensitive, and lines beginning with `#` are treated as comments.

## How syncing behaves

**Obsidian is authoritative.** Edits and deletes made in the Knowz web client are overridden
by the next sync. A Knowz-side delete is undone by the next full sync — to remove something
permanently, delete the note in Obsidian.

**Full syncs repair drift.** A full sync compares your eligible notes against a fresh manifest
from Knowz, so anything left inconsistent by a previously failed push is corrected rather than
left behind.

Beyond that:

- The plugin registers your vault with Knowz once per session, idempotently, under the
  identifier `obsidian://<vault-name>`.
- Incremental changes are collected and pushed after a 15-second quiet period, so editing
  produces one upload rather than one per keystroke.
- A rename is sent as a rename, not as a delete plus a create, so the note keeps its identity
  and history on the Knowz side. Moving a note with Finder or `mv` is paired the same way,
  provided the delete and create land in the same debounce window.
- Empty and whitespace-only notes are not synced until they have content.
- A failed push is retried once after roughly two seconds. Local sync state only advances
  after the server confirms, so an interrupted sync resumes rather than silently skipping.
- A full sync that reads an empty vault while notes are already synced is refused outright,
  rather than interpreting it as "the user deleted everything."

## Disclosures

Obsidian asks plugin authors to state plainly how their plugin behaves. Here is ours.

**This plugin requires an account.** Knowz Sync does nothing without a Knowz account, a vault
ID, and a personal API key. There is no offline or local-only mode.

**This plugin uses the network.** It communicates with the Knowz API at the base URL you
configure — `https://api.knowz.io` by default, or your own Knowz deployment. It contacts no
other host, and it loads nothing at runtime from any third party. The URL must use `https`
(except for `localhost`, for local development), and you are warned if it points somewhere
other than a `knowz.io` address.

**What is transmitted.** The Markdown content of the notes it syncs, their paths within your
vault, the name of your vault, a SHA-256 hash of each note's content used to detect changes,
and the pairs of notes connected by your wikilinks. This is the payload the feature requires:
the notes are what gets indexed, and the link pairs are what becomes the graph.

**What is not transmitted.** Non-Markdown files and attachments, anything under your Obsidian
configuration folder,
`.trash/`, or `.smart-env/`, and anything outside your Obsidian vault. The plugin reads no file
outside the vault and uses no Node.js or Electron API.

Your Obsidian configuration folder is excluded unconditionally and cannot be re-included, since
it holds every plugin's stored data — including credentials.

**Everything else in the vault is synced**, minus whatever you add under **Excluded paths**.
The plugin shows you the count and the destination before the first upload, and the **Preview
which notes would sync** command lists what is currently in scope.

**No telemetry.** This plugin collects no usage analytics, no crash reports, and no
client-side telemetry of any kind.

**Payment.** The plugin itself is free and MIT-licensed. Knowz is a commercial service, and
your Knowz plan governs the features available to your account.

## About your API key

Your key is stored in `.obsidian/plugins/knowz-sync/data.json` inside your vault, in plain
text. Obsidian offers a secret storage API that keeps a credential out of the vault; this
plugin has not moved to it yet, because that store is per-device and would mean re-entering
your key on every device you sync this vault to. Doing it well is planned.

Be aware that any other plugin you install can read that file. That is true of every Obsidian
plugin that stores a credential, and it is not something a plugin can prevent — so the
protection that matters is limiting what the key is allowed to do.

What follows from that:

- **Use a non-administrative key, and give it an expiry.** Grant it only what syncing needs.
- **If your vault is in version control**, add `.obsidian/plugins/knowz-sync/data.json` to your
  `.gitignore` before you configure the plugin.
- **If you sync your vault between devices**, remember the key travels with it.
- **Revoke the key from your Knowz account** if a vault copy ends up somewhere it shouldn't.

We are working on narrowly-scoped keys that can do nothing but sync a single vault, which will
reduce the consequences of exposure. Until then, treat the key as you would any password
stored in a file.

## Current limitations

- Sync is one-way. Edits made in Knowz are not written back to your notes.
- Attachments and non-Markdown files are not synced.
- Front-matter tags are not yet mapped to Knowz tags.
- Empty notes are not synced until they contain content.
- A note that is moved *and* edited before the debounce fires cannot be distinguished from a
  delete plus an add, because its content hash changes too. In that case the note is
  re-created on the Knowz side under a new item ID.

## Contributing

`npm install`, then `npm test` for the suite, `npm run typecheck`, and `npm run build` for a
release build. Manual verification steps that need the Obsidian desktop app and a live Knowz
environment are in [docs/manual-verification.md](docs/manual-verification.md).

## Support

Bugs and feature requests: [GitHub issues](https://github.com/knowz-io/obsidian-knowz-sync/issues).

## License

[MIT](LICENSE) © Rapid Venture Group LLC
