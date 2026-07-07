// Headless-Chrome test for componentize (needs DOMParser).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const POST = path.join(REPO, 'src/lib/postprocess.js');
const CHROME = process.env.CHROME_BIN ||
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const postSrc = fs.readFileSync(POST, 'utf8');

const fixture = `<!doctype html><html><head></head><body>
<script>${postSrc}</script>
<script>
window.addEventListener('load', () => {
  const html = '<ul class="list">' +
    '<li class="card"><h3>Alpha</h3><p>$1</p></li>' +
    '<li class="card"><h3>Beta</h3><p>$2</p></li>' +
    '<li class="card"><h3>Gamma</h3><p>$3</p></li>' +
    '</ul>';
  const c = LSC.componentize(html);
  const react = LSC.toReactList(c);
  const o = document.createElement('script');
  o.id = 'result'; o.type = 'application/json';
  o.textContent = JSON.stringify({ c, react });
  document.body.appendChild(o);
});
</script>
</body></html>`;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lsc-cz-'));
const fp = path.join(tmp, 'f.html');
fs.writeFileSync(fp, fixture);

const dom = execFileSync(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox',
  '--virtual-time-budget=3000', '--dump-dom', 'file://' + fp
], { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 });

const m = dom.match(/<script id="result" type="application\/json">([\s\S]*?)<\/script>/);
if (!m) { console.error('NO RESULT'); process.exit(2); }
const { c, react } = JSON.parse(m[1]);

const checks = [
  ['detected 3 repeated items', c && c.count === 3],
  ['signature is LI.card', c && c.signature === 'LI.card'],
  ['two text fields', c && c.fields.filter(f => f.startsWith('text')).length === 2],
  ['template has {{text0}} placeholder', c && c.template.includes('{{text0}}')],
  ['items carry values', c && c.items[0].text0 === 'Alpha' && c.items[2].text0 === 'Gamma'],
  ['react output maps items', react.includes('items.map((item, i)')],
  ['react binds item.text0', react.includes('{item.text0}')],
  ['react adds key', react.includes('key={i}')],
  ['react uses className', react.includes('className="card"')],
];

let fail = 0;
for (const [n, ok] of checks) { console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}`); if (!ok) fail++; }
console.log(`\n${checks.length - fail}/${checks.length} passed, ${fail} failed`);
if (fail) console.log('\n' + JSON.stringify(c, null, 2) + '\n\n' + react);
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
