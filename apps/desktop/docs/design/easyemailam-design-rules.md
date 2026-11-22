# EasyEmailAM Design Rules

Last updated: 2026-09-06

## Window and layout baseline

- EasyEmailAM uses Loom's `1120x760` desktop window as its primary design baseline.
- The native window does not impose a minimum size; sub-1024 CSS remains a defensive fallback.
- Users may expand the window to gain more reading and list space; layouts may reflow upward for larger canvases.
- Designs must not rely on dimensions below `1120x760` for their primary composition.
- At `1120x760`, the Mail view must keep the primary workflow readable:
  - compact left navigation rail
  - command bar with source/search/actions
  - message list with readable sender, subject, preview, state, and received time
  - reading pane with visible toolbar, sender header, and message body
- Horizontal scrolling is not an acceptable solution for the Mail shell, message list, or reading pane at the minimum baseline.

## Visual language

- Follow the canonical Neuro UI specification in
  `Neuro/docs/UI设计与颜色方案`; Hook and Loom are implementation references,
  not independent palettes.
- Use the shared semantic roles:
  - signal yellow `#d9ff38`: the current state, keyboard focus, and the single
    primary action in a context
  - signal green `#22c55e`: brand, online, success, and completion
  - information blue `#06b6d4`: links, synchronization, devices, and other
    low-risk technical actions
  - danger red `#f43f5e`: errors, deletion, and high-risk operations
- Keep the shell graphite / near-black and nearly opaque. Do not use decorative
  glass blur, glow orbs, or gradients as structural substitutes.
- Use compact controls, medium or small radii, continuous rows, and restrained
  signal lines. Avoid a wall of nested cards or full-screen pills.
- Reserve the light focus surface for selected mail reading and focused editing
  such as Compose; menus and ordinary tools remain dark surfaces.
- Use internal scroll panes instead of page-level overflow and expose loading,
  empty, success, information, and error states with text or icons in addition
  to color.
- Runtime cascade ownership:
  - `src/App.css` owns product layout and component-specific behavior.
  - `src/styles/neuro-canonical.css` owns the cross-product Neuro appearance contract.
  - `src/styles/loom-desktop-shell.css` is imported last and owns only the desktop shell geometry.
- Preserve the current mail information architecture:
  - top-level module rail
  - Mail command bar
  - source drawer
  - message list
  - reading pane
- Prefer removing low-value explanatory text before reducing core mail content.
