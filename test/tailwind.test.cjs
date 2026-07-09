// Headless-Chrome test for Tailwind export mode.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const EXT = path.join(REPO, 'src/content/extractor.js');
const CHROME = process.env.CHROME_BIN ||
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const classSrc = fs.readFileSync(EXT, 'utf8').replace(/^export\s+class/m, 'class');

const fixture = `<!doctype html>
<html><head><style>
  .box {
    display: flex; flex-direction: column; align-items: center; justify-content: space-between;
    gap: 20px; padding: 16px; margin: 8px; width: 300px; border-radius: 12px;
    background: rgb(255, 0, 0); color: rgb(17, 34, 51); border: 2px solid rgb(0, 0, 0);
  }
  .box .label { font-size: 18px; font-weight: 700; text-align: center; }
</style></head>
<body>
  <div class="box" id="target"><span class="label">Hi</span></div>
<script>
${classSrc}
window.addEventListener('load', async () => {
  const emit = (d) => { const o=document.createElement('script'); o.id='result'; o.type='application/json'; o.textContent=JSON.stringify(d); document.body.appendChild(o); };
  try { emit(await new Extractor().extract(document.getElementById('target'), { mode: 'tailwind' })); }
  catch (e) { emit({ error: String((e&&e.stack)||e) }); }
});
</script></body></html>`;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lsc-tw-'));
const fp = path.join(tmp, 'f.html');
fs.writeFileSync(fp, fixture);

const dom = execFileSync(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox',
  '--virtual-time-budget=4000', '--dump-dom', 'file://' + fp
], { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 });

const m = dom.match(/<script id="result" type="application\/json">([\s\S]*?)<\/script>/);
if (!m) { console.error('NO RESULT'); process.exit(2); }
const r = JSON.parse(m[1]);
if (r.error) { console.error('THREW:\n', r.error); process.exit(3); }

const { html, css } = r;
const has = (c) => new RegExp('class="[^"]*\\b' + c.replace(/[[\]]/g, '\\$&') + '\\b').test(html) || html.includes(c);

const checks = [
  ['no <style> css emitted', css === ''],
  ['framework flag = tailwind', r.framework === 'tailwind'],
  ['flex', html.includes('flex')],
  ['flex-col', html.includes('flex-col')],
  ['items-center', html.includes('items-center')],
  ['justify-between', html.includes('justify-between')],
  ['gap-[20px]', html.includes('gap-[20px]')],
  ['p-[16px]', html.includes('p-[16px]')],
  ['m-[8px]', html.includes('m-[8px]')],
  ['no fixed width emitted (w-[…] dropped)', !/\bw-\[/.test(html)],
  ['no fixed height emitted (h-[…] dropped)', !/\bh-\[/.test(html)],
  ['rounded-[12px]', html.includes('rounded-[12px]')],
  ['bg-[#ff0000]', html.includes('bg-[#ff0000]')],
  ['text-[#112233] (color hex)', html.includes('text-[#112233]')],
  ['border', /\bborder\b/.test(html)],
  ['label font-size text-[18px]', html.includes('text-[18px]')],
  ['label font-bold', html.includes('font-bold')],
  ['label text-center', html.includes('text-center')],
];

let fail = 0;
for (const [n, ok] of checks) { console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}`); if (!ok) fail++; }
console.log(`\n${checks.length - fail}/${checks.length} passed, ${fail} failed`);
if (fail) console.log('\nHTML:\n' + html);
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
