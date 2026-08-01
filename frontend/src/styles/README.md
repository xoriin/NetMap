# Frontend style ownership

The global stylesheet index is intentionally limited to application-wide foundations:

- `tokens.css` — design tokens and theme-independent variables
- `base.css` — document defaults and global element behaviour
- `shell.css` — authenticated application shell and sidebar
- `dashboard.css` — shared dashboard primitives
- `workspaces.css` — legacy cross-workspace layout primitives
- `theme-dark.css` — global dark-mode overrides
- `monitoring.css` — legacy monitoring/topology primitives pending further extraction
- `components.css` — reusable `nm-*` components and other genuinely shared UI primitives

Feature-specific styles belong beside the feature that owns them. A workspace entry point imports
its stylesheet directly, for example:

```tsx
import "./tools.css";
```

Current feature-owned stylesheets live under `src/features/<feature>/` for Admin, Inventory, IPAM,
VLANs, Locations, Overview, Topology, Tools, Security, Exports, Profile, and the visual preview pages.

## Rules

1. Do not add route selectors such as `body.route-tools` or workspace-specific component names to
   `components.css`.
2. Put shared `nm-*` primitives in `components.css` only when they are used by multiple features.
3. Import one feature stylesheet from the workspace entry point rather than from leaf components.
4. Keep feature styles token-driven and compatible with both light and dark themes.
5. If a rule becomes shared by multiple workspaces, promote only that rule to `components.css` and
   document the shared component contract.
6. A feature code commit should include its corresponding stylesheet so behaviour and presentation
   remain reviewable together.

