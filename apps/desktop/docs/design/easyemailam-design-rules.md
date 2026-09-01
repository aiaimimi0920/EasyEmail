# EasyEmailAM Design Rules

Last updated: 2026-06-15

## Window and layout baseline

- EasyEmailAM designs use `1024x768` as the minimum supported content resolution.
- The default desktop window size is also `1024x768`.
- Users may expand the window to gain more reading and list space; layouts may reflow upward for larger canvases.
- Designs must not rely on dimensions below `1024x768`. Sub-1024 CSS exists only as a defensive fallback, not as a supported product state.
- At `1024x768`, the Mail view must keep the primary workflow readable:
  - compact left navigation rail
  - command bar with source/search/actions
  - message list with readable sender, subject, preview, state, and received time
  - reading pane with visible toolbar, sender header, and message body
- Horizontal scrolling is not an acceptable solution for the Mail shell, message list, or reading pane at the minimum baseline.

## Visual language

- Follow the NeuroLoom industrial-terminal variant:
  - graphite / near-black shell
  - signal-yellow primary emphasis
  - left rail plus main board hierarchy
  - internal scroll panes instead of page-level overflow
  - real data and real mail state instead of decorative placeholders
- Preserve the current mail information architecture:
  - top-level module rail
  - Mail command bar
  - source drawer
  - message list
  - reading pane
- Prefer removing low-value explanatory text before reducing core mail content.
