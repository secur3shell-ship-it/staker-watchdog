---
name: staker-watchdog-ui
description: Visual design reference for the Staker Watchdog frontend. Use only when restyling or polishing existing UI (colors, typography, spacing, borders, layout, visual states). This skill never changes logic, data flow, props, routes, dependencies, copy, or tests.
---

# Staker Watchdog UI Reference (restyle only)

This is a **visual reference**. Use it to make the existing app look calm, dense,
exact, and trustworthy, like a serious infrastructure product. It describes how
things should look. It does not describe what the app does.

---

## 0. Guardrails (read first, these override everything below)

When applying this skill you **must not**:

- Change any logic, conditions, calculations, thresholds, data fetching, state
  management, hooks, API calls, or side effects.
- Change component names, exports, file locations, props, types, or function
  signatures.
- Add, remove, rename, or upgrade dependencies or fonts. If a font or icon library
  named here isn't installed, use what the repo already has and the fallback stack.
- Add new features, screens, routes, components with behavior, keyboard shortcuts,
  filters, toggles, or states that don't already exist.
- Change user-facing text, labels, or aria attributes that tests or other code might
  depend on. Only adding a missing `aria-label` to an icon-only button is allowed.
- Remove or rename `id`, `data-testid`, `data-*`, `name`, `role`, or any class name
  referenced by JavaScript, tests, or analytics.
- Reorder or restructure the DOM in ways that change behavior, tab order, or
  semantics.
- Change chart types, table columns, or what data is shown. Restyle only.

You **may**:

- Change class names used purely for styling, CSS, CSS variables, and the theme
  configuration file.
- Add purely presentational wrappers or elements, but only where they don't affect
  behavior or tests.
- Adjust spacing, color, typography, borders, radius, shadow, and transitions.
- Map existing values (severity, status, score bands) **that already exist in the
  code** to the visual styles defined here.

If a requested visual change would require any logic change, **stop and say so**
instead of making it.

Any numbers in this file that aren't visual (bps, percentages, time windows) are
illustration only. The UI displays whatever values the code already provides.

---

## 1. Design intent

- Look and feel: monochrome graphite, dense, precise. Think Bloomberg crossed with
  Linear.
- Color is spent only on meaning: state, focus, selection, and data. Roughly 90% of
  any screen is graphite.
- Dark theme is primary. Light theme is fully supported.
- Elevation comes from surface lightness and 1px borders, not shadows.

---

## 2. Palette: Graphite & Ion

### 2.1 Tokens

