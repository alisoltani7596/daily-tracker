# Projects ⇄ Google Docs sync — handoff for the Cowork/Docs pipeline

The app's **Projects** card is now editable (check off, rename, add, delete tasks;
reorder tasks and categories). The app persists those edits as **overrides** in KV;
it does **not** touch Google Docs. Closing the loop — writing the edits back into the
source Docs — is the pipeline's job (it's the only side with Google access). This
doc specifies exactly what to read and how to reconcile.

## Where the edits live

The app writes the whole overrides object to KV key **`today_overrides`** via
`POST /today-overrides` (same path used for Task/Deadline edits). Read that key.

Projects-relevant fields (all optional; may be absent if never edited):

```jsonc
{
  "projectTaskState": {
    "<Category>": {
      "<generated task name>": {
        "done":   true,           // checked off in-app
        "hi":     true,           // marked high-priority in-app
        "text":   "new name",     // renamed in-app (this is the NEW text)
        "hidden": true            // deleted in-app
      }
    }
  },
  "projectAdded": {
    "<Category>": [
      { "n": "task text", "hi": false, "done": false }   // task added in-app
    ]
  },
  "projectOrder":      { "<Category>": ["taskA","taskB", ...] },  // per-category task order (by name)
  "projectGroupOrder": ["Category1","Category2", ...]             // category order
}
```

- **Category** = the project group name exactly as it appears in the generated
  `today.projects[].name` (which the pipeline itself produces from the Docs).
- Keys in `projectTaskState[cat]` are the **generated** task's original name (the `n`
  the pipeline emitted). If a task was renamed, the original name is still the key and
  `text` holds the new name.

## How to reconcile into the Docs

For each category, in the doc that backs it:

1. **`projectTaskState[cat][name]`** patches an existing generated line:
   - `hidden:true`  → remove that line from the Doc (or move to a "done/archive"
     section — your call, but be consistent).
   - `text:"..."`   → rename the line to the new text.
   - `done:true`    → mark it done in whatever convention the Doc uses (strikethrough,
     a `[x]` checkbox, a Done section…). `done:false`/absent → leave open.
   - `hi:true`      → apply your high-priority marker; absent → normal.
2. **`projectAdded[cat][]`** → append each as a new task line under that category,
   applying `done`/`hi` the same way.
3. **`projectOrder` / `projectGroupOrder`** → reorder the lines / the category
   sections to match (names not listed keep their relative order and go last).

## Critical: clear reconciled overrides after writing

Once you've written an edit into the Doc **and** regenerated the `today` KV blob from
the (now-updated) Doc, **remove that edit from `projectTaskState` / `projectAdded`**
and write the trimmed overrides back to `today_overrides`. Otherwise the override
re-applies on top of the already-updated generated data and the edit appears twice (or
a rename/delete "sticks" and can't be undone from the Doc).

Concretely, per reconciled item:
- generated-task patch → `delete projectTaskState[cat][name]` (and drop empty `[cat]`).
- added task → remove it from `projectAdded[cat]` **only after** it exists in the Doc
  and thus in the regenerated generated tasks (so it doesn't vanish between the two
  steps). If you can't guarantee atomicity, prefer leaving `projectAdded` until the
  next generation confirms the task is present, then clear it.

This mirrors how the app already treats Task/Deadline overrides ("edits survive the
morning refresh"): the override is the source of truth until the generated data
catches up, then it's cleared.

## Boundaries (unchanged)

- The app (Claude Code's lane) owns `index.html`/`worker/`; it will keep writing these
  override fields. The pipeline (your lane) owns Google access + the `today` KV blob.
- Don't write `ui:layout:v1` or the Meals keys — those are Claude Code-owned.
- Keep the committed `today.json` free of URLs/private data (full Doc links live only
  in the KV `today` blob served by `GET /today`).
