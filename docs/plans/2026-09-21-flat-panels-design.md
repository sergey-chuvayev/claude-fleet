# Flat, resizable session panels

Approved design: present the team overview, conversation, and composer as open sections separated by horizontal rules. Message and tool entries use separators instead of rounded cards. Keep collapse/copy actions, role colors, errors, and focus visibility.

The conversation fills available space. Drag the overview's bottom divider or the composer's top divider to allocate height. Support pointer capture, keyboard arrows, Home/End, double-click reset, and remembered browser preferences. Clamp sizes to preserve the conversation and adapt to small windows; on mobile use normal document flow without splitters.

Implementation: replace the conversation's native resize observer with a shared horizontal splitter helper; attach the team divider when the board is created; flatten scoped styles. Verify existing tests and exercise resizing, persistence, collapse, and narrow layouts with synthetic browser content.

## Verification

Rebased onto Fleet 0.9.0. All 133 tests pass. Chrome checks with synthetic content cover mouse dragging, keyboard limits, saved sizes across reloads, reset, collapse/reopen, board removal, and desktop/mobile layouts. The actual browser scripts also pass composer/team mounting, session switching, and deselection checks with network calls stubbed.
