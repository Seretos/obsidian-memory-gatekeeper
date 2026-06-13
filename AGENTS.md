# AGENTS.md

Context and conventions that are **not** obvious from reading the source. For
the mechanics, read the code.

## What this plugin is for

It is the review UI of a two-part system. A **separate Claude Code plugin**
intercepts Claude's memory writes and redirects them into a **gatekeeper
folder**. That gatekeeper folder is the Obsidian vault you open. This plugin
diffs that vault against the **real memory folder** and lets the user approve or
reject each proposed change.

Mental model — get this right or the directions invert:

- **Vault (gatekeeper)** = the proposals / working copy. Always the *source* of an "Accept".
- **Target folder** (configured in settings, lives outside the vault) = the real memories. The *destination* of an "Accept".
- A file in the vault with **no target counterpart** = `new`; **different content** = `modified`.

## Non-obvious behavioral rules

- **Files in the vault are never deleted or reverted by this plugin.** The
  Claude Code side relies on the gatekeeper copy staying put (it even pulls a
  real memory back into the gatekeeper when an agent edits it). So:
  - **Accept** copies vault → target. The vault file stays; the marker clears on
    the next scan because the two sides are now identical.
  - **Discard** (the "dismiss" action / `dismiss()`) overwrites the vault file
    with the target's content via `revertFromTarget()`, i.e. it throws away the
    proposed change. The file stays; the marker clears on the next scan because
    the two sides are now identical.
  - **Exception — new files** (no target counterpart): `revertFromTarget()`
    returns false (nothing to revert to, and we never delete). Discard then
    falls back to hiding the file by `relPath + content hash`
    (`settings.dismissed`); it re-surfaces once its content changes. This is the
    only remaining use of the dismissed map, and `scan()` only consults it for
    `status === "new"`. `StatusStore` takes the dismissed map by reference so
    mutating it persists via `saveSettings()`.
  - **Exception — tombstone accept** (the one deliberate vault deletion): if the
    vault file is empty (`vaultContent.trim() === ""`), it is treated as a
    deletion tombstone written by the upstream memory hook to signal that the
    corresponding real memory file should be removed. Accepting such an entry in
    `ComparisonEngine.acceptToTarget` deletes both the target file (via
    `fs.unlink`) and the vault file (via `vault.adapter.remove`). This is the
    only code path that deletes a vault file, and it is strictly gated on the
    empty-tombstone condition. Discarding a tombstone (`dismiss`) calls
    `revertFromTarget` as normal, which restores the target's content into the
    vault file, effectively cancelling the deletion proposal.

- **The plugin is inert until a valid target folder is set.** This is deliberate
  so unrelated vaults aren't affected (plugin settings are per-vault in
  Obsidian). No watchers, no `fs` access, no DOM/graph decoration happen while
  inactive. `activate()`/`deactivate()`/`reconfigure()` gate the whole engine.

## Fragile integrations (expect to re-test on Obsidian upgrades)

- **Graph highlighting** uses the built-in *color groups* feature, not per-node
  styling (there is no public API for individual nodes). Hard-won detail: the
  global graph leaf's `getViewState().state` is **empty `{}`**, so the
  setViewState path does nothing. Color groups must be applied **live through the
  data engine**: `view.dataEngine` (global graph) or `view.engine` (local
  graph), via `getOptions()` → set `colorGroups` → `setOptions()` (then
  `render()`). `colorGroups` is *not* present in `options` until set.
  `GraphDecorator` reserves two groups by color (green=new, orange=modified),
  preserves user groups, and skips re-applying when unchanged (re-render reflows
  for ~1–2s). All engine access is wrapped in try/catch and may break on updates.
- **Graph project labels** (`GraphLabelDecorator`) relabel each project's
  central `MEMORY.md` node with the project name (they'd otherwise all read
  "MEMORY"). There is no label API, so this mutates renderer internals:
  `leaf.view.renderer.nodes[i].text` is a **PIXI.Text** whose `.text` and
  `.style` (fontSize/fontWeight) we overwrite for the dominant first line, and a
  second smaller **child PIXI.Text** is attached for the `(MEMORY)` line (a
  single PIXI.Text has only one style; the child inherits the node's
  transform, so it tracks pan/zoom). Labels are created lazily and recreated as
  nodes enter/leave the viewport, so we **re-assert on an interval** that is
  *gated on a graph leaf being open* (no polling otherwise) rather than wrapping
  the renderer's per-frame callback. Project name comes from the node file's
  `project` frontmatter (written upstream by the memory hook — see
  `agent-claude-memory-gatekeeper#6`); it falls back to the encoded top folder
  segment, which is **not reliably decodable** into a pretty name. The pure
  decision logic lives in `core/graph-labels.ts` (unit-tested); all engine
  access is try/catch-wrapped and may break on Obsidian updates.
- **Explorer markers** toggle CSS classes on `.nav-file-title[data-path]`. Also
  unofficial; we re-apply on `layout-change` because Obsidian rebuilds that DOM.

## Platform / build

- **Desktop-only** (`manifest.json: isDesktopOnly`). The target folder is
  outside the vault, so we use Node `fs`; that only exists on desktop.
- Content comparison is **byte-exact** (no line-ending normalization). If real
  memories and gatekeeper copies ever differ only by EOL, revisit `scan()`.
- Build: `npm run build` (typechecks then bundles to `main.js` via esbuild).
  `npm run dev` watches. Unit tests: `npm run test` (vitest run, covers pure core
  modules — compare, diff-lines, hunks, graph-labels, color-groups, memory-index).
  Integration still requires a real vault.

## Manual test / install

Copy `main.js`, `manifest.json`, `styles.css` into
`<test-vault>/.obsidian/plugins/memory-gatekeeper/`, enable the plugin, set a
target folder in settings, then create divergent files and check the explorer
markers, graph group, review panel, and Accept/Dismiss flows.

## Roadmap note

Diff is whole-file (vertical slice 1). The intended end state is per-hunk
accept/dismiss; editing is delegated to the normal Obsidian editor on the note.
