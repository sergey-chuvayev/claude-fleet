# New agent modal and Codex selection

Approved: replace the full-height draft pane with a centered dialog matching Fleet's existing modals. Keep the current conversation visible behind it. Place a prominent task composer above compact directory, agent, team, model and approval settings. Preserve text on dismissal; discard clears it. Reuse Escape, backdrop dismissal, focus trapping and restoration.

Always expose Claude and Codex. Selecting unavailable Codex explains setup and blocks launching instead of silently substituting Claude. Refresh detection when reopening. Search the server PATH, common local installation locations, the Node executable directory and nvm installations; respect explicit override and disable settings. Preserve Codex's existing exec adapter, sandbox behavior and configured model.

Implementation: move the launch form outside the workspace into the shared modal shell; remove draft-row selection coupling; retain team customization; refresh runtime availability; cover detection and launch controls in tests. Validate desktop/mobile layout, draft persistence, focus, both runtimes and launch payload with synthetic server responses, then run the Node suite.
