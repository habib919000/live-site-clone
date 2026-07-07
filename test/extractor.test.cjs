// Headless-Chrome regression test for the source-rule extractor.
// Runs the real CSSOM (getComputedStyle, Element.matches, CSSRule) against a
// fixture page, then asserts the extracted HTML/CSS.
//
// Usage:  node test/extractor.test.cjs
// Chrome binary: override with CHROME_BIN=/path/to/chrome if not on macOS.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const EXT = path.join(REPO, 'src/content/extractor.js');
const CHROME = process.env.CHROME_BIN ||
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

// Load extractor class, strip ESM export so it runs in a plain <script>.
const classSrc = fs.readFileSync(EXT, 'utf8').replace(/^export\s+class/m, 'class');

const fixture = `<!doctype html>
<html>
<head>
<style>
  :root { --brand: #c0ffee; --pad: 16px; }
  html { font-size: 18px; }
  body { margin: 40px; padding: 24px; background: #eeeeee; font-family: 'Test Sans', sans-serif; color: #222222; }
  .wrap { display: flex; gap: 20px; max-width: 900px; margin: 0 auto; padding: 50px; background: #ffffff; }
  .card { background: var(--brand); border-radius: 8px; padding: var(--pad); color: #111111; }
  .card .title { font-size: 1.5rem; font-weight: 700; margin: 0 0 8px; }
  .card:hover { transform: scale(1.02); }
  .card .title::before { content: '\\2605 '; color: gold; }
  .badge { background: url(badge.png) no-repeat; animation: spin 2s linear infinite; }
  @keyframes spin { from { transform: rotate(0); } to { transform: rotate(360deg); } }
  @media (max-width: 600px) { .card { padding: 8px; } }
  @font-face { font-family: 'Test Sans'; src: url(font.woff2) format('woff2'); }
</style>
</head>
<body>
  <svg style="display:none"><symbol id="ico" viewBox="0 0 10 10"><path d="M0 0h10v10H0z"></path></symbol></svg>
  <div class="wrap">
    <div class="card" id="target">
      <h2 class="title">Hello</h2>
      <span class="badge">b</span>
      <svg class="icon" width="10" height="10"><use href="#ico"></use></svg>
    </div>
  </div>
<script>
${classSrc}
window.addEventListener('load', async () => {
  const emit = (data) => {
    const out = document.createElement('script');
    out.id = 'result';
    out.type = 'application/json';
    out.textContent = JSON.stringify(data);
    document.body.appendChild(out);
  };
  try {
    emit(await new Extractor().extract(document.getElementById('target')));
  } catch (e) {
    emit({ error: String((e && e.stack) || e) });
  }
});
</script>
</body>
</html>`;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lsc-test-'));
const fixturePath = path.join(tmp, 'fixture.html');
fs.writeFileSync(fixturePath, fixture);

const dom = execFileSync(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox',
  '--virtual-time-budget=4000', '--dump-dom',
  'file://' + fixturePath
], { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 });

const m = dom.match(/<script id="result" type="application\/json">([\s\S]*?)<\/script>/);
if (!m) { console.error('NO RESULT captured.'); process.exit(2); }

const result = JSON.parse(m[1]);
if (result.error) { console.error('EXTRACTOR THREW:\n', result.error); process.exit(3); }

const { html, css } = result;
const has = (s) => css.includes(s);
const count = (s) => css.split(s).length - 1;

const checks = [
  ['class selector preserved (.card)', /\.card\b/.test(css)],
  ['authored var() kept, not computed', has('var(--brand)')],
  ['shorthand+var preserved (padding: var(--pad))', has('padding: var(--pad)')],
  [':root var def present', /:root\s*{[^}]*--brand:\s*#c0ffee/.test(css)],
  [':root emitted exactly once (no dup)', count(':root {') === 1],
  ['rem unit preserved (1.5rem)', has('1.5rem')],
  ['@media block kept', /@media\s*\(max-width:\s*600px\)/.test(css)],
  ['@keyframes spin included', has('@keyframes spin')],
  ['@font-face included', has('@font-face')],
  ['@font-face url absolutized', /url\("file:\/\/[^"]*font\.woff2"\)/.test(css)],
  ['bg url absolutized (badge.png)', /url\("file:\/\/[^"]*badge\.png"\)/.test(css)],
  ['pseudo-class rule kept (:hover)', has(':hover')],
  ['pseudo-element rule kept (::before)', has('::before')],
  ['inherited body font kept', has('Test Sans')],
  ['ancestor .wrap layout NOT leaked', !/\.wrap\b/.test(css)],
  ['body non-inherited (background) NOT leaked', !has('#eeeeee')],
  ['html font-size (inherited) kept', has('18px')],
  ['no data-dc-id (primary path used)', !html.includes('data-dc-id')],
  ['html keeps class="card"', html.includes('class="card"')],
  ['html keeps class="title"', html.includes('class="title"')],
  ['SVG <use> inlined (no <use> left)', !/<use\b/.test(html)],
  ['SVG symbol path inlined', html.includes('M0 0h10v10H0z')],
  ['skippedSheets is a number', typeof result.skippedSheets === 'number'],
];

let fail = 0;
for (const [name, ok] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) fail++;
}
console.log(`\n${checks.length - fail}/${checks.length} passed, ${fail} failed`);
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
