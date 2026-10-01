# Fleet: minimalist dark workspace

Approved by Sergey on October 1, 2026, from the supplied Grok Bot reference.

Use three columns: a compact session sidebar, the primary conversation, and a collapsible inspector. Neutral charcoal surfaces, warm white prose, small agent avatars and status dots replace the dense terminal presentation. Keep monospace for code and tool output. Messages use soft bubbles and the composer uses a rounded surface. Preserve approvals, models, search, archive, session references, attachments, teams, Work queue, Connections and Settings controls.

Desktop: a roughly 280px resizable sidebar, flexible conversation, and 280px inspector. Smaller widths collapse the inspector by default; mobile stacks the session list and conversation. Inspector visibility persists. External and child sessions retain their read-only detail views. Existing SDK, API, polling, draft state and permission behavior remain intact.

Verification: full existing Node test suite plus browser checks with synthetic sessions for layout, selection, inspector toggle, expanded tools, composer, search/new-agent dialogs and narrow viewports. No real transcripts in committed screenshots.

Release scope: rebased onto 0.19.0; excludes the unrelated unreleased Today panel from the original local checkout.