```css
:root,
[data-theme="dark"] {
  --canvas:          #0B0C0E;
  --surface-1:       #111316;
  --surface-2:       #16191D;
  --surface-3:       #1C2025;
  --overlay:         #14171B;

  --border-subtle:   #1F2328;
  --border:          #2A2F36;
  --border-strong:   #3A4049;

  --text-primary:    #ECEDEE;
  --text-secondary:  #A3A9B3;
  --text-tertiary:   #6B727D;
  --text-disabled:   #4A5059;
  --text-inverse:    #0B0C0E;

  --ion:             #8B9EFF;
  --ion-hover:       #A3B2FF;
  --ion-muted:       rgba(139, 158, 255, 0.12);
  --ion-border:      rgba(139, 158, 255, 0.35);

  --positive:        #3DD68C;
  --positive-bg:     rgba(61, 214, 140, 0.10);
  --positive-border: rgba(61, 214, 140, 0.28);
  --caution:         #F5B83D;
  --caution-bg:      rgba(245, 184, 61, 0.10);
  --caution-border:  rgba(245, 184, 61, 0.28);
  --critical:        #FF6369;
  --critical-bg:     rgba(255, 99, 105, 0.10);
  --critical-border: rgba(255, 99, 105, 0.30);

  --series-1: #8B9EFF;
  --series-2: #5EC8D8;
  --series-3: #D9B26F;
  --series-4: #B39DDB;
  --series-5: #9AA5B1;
  --series-6: #E79BC0;
  --grid-line: #1C2025;

  --shadow-popover: 0 0 0 1px var(--border), 0 12px 32px rgba(0, 0, 0, 0.45);
  --focus-ring: 0 0 0 2px var(--canvas), 0 0 0 4px var(--ion);
}

[data-theme="light"] {
  --canvas:          #FAFAF9;
  --surface-1:       #FFFFFF;
  --surface-2:       #F4F4F2;
  --surface-3:       #ECECE9;
  --overlay:         #FFFFFF;
  --border-subtle:   #EBEBE8;
  --border:          #DEDED9;
  --border-strong:   #C4C4BF;
  --text-primary:    #121314;
  --text-secondary:  #50555C;
  --text-tertiary:   #7E838A;
  --text-disabled:   #B0B4B9;
  --text-inverse:    #FFFFFF;
  --ion:             #4C5FD5;
  --ion-hover:       #3D4FC2;
  --ion-muted:       rgba(76, 95, 213, 0.08);
  --ion-border:      rgba(76, 95, 213, 0.30);
  --positive:        #12855A;
  --positive-bg:     rgba(18, 133, 90, 0.08);
  --positive-border: rgba(18, 133, 90, 0.25);
  --caution:         #A86A12;
  --caution-bg:      rgba(168, 106, 18, 0.08);
  --caution-border:  rgba(168, 106, 18, 0.25);
  --critical:        #C9353B;
  --critical-bg:     rgba(201, 53, 59, 0.07);
  --critical-border: rgba(201, 53, 59, 0.25);
  --grid-line:       #ECECE9;
  --shadow-popover:  0 0 0 1px var(--border), 0 8px 24px rgba(18, 19, 20, 0.08);
  --focus-ring:      0 0 0 2px var(--canvas), 0 0 0 4px var(--ion);
}
```

If the repo already has a theme mechanism (class, attribute, or provider), attach
these variables to it. Do not introduce a new one. If the repo uses Tailwind, map
the tokens in its existing theme config.

### 2.2 Color usage

- Use tokens everywhere. Replace raw palette classes (`bg-zinc-900`,
  `text-green-500`, `bg-indigo-600`) and hex values in components with tokens.
- **Primary button:** `--text-primary` background with `--text-inverse` text. It is
  inverted, not Ion.
- **Ion** is for focus rings, selected states, links, the active nav indicator, and
  chart series 1 only.
- Semantic colors map to states that **already exist in the code**:
  - success / ok / decrease-for-staker → positive
  - warning → caution
  - error / danger → critical
- For staker-facing values, an increase in commission is bad and should look like
  caution or critical, if the code already distinguishes direction.
- Pair state color with an existing icon or label where one is present. Never make
  color the only signal.
- Tinted backgrounds (`*-bg`) belong only on badges, inline notices, and the left
  accent of alert rows. Never tint whole cards or sections.

---

## 3. Typography

- **Font stack:** Geist, Inter, system-ui, sans-serif. **Mono stack:** Geist Mono,
  JetBrains Mono, ui-monospace, monospace. Use whichever fonts are already loaded. Do
  not add font packages.
- Set `font-variant-numeric: tabular-nums` globally.
- Use mono for pubkeys, signatures, slots, basis points in tables, code, and raw API
  output.

| Role | Size / line-height | Weight |
|---|---|---|
| Table header label | 11 / 16, uppercase, tracking 0.04em | 500 |
| Meta, timestamps | 12 / 16 | 400 |
| **Default UI / table cells** | 13 / 20 | 400 |
| Body, inputs | 14 / 20 | 400 |
| Card title | 16 / 24 | 500 |
| Page title | 20 / 28 | 600 |
| Key metric value | 24 / 32 | 600 |
| Marketing H1 only | 32 / 40, tracking -0.02em | 600 |

- Allowed weights: 400, 500, 600. Replace 700, 800, and 900 with 600.
- Text hierarchy: headings use `--text-primary`, labels `--text-secondary`, and meta
  `--text-tertiary`. Do not use other grays.

---

## 4. Space, radius, elevation, motion

- **Spacing scale (px):** 4, 8, 12, 16, 20, 24, 32, 48, 64. Normalize odd values to
  the nearest step.
