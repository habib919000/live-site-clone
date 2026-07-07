/*
 * Pure post-processing helpers for extracted HTML/CSS.
 * No DOM dependency — usable in the popup (as a global) and in Node tests.
 *
 * NOTE: HTML is intentionally never reflowed/pretty-printed here. Whitespace
 * between inline elements is significant, so re-indenting markup would change
 * rendering. Only CSS (whitespace-insensitive) is formatted.
 */
(function (global) {
  const VOID_TAGS = new Set([
    'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
    'link', 'meta', 'param', 'source', 'track', 'wbr'
  ]);

  // ---- CSS formatting --------------------------------------------------------

  // Normalize a single declaration: "prop:value" -> "prop: value".
  function formatDecl(decl) {
    const i = decl.indexOf(':');
    if (i === -1) return decl.trim();
    return decl.slice(0, i).trim() + ': ' + decl.slice(i + 1).trim();
  }

  function prettyCss(css) {
    const s = String(css).replace(/\s+/g, ' ').trim();
    let out = '';
    let indent = 0;
    let buf = '';
    const pad = () => '  '.repeat(Math.max(0, indent));

    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (c === '{') {
        out += pad() + buf.trim() + ' {\n';
        buf = '';
        indent++;
      } else if (c === '}') {
        if (buf.trim()) out += pad() + formatDecl(buf) + ';\n';
        buf = '';
        indent--;
        out += pad() + '}\n';
      } else if (c === ';') {
        if (buf.trim()) out += pad() + formatDecl(buf) + ';\n';
        buf = '';
      } else {
        buf += c;
      }
    }
    if (buf.trim()) out += formatDecl(buf) + '\n';
    return out.replace(/\n{3,}/g, '\n\n').trim() + '\n';
  }

  function minifyCss(css) {
    return String(css)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\s+/g, ' ')
      .replace(/\s*([{}:;,>])\s*/g, '$1')
      .replace(/;}/g, '}')
      .trim();
  }

  // ---- Design token extraction ----------------------------------------------

  // Pull repeated color literals and font stacks into :root custom properties.
  function extractTokens(css) {
    let out = String(css);
    const rootLines = [];

    // Colors: #hex and rgb()/rgba()/hsl()/hsla() used more than once.
    const colorRe = /#[0-9a-fA-F]{3,8}\b|(?:rgba?|hsla?)\([^)]*\)/g;
    const colorCounts = new Map();
    const colorOrder = [];
    let m;
    while ((m = colorRe.exec(out)) !== null) {
      const val = m[0];
      if (!colorCounts.has(val)) { colorCounts.set(val, 0); colorOrder.push(val); }
      colorCounts.set(val, colorCounts.get(val) + 1);
    }
    let ci = 0;
    for (const val of colorOrder) {
      if (colorCounts.get(val) < 2) continue;
      const name = `--color-${++ci}`;
      rootLines.push(`  ${name}: ${val};`);
      out = replaceValue(out, val, `var(${name})`);
    }

    // Font stacks: same `font-family: <stack>` used more than once.
    const fontRe = /font-family:\s*([^;{}]+)/g;
    const fontCounts = new Map();
    const fontOrder = [];
    while ((m = fontRe.exec(out)) !== null) {
      const val = m[1].trim();
      if (val.startsWith('var(')) continue;
      if (!fontCounts.has(val)) { fontCounts.set(val, 0); fontOrder.push(val); }
      fontCounts.set(val, fontCounts.get(val) + 1);
    }
    let fi = 0;
    for (const val of fontOrder) {
      if (fontCounts.get(val) < 2) continue;
      const name = `--font-${++fi}`;
      rootLines.push(`  ${name}: ${val};`);
      const esc = val.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      out = out.replace(new RegExp('font-family:\\s*' + esc, 'g'), `font-family: var(${name})`);
    }

    if (!rootLines.length) return out;
    return `:root {\n${rootLines.join('\n')}\n}\n\n${out}`;
  }

  // Replace a literal value everywhere, guarding against partial hex matches
  // (e.g. #fff inside #ffffff).
  function replaceValue(text, value, replacement) {
    const esc = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = value.startsWith('#')
      ? new RegExp(esc + '(?![0-9a-fA-F])', 'g')
      : new RegExp(esc, 'g');
    return text.replace(re, replacement);
  }

  // ---- Framework export ------------------------------------------------------

  function styleToJsx(styleStr) {
    const props = styleStr.split(';').map(s => s.trim()).filter(Boolean).map(decl => {
      const i = decl.indexOf(':');
      if (i === -1) return null;
      let prop = decl.slice(0, i).trim();
      const value = decl.slice(i + 1).trim();
      // custom properties stay quoted as-is; others camelCase
      const key = prop.startsWith('--')
        ? `'${prop}'`
        : prop.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      return `${key}: '${value.replace(/'/g, "\\'")}'`;
    }).filter(Boolean);
    return `{{ ${props.join(', ')} }}`;
  }

  function toJsx(html) {
    let out = String(html);
    // comments
    out = out.replace(/<!--([\s\S]*?)-->/g, (_, c) => `{/*${c}*/}`);
    // attribute renames
    out = out.replace(/\bclass=/g, 'className=').replace(/\bfor=/g, 'htmlFor=');
    // inline styles -> object
    out = out.replace(/style="([^"]*)"/g, (_, s) => `style=${styleToJsx(s)}`);
    // self-close void elements
    out = out.replace(/<([a-zA-Z][\w-]*)\b([^>]*?)\s*(?<!\/)>/g, (full, tag, attrs) => {
      if (VOID_TAGS.has(tag.toLowerCase())) return `<${tag}${attrs} />`;
      return full;
    });
    return out;
  }

  function toVue(html, css) {
    return `<template>\n${html}\n</template>\n\n<style scoped>\n${prettyCss(css)}</style>\n`;
  }

  // ---- Componentize (repeat detection) --------------------------------------

  // Detect the largest group of sibling elements sharing a tag+class signature,
  // and turn them into a template + data array. Requires DOMParser (browser).
  function componentize(html) {
    if (typeof DOMParser === 'undefined') return null;
    const doc = new DOMParser().parseFromString(String(html), 'text/html');
    const root = doc.body.firstElementChild;
    if (!root) return null;

    const sigOf = (el) => el.tagName + '.' + Array.from(el.classList).sort().join('.');

    let best = null;
    const candidates = [root, ...root.querySelectorAll('*')];
    for (const parent of candidates) {
      if (parent.children.length < 2) continue;
      const groups = new Map();
      for (const c of parent.children) {
        const sig = sigOf(c);
        if (!groups.has(sig)) groups.set(sig, []);
        groups.get(sig).push(c);
      }
      for (const els of groups.values()) {
        if (els.length >= 2 && (!best || els.length > best.els.length)) best = { els };
      }
    }
    if (!best) return null;

    const collectTexts = (el) => {
      const list = [];
      const walk = (n) => n.childNodes.forEach((ch) => {
        if (ch.nodeType === 3) { const s = ch.textContent.trim(); if (s) list.push(ch); }
        else if (ch.nodeType === 1) walk(ch);
      });
      walk(el);
      return list;
    };
    const collectImgs = (el) => Array.from(el.querySelectorAll('img'));

    const tmplEl = best.els[0].cloneNode(true);
    const tTexts = collectTexts(tmplEl);
    const tImgs = collectImgs(tmplEl);
    const fields = [];
    tTexts.forEach((n, i) => { n.textContent = `{{text${i}}}`; fields.push(`text${i}`); });
    tImgs.forEach((im, i) => { im.setAttribute('src', `{{img${i}}}`); fields.push(`img${i}`); });

    const items = [];
    for (const inst of best.els) {
      const it = collectTexts(inst);
      const im = collectImgs(inst);
      if (it.length !== tTexts.length || im.length !== tImgs.length) continue; // structural mismatch
      const obj = {};
      it.forEach((n, i) => { obj[`text${i}`] = n.textContent.trim(); });
      im.forEach((x, i) => { obj[`img${i}`] = x.getAttribute('src') || ''; });
      items.push(obj);
    }

    return { count: items.length, signature: sigOf(best.els[0]), fields, template: tmplEl.outerHTML, items };
  }

  function toReactList(c) {
    if (!c || !c.items.length) return '';
    const data = JSON.stringify(c.items, null, 2);
    let tmpl = c.template
      .replace(/\bclass=/g, 'className=')
      .replace(/\{\{(\w+)\}\}/g, (_, f) => `{item.${f}}`)
      .replace(/^<([a-zA-Z][\w-]*)/, '<$1 key={i}');
    return `const items = ${data};\n\nexport default function List() {\n  return (\n    <>\n      {items.map((item, i) => (\n        ${tmpl}\n      ))}\n    </>\n  );\n}\n`;
  }

  // ---- Multi-select combine --------------------------------------------------

  // Merge several clone results into one document fragment. CSS blocks are
  // de-duplicated (same site → shared rules) preserving first-seen order.
  function combineClones(clones) {
    const seen = new Set();
    let css = '';
    let html = '';
    for (const clone of clones) {
      for (const block of splitCssBlocks(clone.css || '')) {
        const key = block.replace(/\s+/g, ' ').trim();
        if (key && !seen.has(key)) { seen.add(key); css += block + '\n\n'; }
      }
      html += `<div class="clone-section">\n${clone.html || ''}\n</div>\n`;
    }
    return { css: css.trim() + '\n', html: html.trim() };
  }

  // Split CSS into top-level blocks (rules and at-rules), brace-depth aware.
  function splitCssBlocks(css) {
    const blocks = [];
    let depth = 0;
    let buf = '';
    for (const ch of String(css)) {
      buf += ch;
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) { blocks.push(buf.trim()); buf = ''; }
      }
    }
    if (buf.trim()) blocks.push(buf.trim());
    return blocks;
  }

  const LSC = {
    prettyCss, minifyCss, extractTokens, toJsx, toVue,
    componentize, toReactList, combineClones, splitCssBlocks, VOID_TAGS
  };

  global.LSC = LSC;
  if (typeof module !== 'undefined' && module.exports) module.exports = LSC;
})(typeof window !== 'undefined' ? window : globalThis);
