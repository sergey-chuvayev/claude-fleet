# Fleet search and new-agent modals

Approved direction: two matching wide dialogs, retaining Fleet’s Warp-derived palette and adding restrained, friendly polish.

Search opens with Command/Ctrl+K: a prominent field, editable suggestion buttons, existing transcript answers and session links. New agent has a large first-message composer alongside project, name, model and approval settings. Both use a 960px frame, subtle entrance motion, responsive stacking, contained scrolling, Escape/backdrop dismissal, trapped focus and focus restoration. Existing APIs and approval defaults remain authoritative.

Implementation: update the existing HTML; add scoped dialog styles using the current theme tokens; wire suggestions and inert background; preserve search/launch handlers; run the Node suite and browser checks on desktop and narrow screens. Validate search and launch with mocked requests to avoid starting real work during UI checks.