- **Radius:** 4px for badges, inputs, and checkboxes. 6px for buttons, cards, and
  table containers. 8px for dialogs and popovers. Nothing larger, except circular
  avatars and dots.
- **Cards:** `--surface-1` background, 1px `--border`, 6px radius, 16 or 20px padding.
  If cards are nested, flatten them visually by removing the inner border and
  background and using `--border-subtle` dividers. Keep the DOM unchanged.
- **Shadows:** none on cards or sections. Use `--shadow-popover` only for popovers,
  menus, dialogs, and toasts.
- **Motion:** 120 to 160ms, `cubic-bezier(0.2, 0, 0, 1)`. Animate only opacity,
  transform, background-color, and border-color. Remove hover lifts, bounces, and glow
  pulses. Respect `prefers-reduced-motion`.
- **Icons:** keep the existing icon library. Visual size is 16px (14px in table
  cells), stroke 1.5 where configurable, with color inherited from text. Visually
  de-emphasize decorative icons on headings, or hide them with CSS.

---

## 5. Layout styling (for the existing shell)

- **Sidebar:** `--surface-1` background with a right border. Nav items are 32px tall
  at 13px. The active item gets `--surface-3`, `--text-primary`, and a 2px Ion bar on
  its left edge.
- **Top bar:** 48px tall, `--canvas` or `--surface-1` background, bottom border.
- **Page header:** title in the page title style, optional description in
  `--text-secondary`, actions right-aligned.
- **Content:** 24px padding. Tables are full width. Forms are visually capped at
  640px max width, prose at 720px, unless existing layout logic sets widths.

---

## 6. Visual specs for existing domain elements

Apply these **only to elements that already exist**. Do not create them.

- **Pubkeys / addresses:** mono, 13px. If the code already truncates, style the
  ellipsis in `--text-tertiary`. Copy buttons are 14px icons, visible on hover and
  focus.
- **Commission values (inflation and block):** label in `--text-tertiary` at 12px,
  value in `--text-primary` with tabular-nums. When both are shown together, give
  them equal visual weight on one line, separated by 16px.
- **Commission changes (old → new):** old value in `--text-tertiary` with
  line-through, then an arrow, then the new value in `--text-primary`. The delta chip
  uses the badge style in the severity color the code already assigns.
- **Collector / destination accounts:** pubkey style plus any existing relationship
  label shown as a badge. "Self" and "known" labels are neutral. "External" or
  "unknown" labels use the caution style.
- **Scores:** number in tabular-nums plus the existing band label, in the semantic
  color mapped from the existing band. If a progress or bar element exists, style it
  as a 4px horizontal track (`--surface-3`) with a fill.
- **Freshness / last-updated indicators:** an 8px status dot with no pulse animation,
  then text in `--text-secondary` at 12px. Color the dot from the existing status.
- **Epoch progress:** 4px track in `--surface-3`, Ion fill, label at 12px in
  `--text-secondary`.

**Badges:** 20px tall, 4px radius, 11px at weight 500, tinted background, tinted
border, and always containing text.

---

## 7. Tables

- **Container:** 1px `--border`, 6px radius, horizontal overflow on the container,
  never on the page.
- **Header:** `--surface-2` background, 11px uppercase `--text-tertiary` labels. Keep
  any existing sticky behavior.
- **Rows:** `--border-subtle` separators and no zebra striping. Hover uses
  `--surface-2`. Existing selected states use `--ion-muted` with a 2px Ion left bar.
- **Row height:** 36px, or 44px if the current layout clearly calls for comfortable
  density.
- **Alignment:** text left. Numbers, percents, amounts, and scores right-aligned.
  Status values centered.
- **Sort indicator:** existing indicators are styled at 12px in `--text-tertiary`,
  and `--text-primary` when active.
- **Toolbar controls:** inputs and chips use the input and badge styles. Do not add
  or remove controls.

---

## 8. Forms and controls

- **Inputs:** 36px tall (44px for a single prominent search field), `--surface-2`
  background, 1px `--border`, 4px radius, 14px text, placeholder in `--text-tertiary`.
  Focus shows `--focus-ring`.
