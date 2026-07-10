# Changelog

## 2.1.0

### Removed
- **Tailwind class export.** The computed-style → utility-class conversion was
  lossy (approximate values, needed the Tailwind runtime to render, froze
  layout with fixed sizes). Removed the `opt-tailwind` option, the `tailwind`
  extract mode, and related mapping code. Use the default authored-CSS export
  (optionally JSX/Vue) instead.

## 2.0.0

Major release. The extractor was rewritten to produce authored, maintainable
code instead of a flat computed-style dump, and multiple export formats were
added.

### Added
- **Authored CSS extraction**: pulls the real stylesheet rules that apply to the
  selection — class selectors, shorthand, `var()`, `@media`, `@supports`,
  `@keyframes`, `@font-face` — with a computed-style snapshot fallback for
  cross-origin sheets.
- **Design tokens**: repeated colors and font stacks hoisted into `:root` vars.
- **Framework export**: copy as standalone HTML, JSX, Vue SFC, or Tailwind
  utility classes.
- **Componentize**: detect repeated sibling structures and emit a keyed React
  `.map()` list with a template + data array.
- **Multi-select**: collect several sections in one pass (Esc to finish);
  exports combined with de-duplicated CSS.
- **Formatting**: pretty-print or minify CSS output.
- **Asset handling**: link absolute URLs (default) or inline as base64; inline
  `<use>`/external SVG icon references.
- **Cross-origin awareness**: warns when stylesheets could not be read.
- **Copy Code** button and a test suite (`npm test`) with pure-function unit
  tests plus headless-Chrome regression tests.

### Fixed
- `var()` shorthands (e.g. `background: var(--x)`) losing their value.
- `@font-face`/`@keyframes` url()s left relative in standalone output.
- Ancestor rules leaking layout/decoration into the clone.
- Duplicate `:root` blocks.
- Tailwind `isTransparent` dropping colors with a zero channel.

### Breaking
- Output CSS is now authored source rules, not computed-style declarations, so
  the emitted selectors and property set differ from 1.x.

See tags `1.0.0`–`1.3.0` for the incremental history.
