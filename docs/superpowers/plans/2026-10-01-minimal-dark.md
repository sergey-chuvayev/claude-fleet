# Minimal Dark Fleet Implementation Plan

**Goal:** Implement the approved conversation-first dark Fleet workspace.
**Architecture:** Keep the vanilla browser namespaces and server APIs. Change the shell, row presentation and layout state; add the new visual rules at the end of the existing stylesheet so all current components remain covered.
**Tech Stack:** Node HTTP server, vanilla JavaScript, CSS grid/flex.
**Spec:** docs/plans/2026-10-01-minimal-dark-design.md

## Constraints
Preserve existing controls and permission behavior. No new dependencies. Synthetic screenshots only. Work in the isolated feat/minimal-dark worktree.

- [ ] Shell and sidebar: update public/index.html and public/app.js. Move the existing details toggle to the header, add compact row avatars and activity previews, use a new layout storage key so terminal-era sizes do not override the redesign.
- [ ] Conversation and inspector: update public/styles.css, public/control.js and public/blocks.js. Use neutral tokens, responsive three-column grid, soft prose bubbles, collapsed completed tool output, rounded composer. Default inspector open on wide screens and preserve explicit user preference.
- [ ] Verify: run npm test; serve a synthetic preview locally; inspect desktop, narrow desktop and mobile, toggle inspector and tools, exercise search/new-agent dialogs and session selection. Fix any regressions. Save a synthetic screenshot and record results.
