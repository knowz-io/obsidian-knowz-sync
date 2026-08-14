# Manual verification

These checks require the Obsidian desktop application and a configured Knowz environment. They
are deliberately not part of headless CI — they exercise the real vault event loop and the live
API. Run them before cutting a release.

## 1. Full sync and titles

Run **Sync vault to Knowz**. Confirm the Knowz item count matches the eligible Markdown file
count. A note with front matter `title: Knowz Integration Project` should use that title;
`Meeting Notes.md` with neither a title nor an H1 should appear as `Meeting Notes`.

## 2. Incremental update

Edit and save a synced note. After roughly 15 seconds, confirm its detail endpoint returns the
new content and a newer `updatedAt`.

## 3. Delete reconciliation

Delete a synced note, wait for the debounce, and confirm its item detail endpoint returns 404
after the soft delete.

## 4. Wikilink graph

Sync notes that link to one another. Confirm the push response reports
`relationshipsImported > 0`, and that the relationship is visible in the Knowz graph.

## 5. Source-of-truth behavior

Delete an item from the Knowz web client, then run a full sync in Obsidian. The item should be
re-created — Obsidian is authoritative.

## 6. Move outside Obsidian

Move an unchanged note with Finder or `mv`. Within one debounce window the delete and create
should be paired as a rename, and the Knowz item ID should be unchanged.

## Gotcha

The knowledge-list endpoint can stay cached for at least 25 seconds after a push. Check item
*detail* endpoints when verifying updates and deletions, not the list.
