# Manual verification

These checks require the Obsidian desktop application and a configured Knowz environment. They
are deliberately not part of headless CI — they exercise the real vault event loop and the live
API. Run them before cutting a release.

## 1. Native onboarding

Start with plugin data containing only the API base URL. Run **Connect to Knowz**, complete
browser sign-in and approval, and confirm the personal key returns without copy-paste. In
Obsidian, choose an existing Knowz vault from the dropdown and confirm repository
initialization succeeds. Repeat the flow and deny approval; confirm no key is stored.

## 2. Full sync and titles

Run **Sync vault to Knowz**. Confirm the Knowz item count matches the eligible Markdown file
count. A note with front matter `title: Knowz Integration Project` should use that title;
`Meeting Notes.md` with neither a title nor an H1 should appear as `Meeting Notes`.

## 3. Incremental update

Edit and save a synced note. After roughly 15 seconds, confirm its detail endpoint returns the
new content and a newer `updatedAt`.

## 4. Delete reconciliation

Delete a synced note, wait for the debounce, and confirm its item detail endpoint returns 404
after the soft delete.

## 5. Wikilink graph

Sync notes that link to one another. Confirm the push response reports
`relationshipsImported > 0`, and that the relationship is visible in the Knowz graph.

## 6. Reviewed pull and no echo

Edit one unchanged note in the Knowz web client. Run **Review changes from Knowz** and confirm
exactly one server-only change appears. Choose **Apply**, confirm the local Markdown matches,
then run a full sync and verify it reports A0/M0/D0.

Edit the same note in both Knowz and Obsidian from the last confirmed base. Review again and
confirm the note is reported as a conflict with no Apply action and neither copy overwritten.

## 7. Remote delete behavior

Delete an item from the Knowz web client, then run a full sync in Obsidian. The item should be
re-created. Remote deletes are not pulled into Obsidian.

## 8. Move outside Obsidian

Move an unchanged note with Finder or `mv`. Within one debounce window the delete and create
should be paired as a rename, and the Knowz item ID should be unchanged.

## Gotcha

The knowledge-list endpoint can stay cached for at least 25 seconds after a push. Check item
*detail* endpoints when verifying updates and deletions, not the list.
