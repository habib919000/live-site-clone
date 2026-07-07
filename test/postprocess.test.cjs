// Unit tests for the pure post-processing helpers (no DOM / no Chrome).
const assert = require('assert');
const LSC = require('../src/lib/postprocess.js');

let fail = 0;
function check(name, fn) {
  try { fn(); console.log('PASS  ' + name); }
  catch (e) { console.log('FAIL  ' + name + '  — ' + e.message); fail++; }
}

check('prettyCss indents nested blocks', () => {
  const out = LSC.prettyCss('.a{color:red;padding:2px}@media (max-width:5px){.b{color:blue}}');
  assert.ok(/\.a \{\n {2}color: red;\n {2}padding: 2px;\n\}/.test(out), out);
  assert.ok(/@media \(max-width:5px\) \{\n {2}\.b \{/.test(out), out);
});

check('minifyCss strips whitespace', () => {
  const out = LSC.minifyCss('.a {\n  color: red;\n  padding: 2px;\n}\n');
  assert.strictEqual(out, '.a{color:red;padding:2px}');
});

check('extractTokens hoists repeated color to :root var', () => {
  const css = '.a{color:#ff0000}.b{border-color:#ff0000}.c{color:#00ff00}';
  const out = LSC.extractTokens(css);
  assert.ok(/:root \{[\s\S]*--color-1: #ff0000;/.test(out), out);
  assert.ok(out.includes('color:var(--color-1)') || out.includes('color: var(--color-1)'), out);
  // single-use color left alone
  assert.ok(out.includes('#00ff00'), out);
  assert.ok(!out.includes('--color-2: #00ff00'), out);
});

check('extractTokens guards partial hex (#fff vs #ffffff)', () => {
  const css = '.a{color:#fff}.b{color:#fff}.c{color:#ffffff}';
  const out = LSC.extractTokens(css);
  // #fff tokenized, #ffffff not corrupted into var(--color-1)fff
  assert.ok(out.includes('#ffffff'), out);
  assert.ok(!/var\(--color-1\)fff/.test(out), out);
});

check('extractTokens hoists repeated font stack', () => {
  const css = ".a{font-family:'Inter', sans-serif}.b{font-family:'Inter', sans-serif}";
  const out = LSC.extractTokens(css);
  assert.ok(/--font-1: 'Inter', sans-serif;/.test(out), out);
  assert.ok(out.includes('font-family: var(--font-1)'), out);
});

check('toJsx renames class/for and self-closes void tags', () => {
  const out = LSC.toJsx('<div class="x"><label for="y">z</label><img src="a.png"></div>');
  assert.ok(out.includes('className="x"'), out);
  assert.ok(out.includes('htmlFor="y"'), out);
  assert.ok(/<img src="a.png" \/>/.test(out), out);
});

check('toJsx converts inline style to object', () => {
  const out = LSC.toJsx('<div style="background-color: red; --x: 1px"></div>');
  assert.ok(out.includes("backgroundColor: 'red'"), out);
  assert.ok(out.includes("'--x': '1px'"), out);
});

check('toVue wraps template + scoped style', () => {
  const out = LSC.toVue('<div>x</div>', '.a{color:red}');
  assert.ok(out.startsWith('<template>'), out);
  assert.ok(out.includes('<style scoped>'), out);
  assert.ok(out.includes('color: red'), out);
});

check('splitCssBlocks is brace-depth aware', () => {
  const blocks = LSC.splitCssBlocks('.a{color:red}@media(x){.b{color:blue}}');
  assert.strictEqual(blocks.length, 2, JSON.stringify(blocks));
  assert.ok(blocks[1].startsWith('@media'), blocks[1]);
});

check('combineClones merges html and dedupes css', () => {
  const out = LSC.combineClones([
    { html: '<div>a</div>', css: '.x{color:red}' },
    { html: '<div>b</div>', css: '.x{color:red}\n.y{color:blue}' }
  ]);
  assert.ok(out.html.includes('>a<') && out.html.includes('>b<'), out.html);
  assert.ok(out.html.includes('clone-section'), out.html);
  // .x appears once despite being in both
  assert.strictEqual(out.css.split('.x{').length - 1, 1, out.css);
  assert.ok(out.css.includes('.y{'), out.css);
});

console.log(`\n${fail === 0 ? 'ALL PASS' : fail + ' FAILED'}`);
process.exit(fail ? 1 : 0);
