# Live Site Clone

Clone any section from a website into clean HTML/CSS. This Chrome extension allows you to pick any element on a webpage and export it as a standalone HTML/CSS package.

## Features

- **Element Picker**: Interactive selection of any DOM element.
- **Authored CSS extraction**: Pulls the real stylesheet rules that apply to the
  selection — preserving class selectors, shorthand, `var()`, `@media`,
  `@keyframes`, and `@font-face` — instead of a flat computed-style dump.
  Falls back to a computed-style snapshot for cross-origin sheets.
- **Design tokens**: Repeated colors and font stacks are hoisted into `:root`
  custom properties.
- **Framework export**: Copy as standalone HTML, JSX, or Vue SFC.
- **Componentize**: Detect repeated sibling structures (cards, list items) and
  emit a React `.map()` list with a template + extracted data array.
- **Multi-select**: Collect several sections in one pass (Esc to finish); exports
  are combined with de-duplicated CSS.
- **Formatting**: Pretty-print or minify the CSS output.
- **Asset handling**: Link assets by absolute URL (default) or inline them as
  Base64 for full portability. Inline `<use>`/external SVG icons are resolved.
- **Cross-origin awareness**: Warns when stylesheets couldn't be read.

## Testing

```
npm test
```

Runs pure-function unit tests plus headless-Chrome regression tests (extractor,
Tailwind, componentize) against fixture pages. Override the browser binary with
`CHROME_BIN=/path/to/chrome`.

### Responsive note

The primary (source-rule) path captures `@media` blocks for **all** breakpoints,
not just the active viewport, so responsive behaviour is preserved. The
computed-style fallback (used only for cross-origin stylesheets) is a
single-viewport snapshot — a content script cannot resize the top window to
re-measure other breakpoints.

## Installation

1. Clone this repository.
2. Open Chrome and navigate to `chrome://extensions`.
3. Enable "Developer mode" in the top right.
4. Click "Load unpacked" and select the project folder.

## Icons

The extension uses high-quality PNG icons located in `assets/icons/`.