- **Buttons:** 32px tall (36px for prominent ones), 6px radius, 13px at weight 500.
  - Primary: inverted.
  - Secondary: `--surface-2` background with a `--border` border.
  - Ghost: transparent background, `--surface-2` on hover.
  - Destructive: `--critical-bg` background, `--critical` text, `--critical-border`
    border.
- **Focus:** every interactive element shows `--focus-ring` on `:focus-visible`.
  Never remove outlines without this replacement.
- **Disabled:** `--text-disabled` text, no hover change, existing disabled logic
  unchanged.

---

## 9. Charts (restyle only)

- Keep the chart type, data, and series. Change only presentation props and CSS.
- **Series colors:** `--series-1` through `--series-6`, in order. Never use state
  colors for series.
- **Gridlines:** horizontal only, in `--grid-line`. No chart border and no background
  fill.
- **Axis labels:** 11px, `--text-tertiary`, tabular-nums.
- **Tooltip:** `--overlay` background, `--shadow-popover`, 8px radius, values
  right-aligned in mono.
- **Effects:** remove area gradients, glows, and 3D effects where they are purely
  stylistic props.

---

## 10. Existing state styling

Style these if they already exist. Do not add new ones.

- **Loading skeletons:** `--surface-2` background, subtle opacity pulse (1.2s),
  radius matching the content they stand in for.
- **Empty states:** text in `--text-secondary`, centered within the container, with
  any existing action as a secondary button. Visually de-emphasize illustrations.
- **Errors:** inline notice with `--critical-bg` and `--critical-border`. Technical
  detail goes in mono text.
- **Warnings / stale notices:** inline notice using the caution tokens.
- **Toasts:** `--overlay` background, `--shadow-popover`, 8px radius, 13px text.

---

## 11. Visual anti-patterns to remove

| Remove | Replace with |
|---|---|
| Gradient backgrounds, buttons, borders | Flat surfaces; inverted primary button |
| Gradient text (`bg-clip-text`) | Solid `--text-primary` |
| Glassmorphism, `backdrop-blur` | Opaque surface plus 1px border |
| `rounded-xl` and larger, pill shapes on non-pill elements | The 4 / 6 / 8px scale |
| Large card shadows, colored glows | Borders |
| Raw palette colors | Tokens |
| Weights 700 to 900 | 600 |
| Oversized padding (32px or more inside cards) | 16 to 24px |
| Hover lifts, bounce, pulse animations | 120 to 160ms color and opacity transitions |
| Low-contrast gray on gray | The text token hierarchy |
| Solana purple-and-green brand styling | Graphite & Ion |

Removing emoji, changing copy, or removing elements counts as content changes. Do
not do these unless the user explicitly asks.

---

## 12. Accessibility (visual side only)

- Text contrast must meet WCAG AA in both themes. Use `--text-tertiary` only for meta
  text at 12px or larger.
- `:focus-visible` styling must be visible on every interactive element.
- Visual hit areas should be at least 32px. Achieve this with padding, not by
  changing the element type.

---

## 13. Verification checklist

Before finishing, confirm:

- [ ] **The diff touches only styling:** class names used for styling, CSS, CSS
      variables, and theme config.
- [ ] **Code is unchanged:** no logic, props, types, imports of new packages, routes,
      hooks, or data code.
- [ ] **Hooks are intact:** all `id`, `data-testid`, `data-*`, `role`, `aria-*`, and
      JS-referenced class names are preserved.
- [ ] **Content is unchanged:** user-facing text, DOM order, and tab order are the
      same as before.
- [ ] **Colors are tokenized:** no raw palette colors remain in touched files.
- [ ] **No banned effects:** no gradients, blur, radius above 8px, or card shadows in
      touched files.
- [ ] **Themes and widths work:** both themes render correctly at 1440, 1024, and
      390px.
- [ ] **Tests pass:** the existing test suite and type check pass unchanged.
- [ ] **Blockers are reported:** any visual change that would have required logic is
      listed for the user instead of being made.
