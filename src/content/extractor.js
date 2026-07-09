export class Extractor {
  constructor() {
    this.defaultStylesCache = new Map();
  }

  // CSS properties that inherit — the only ones kept from ancestor-only rules.
  static INHERITED = new Set([
    'color', 'font', 'font-family', 'font-size', 'font-weight', 'font-style',
    'font-variant', 'font-stretch', 'font-feature-settings', 'line-height',
    'letter-spacing', 'word-spacing', 'text-align', 'text-transform',
    'text-indent', 'text-shadow', 'white-space', 'word-break', 'word-wrap',
    'overflow-wrap', 'direction', 'visibility', 'cursor', 'list-style',
    'list-style-type', 'list-style-position', 'tab-size', 'color-scheme',
    '-webkit-font-smoothing', '-moz-osx-font-smoothing'
  ]);

  async extract(element, options = {}) {
    // Tailwind mode: emit utility classes from computed styles, no <style> block.
    if (options && options.mode === 'tailwind') {
      return this.extractTailwind(element);
    }

    // Deep clone the element (preserves original tags, classes, inline styles)
    const clonedElement = element.cloneNode(true);

    const inlineAssets = !!(options && options.inlineAssets);

    // Primary path: pull authored CSS rules that apply to this subtree.
    // Preserves class selectors, shorthand, custom properties, media queries.
    const matchEls = this.getMatchElements(element);
    const source = this.collectSourceStyles(matchEls);

    let css;
    if (source.hasMatches) {
      const rules = this.rewriteCssUrls(source.css);
      // @font-face src / @keyframes urls must be absolutized too.
      const atRules = this.rewriteCssUrls(this.collectAtRules(source.animations, source.fonts, rules));
      // :root/html rules (incl. custom-property defs) are captured by
      // processRules via the '*' match, so var() references resolve.
      css = atRules + rules;
      await this.rewriteAssets(clonedElement, inlineAssets);
    } else {
      // Fallback: cross-origin sheets or no matched rules — snapshot computed styles.
      css = await this.collectComputedStyles(element, clonedElement, inlineAssets);
    }

    if (inlineAssets) css = await this.inlineCssUrls(css);

    // Inline <use>/external SVG references so icons survive standalone.
    await this.inlineSvgRefs(clonedElement);
    this.cleanup(clonedElement);

    return {
      html: clonedElement.outerHTML,
      css,
      tagName: element.tagName.toLowerCase(),
      skippedSheets: source.skippedSheets
    };
  }

  // ---------------------------------------------------------------------------
  // Tailwind export — computed styles mapped to utility classes
  // ---------------------------------------------------------------------------

  async extractTailwind(element) {
    const clone = element.cloneNode(true);
    const originals = this.getAllElements(element);
    const clones = this.getAllElements(clone);

    for (let i = 0; i < originals.length; i++) {
      if (!clones[i]) continue;
      const classes = this.mapComputedToTailwind(originals[i]);
      if (classes.length) clones[i].setAttribute('class', classes.join(' '));
      else clones[i].removeAttribute('class');
      // Drop the original inline styles: utilities are authoritative here, and
      // leftover site styles (e.g. var(--wp--…)) reference undefined variables.
      clones[i].removeAttribute('style');
      clones[i].removeAttribute('data-selector');
      if ((originals[i].tagName === 'IMG' || originals[i].tagName === 'SOURCE') && originals[i].getAttribute('src')) {
        clones[i].setAttribute('src', originals[i].src);
      }
    }

    await this.inlineSvgRefs(clone);
    this.cleanup(clone);

    return {
      html: clone.outerHTML,
      css: '',
      tagName: element.tagName.toLowerCase(),
      framework: 'tailwind',
      skippedSheets: 0
    };
  }

  rgbToHex(value) {
    const m = value.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
    if (!m) return value;
    const h = (n) => (+n).toString(16).padStart(2, '0');
    return `#${h(m[1])}${h(m[2])}${h(m[3])}`;
  }

  isTransparent(value) {
    if (!value || value === 'transparent') return true;
    // Only a 4-component rgba() with alpha 0 is transparent (rgb() never is).
    const m = value.match(/rgba\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+\s*,\s*([\d.]+)\s*\)/);
    return m ? parseFloat(m[1]) === 0 : false;
  }

  mapComputedToTailwind(el) {
    const cs = window.getComputedStyle(el);
    const parent = el.parentElement;
    const pcs = parent ? window.getComputedStyle(parent) : null;
    const v = (p) => cs.getPropertyValue(p).trim();
    // Inherited props (color/font/…) only matter when they differ from the
    // parent — otherwise every node repeats the same text-[…] utilities.
    const inheritedDiffers = (p) => !pcs || pcs.getPropertyValue(p).trim() !== v(p);
    const out = [];
    const px = (val, prefix) => { if (val && val !== '0px') out.push(`${prefix}-[${val}]`); };

    // Display (skip `block` — it's the default for the common block elements
    // and only adds noise; explicit layout modes are what matter).
    const display = v('display');
    const displayMap = {
      flex: 'flex', 'inline-flex': 'inline-flex', grid: 'grid',
      'inline-grid': 'inline-grid', 'inline-block': 'inline-block', none: 'hidden'
    };
    if (displayMap[display]) out.push(displayMap[display]);

    if (display === 'flex' || display === 'inline-flex') {
      if (v('flex-direction') === 'column') out.push('flex-col');
      if (v('flex-wrap') === 'wrap') out.push('flex-wrap');
    }
    if (display.includes('flex') || display.includes('grid')) {
      const ai = { center: 'items-center', 'flex-start': 'items-start', 'flex-end': 'items-end', baseline: 'items-baseline' }[v('align-items')];
      if (ai) out.push(ai);
      const jc = { center: 'justify-center', 'space-between': 'justify-between', 'space-around': 'justify-around', 'flex-end': 'justify-end' }[v('justify-content')];
      if (jc) out.push(jc);
      // gap may be "normal", one length, or "row col"
      const gap = v('gap');
      if (gap && gap !== 'normal') {
        const parts = gap.split(/\s+/);
        if (parts.length === 1) { if (parts[0] !== '0px') out.push(`gap-[${parts[0]}]`); }
        else { if (parts[0] !== '0px') out.push(`gap-y-[${parts[0]}]`); if (parts[1] !== '0px') out.push(`gap-x-[${parts[1]}]`); }
      }
    }

    // Box model. NB: width/height are intentionally NOT emitted — freezing
    // every element to its computed px size collapses the layout.
    const p = ['padding-top', 'padding-right', 'padding-bottom', 'padding-left'].map(v);
    if (p.every(x => x === p[0])) px(p[0], 'p');
    else { px(p[0], 'pt'); px(p[1], 'pr'); px(p[2], 'pb'); px(p[3], 'pl'); }

    const m = ['margin-top', 'margin-right', 'margin-bottom', 'margin-left'].map(v);
    if (m.every(x => x === m[0])) px(m[0], 'm');
    else { px(m[0], 'mt'); px(m[1], 'mr'); px(m[2], 'mb'); px(m[3], 'ml'); }

    // Typography — only when it actually changes from the inherited value.
    if (inheritedDiffers('font-size')) px(v('font-size'), 'text');
    if (inheritedDiffers('font-weight')) {
      const fw = { '700': 'font-bold', '600': 'font-semibold', '500': 'font-medium', '800': 'font-extrabold', '900': 'font-black', '300': 'font-light' }[v('font-weight')];
      if (fw) out.push(fw);
    }
    if (inheritedDiffers('text-align')) {
      const ta = { center: 'text-center', right: 'text-right', justify: 'text-justify' }[v('text-align')];
      if (ta) out.push(ta);
    }
    if (inheritedDiffers('color')) {
      const color = v('color');
      if (color) out.push(`text-[${this.rgbToHex(color)}]`);
    }

    // Background + border
    const bg = v('background-color'); if (!this.isTransparent(bg)) out.push(`bg-[${this.rgbToHex(bg)}]`);
    const br = v('border-top-left-radius'); if (br && br !== '0px') out.push(`rounded-[${br}]`);
    const bw = v('border-top-width');
    if (bw && bw !== '0px') {
      out.push('border');
      out.push(`border-[${this.rgbToHex(v('border-top-color'))}]`);
    }
    const op = v('opacity'); if (op && op !== '1') out.push(`opacity-[${op}]`);

    return out;
  }

  // ---------------------------------------------------------------------------
  // Source-rule extraction (standard practice)
  // ---------------------------------------------------------------------------

  // Split match targets into the selected subtree and its ancestor chain.
  // Subtree rules are copied whole; ancestor rules are reduced to inherited
  // + custom properties only, so parent layout/decoration doesn't leak in.
  getMatchElements(element) {
    const subtree = this.getAllElements(element);
    const ancestors = [];
    let p = element.parentElement;
    while (p) {
      ancestors.push(p);
      p = p.parentElement;
    }
    return { subtree, ancestors };
  }

  collectSourceStyles(matchEls) {
    const animations = new Set();
    const fonts = new Set();
    const state = { hasMatches: false };
    let css = '';
    let skippedSheets = 0;

    for (const sheet of Array.from(document.styleSheets)) {
      let rules;
      try {
        rules = sheet.cssRules;
      } catch (e) {
        // Cross-origin stylesheet — not readable. Count it so the UI can warn.
        skippedSheets++;
        continue;
      }
      if (!rules) continue;
      css += this.processRules(rules, matchEls, animations, fonts, state);
    }

    return { css, animations, fonts, hasMatches: state.hasMatches, skippedSheets };
  }

  processRules(rules, matchEls, animations, fonts, state) {
    let css = '';

    for (const rule of Array.from(rules)) {
      if (rule.type === CSSRule.STYLE_RULE) {
        const { kept, subtreeMatched } = this.matchingSelectors(rule.selectorText, matchEls);
        if (!kept.length) continue;
        const body = subtreeMatched
          ? this.formatBody(rule.style)
          : this.formatInherited(rule.style);
        if (!body) continue;
        // Only a genuine subtree match justifies the primary path over fallback.
        if (subtreeMatched) state.hasMatches = true;
        css += `${kept.join(',\n')} {\n${body}}\n\n`;
        this.recordRefs(rule.style, animations, fonts);
      } else if (rule.type === CSSRule.MEDIA_RULE) {
        const inner = this.processRules(rule.cssRules, matchEls, animations, fonts, state);
        if (inner.trim()) {
          css += `@media ${rule.media.mediaText} {\n${this.indent(inner)}}\n\n`;
        }
      } else if (rule.type === CSSRule.SUPPORTS_RULE) {
        const inner = this.processRules(rule.cssRules, matchEls, animations, fonts, state);
        if (inner.trim()) {
          css += `@supports ${rule.conditionText} {\n${this.indent(inner)}}\n\n`;
        }
      }
    }

    return css;
  }

  // Split a declaration block (cssText) into individual "prop: value" decls.
  // Iterating style[i] can't be used: shorthands whose value contains var()
  // (e.g. `background: var(--x)`) enumerate as empty longhands and lose the
  // value. cssText preserves the authored shorthand + var() + !important.
  splitDeclarations(cssText) {
    return (cssText || '')
      .split(';')
      .map(d => d.trim())
      .filter(Boolean);
  }

  declProp(decl) {
    const i = decl.indexOf(':');
    return i === -1 ? '' : decl.slice(0, i).trim().toLowerCase();
  }

  // Keep the authored declaration block exactly as written.
  formatBody(style) {
    return this.splitDeclarations(style.cssText).map(d => `  ${d};\n`).join('');
  }

  // For ancestor-only matches, keep just what actually cascades down
  // (inherited typography-ish props) plus custom properties (var defs).
  formatInherited(style) {
    let body = '';
    for (const decl of this.splitDeclarations(style.cssText)) {
      const prop = this.declProp(decl);
      if (prop.startsWith('--') || Extractor.INHERITED.has(prop)) {
        body += `  ${decl};\n`;
      }
    }
    return body;
  }

  recordRefs(style, animations, fonts) {
    const anim = style.getPropertyValue('animation-name') || style.getPropertyValue('animation');
    if (anim) {
      anim.split(/[\s,]+/).forEach(token => {
        const t = token.trim();
        if (t) animations.add(t);
      });
    }
    const family = style.getPropertyValue('font-family');
    if (family) {
      family.split(',').forEach(f => {
        const name = f.replace(/['"]/g, '').trim();
        if (name) fonts.add(name);
      });
    }
  }

  // Split a selector list on top-level commas (bracket/paren aware).
  splitSelectors(text) {
    const parts = [];
    let depth = 0;
    let cur = '';
    for (const ch of text) {
      if (ch === '(' || ch === '[') depth++;
      else if (ch === ')' || ch === ']') depth--;
      if (ch === ',' && depth === 0) {
        parts.push(cur.trim());
        cur = '';
      } else {
        cur += ch;
      }
    }
    if (cur.trim()) parts.push(cur.trim());
    return parts;
  }

  // Strip pseudo-classes/elements so :hover/::before/:nth-child rules
  // are still testable against the static DOM.
  stripPseudo(selector) {
    return selector.replace(/::?[a-zA-Z-]+(\([^)]*\))?/g, '').trim();
  }

  // Returns the kept selector fragments and whether any matched the
  // selected subtree (vs. an ancestor only).
  matchingSelectors(selectorText, matchEls) {
    const { subtree, ancestors } = matchEls;
    const kept = [];
    let subtreeMatched = false;

    for (const sel of this.splitSelectors(selectorText)) {
      const test = this.stripPseudo(sel) || '*';
      let inSubtree = false;
      let inAncestor = false;
      try {
        inSubtree = subtree.some(el => el.matches(test));
      } catch (e) {
        inSubtree = false; // malformed test selector — treat as inherited-only
      }
      if (!inSubtree) {
        try {
          inAncestor = ancestors.some(el => el.matches(test));
        } catch (e) {
          inAncestor = false;
        }
      }
      if (inSubtree || inAncestor) {
        kept.push(sel);
        if (inSubtree) subtreeMatched = true;
      }
    }

    return { kept, subtreeMatched };
  }

  // Pull @keyframes / @font-face that the kept rules actually reference.
  collectAtRules(animations, fonts, cssText) {
    let out = '';
    for (const sheet of Array.from(document.styleSheets)) {
      let rules;
      try {
        rules = sheet.cssRules;
      } catch (e) {
        continue;
      }
      if (!rules) continue;
      for (const rule of Array.from(rules)) {
        if (rule.type === CSSRule.KEYFRAMES_RULE && animations.has(rule.name)) {
          out += `${rule.cssText}\n\n`;
        } else if (rule.type === CSSRule.FONT_FACE_RULE) {
          const fam = rule.style.getPropertyValue('font-family').replace(/['"]/g, '').trim();
          if (fonts.has(fam) || cssText.includes(fam)) {
            out += `${rule.cssText}\n\n`;
          }
        }
      }
    }
    return out;
  }

  // Rewrite url(...) in CSS to absolute URLs (link, don't inline base64).
  rewriteCssUrls(css) {
    return css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (match, quote, url) => {
      if (/^(data:|https?:|#|blob:)/.test(url)) return match;
      try {
        return `url("${new URL(url, window.location.href).href}")`;
      } catch (e) {
        return match;
      }
    });
  }

  // Resolve img/source and inline-style asset URLs. When inlineAssets is set,
  // convert images to base64 (portable/offline); otherwise link absolute URLs.
  async rewriteAssets(root, inlineAssets) {
    for (const el of this.getAllElements(root)) {
      if (el.tagName === 'IMG' || el.tagName === 'SOURCE') {
        if (el.getAttribute('src')) {
          const abs = el.src;
          el.setAttribute('src', inlineAssets ? await this.imageToBase64(abs) : abs);
        }
        const srcset = el.getAttribute('srcset');
        if (srcset) {
          const parts = await Promise.all(srcset.split(',').map(async part => {
            const [url, size] = part.trim().split(/\s+/);
            try {
              const abs = new URL(url, window.location.href).href;
              const resolved = inlineAssets ? await this.imageToBase64(abs) : abs;
              return size ? `${resolved} ${size}` : resolved;
            } catch (e) {
              return part.trim();
            }
          }));
          el.setAttribute('srcset', parts.join(', '));
        }
      }
      const inline = el.getAttribute('style');
      if (inline && inline.includes('url(')) {
        let rewritten = this.rewriteCssUrls(inline);
        if (inlineAssets) rewritten = await this.inlineCssUrls(rewritten);
        el.setAttribute('style', rewritten);
      }
      if (el.tagName === 'svg') {
        el.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
      }
    }
  }

  // Replace absolute url(...) references in CSS with base64 data URIs.
  async inlineCssUrls(css) {
    const urls = new Set();
    const re = /url\(\s*"?(https?:\/\/[^"')]+)"?\s*\)/g;
    let m;
    while ((m = re.exec(css)) !== null) urls.add(m[1]);
    for (const url of urls) {
      try {
        const b64 = await this.imageToBase64(url);
        if (b64.startsWith('data:')) css = css.split(url).join(b64);
      } catch (e) { /* leave the absolute URL as a fallback */ }
    }
    return css;
  }

  // Inline SVG <use href>/<image href> that point at external or same-doc
  // symbols, so icons render in the standalone file.
  async inlineSvgRefs(root) {
    for (const el of this.getAllElements(root)) {
      const tag = el.tagName.toLowerCase();
      if (tag !== 'use' && tag !== 'image') continue;
      const ref = el.getAttribute('href') || el.getAttribute('xlink:href');
      if (!ref) continue;

      // Same-document fragment (#icon) — copy the referenced node's guts in.
      if (ref.startsWith('#')) {
        const target = document.querySelector(ref);
        if (target && tag === 'use' && el.parentNode) {
          const frag = target.cloneNode(true);
          frag.removeAttribute('id');
          while (frag.firstChild) el.parentNode.insertBefore(frag.firstChild, el);
          el.remove();
        }
        continue;
      }

      // External file (icons.svg#icon or image.png) — resolve to absolute,
      // and for <image> optionally base64 (handled by inlineAssets elsewhere).
      try {
        const abs = new URL(ref, window.location.href).href;
        if (tag === 'image') {
          el.setAttribute('href', abs);
        } else {
          const [file, frag] = abs.split('#');
          const res = await fetch(file);
          const text = await res.text();
          const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
          const symbol = frag ? doc.getElementById(frag) : doc.querySelector('symbol, svg');
          if (symbol && el.parentNode) {
            const clone = symbol.cloneNode(true);
            clone.removeAttribute('id');
            while (clone.firstChild) el.parentNode.insertBefore(clone.firstChild, el);
            el.remove();
          }
        }
      } catch (e) { /* leave the reference untouched */ }
    }
  }

  async imageToBase64(url) {
    if (!url) return '';
    if (url.startsWith('data:')) return url;
    const absoluteUrl = new URL(url, window.location.href).href;
    try {
      if (absoluteUrl.toLowerCase().split('?')[0].endsWith('.svg')) {
        const res = await fetch(absoluteUrl);
        const text = await res.text();
        return `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(text)))}`;
      }
      return await new Promise((resolve) => {
        const img = new Image();
        img.crossOrigin = 'Anonymous';
        img.onload = () => {
          const canvas = document.createElement('canvas');
          canvas.width = img.naturalWidth;
          canvas.height = img.naturalHeight;
          canvas.getContext('2d').drawImage(img, 0, 0);
          try { resolve(canvas.toDataURL('image/png')); }
          catch (e) { resolve(absoluteUrl); } // tainted canvas (CORS) — fall back
        };
        img.onerror = () => resolve(absoluteUrl);
        img.src = absoluteUrl;
      });
    } catch (e) {
      return absoluteUrl;
    }
  }

  indent(css) {
    return css.replace(/^(?=.)/gm, '  ');
  }

  getAllElements(root) {
    const elements = [];
    const walk = (node) => {
      if (node.nodeType === Node.ELEMENT_NODE) {
        elements.push(node);
        if (node.shadowRoot) {
          Array.from(node.shadowRoot.childNodes).forEach(walk);
        }
      }
      Array.from(node.childNodes).forEach(walk);
    };
    walk(root);
    return elements;
  }

  cleanup(element) {
    const allElements = this.getAllElements(element);
    allElements.forEach(el => {
      if (el.tagName === 'SCRIPT') {
        el.remove();
        return;
      }
      // Remove inline event handlers
      const attrs = el.attributes;
      if (attrs) {
        for (let i = attrs.length - 1; i >= 0; i--) {
          if (attrs[i].name.startsWith('on')) {
            el.removeAttribute(attrs[i].name);
          }
        }
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Computed-style fallback (cross-origin sheets / no matched rules)
  // ---------------------------------------------------------------------------

  async collectComputedStyles(originalElement, clonedRoot, inlineAssets) {
    const originalElements = this.getAllElements(originalElement);
    const clonedElements = this.getAllElements(clonedRoot);

    let cssOutput = '';

    for (let i = 0; i < originalElements.length; i++) {
      const el = originalElements[i];
      const clonedEl = clonedElements[i];
      if (!clonedEl) continue;

      const computed = window.getComputedStyle(el);
      const uniqueId = `dc-${i}`;
      clonedEl.setAttribute('data-dc-id', uniqueId);

      cssOutput += this.getStylesForElement(`[data-dc-id="${uniqueId}"]`, computed, el.tagName);

      for (const pseudo of ['before', 'after']) {
        const pseudoComputed = window.getComputedStyle(el, `:${pseudo}`);
        const content = pseudoComputed.getPropertyValue('content');
        if (content && content !== 'none' && content !== '') {
          cssOutput += this.getStylesForElement(`[data-dc-id="${uniqueId}"]::${pseudo}`, pseudoComputed, el.tagName);
        }
      }

      // Resolve asset URLs (absolute link, or base64 when inlineAssets set).
      if ((el.tagName === 'IMG' || el.tagName === 'SOURCE') && el.getAttribute('src')) {
        clonedEl.setAttribute('src', inlineAssets ? await this.imageToBase64(el.src) : el.src);
      }
      if (el.tagName === 'svg') {
        clonedEl.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
      }
    }

    return this.rewriteCssUrls(cssOutput);
  }

  getStylesForElement(selector, computed, tagName) {
    let elementCss = `${selector} {\n`;
    const defaults = this.getDefaultStyles(tagName);

    const properties = [
      'display', 'position', 'top', 'right', 'bottom', 'left',
      'width', 'height', 'min-width', 'max-width', 'min-height', 'max-height',
      'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
      'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
      'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width',
      'border-top-style', 'border-right-style', 'border-bottom-style', 'border-left-style',
      'border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color',
      'background-color', 'background-image', 'background-size', 'background-position', 'background-repeat',
      'color', 'font-family', 'font-size', 'font-weight', 'line-height', 'text-align',
      'letter-spacing', 'text-transform', 'text-decoration', 'white-space',
      'box-shadow', 'opacity', 'z-index', 'flex-direction', 'flex-wrap', 'flex-grow', 'flex-shrink', 'flex-basis',
      'grid-template-columns', 'grid-template-rows', 'grid-column-start', 'grid-column-end', 'grid-row-start', 'grid-row-end',
      'gap', 'row-gap', 'column-gap', 'align-items', 'justify-content', 'align-content', 'align-self', 'justify-self',
      'border-top-left-radius', 'border-top-right-radius', 'border-bottom-left-radius', 'border-bottom-right-radius',
      'overflow-x', 'overflow-y', 'cursor', 'transition', 'transform', 'content', 'box-sizing',
      'fill', 'stroke', 'stroke-width', 'list-style-type', 'list-style-position',
      'vertical-align', 'text-indent', 'text-overflow', 'visibility', 'object-fit'
    ];

    let hasCustomStyles = false;

    for (const prop of properties) {
      const value = computed.getPropertyValue(prop);
      const defaultValue = defaults[prop];

      const criticalProps = [
        'font-size', 'font-weight', 'line-height', 'text-align',
        'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
        'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
        'display', 'position', 'color', 'background-color', 'box-sizing'
      ];

      const isCritical = criticalProps.includes(prop);
      const isFontFamily = prop === 'font-family';

      let shouldCapture = value !== defaultValue || isFontFamily;

      if (!shouldCapture && isCritical) {
        if (prop.includes('padding') || prop.includes('margin')) {
          if (value !== '0px') shouldCapture = true;
        } else if (prop === 'font-size') {
          shouldCapture = true;
        } else if (prop === 'background-color') {
          if (value !== 'transparent' && value !== 'rgba(0, 0, 0, 0)') shouldCapture = true;
        } else if (prop === 'display') {
          if (value !== 'inline') shouldCapture = true;
        } else {
          shouldCapture = true;
        }
      }

      if (!shouldCapture || !value) continue;

      elementCss += `  ${prop}: ${value};\n`;
      hasCustomStyles = true;
    }

    elementCss += '}\n\n';
    return hasCustomStyles ? elementCss : '';
  }

  getDefaultStyles(tagName) {
    if (this.defaultStylesCache.has(tagName)) {
      return this.defaultStylesCache.get(tagName);
    }

    const dummy = document.createElement(tagName);
    document.body.appendChild(dummy);
    const computed = window.getComputedStyle(dummy);
    const defaults = {};

    const properties = [
      'display', 'position', 'top', 'right', 'bottom', 'left',
      'width', 'height', 'min-width', 'max-width', 'min-height', 'max-height',
      'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
      'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
      'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width',
      'border-top-style', 'border-right-style', 'border-bottom-style', 'border-left-style',
      'border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color',
      'background-color', 'background-image', 'background-size', 'background-position', 'background-repeat',
      'color', 'font-family', 'font-size', 'font-weight', 'line-height', 'text-align',
      'letter-spacing', 'text-transform', 'text-decoration', 'white-space',
      'box-shadow', 'opacity', 'z-index', 'flex-direction', 'flex-wrap', 'flex-grow', 'flex-shrink', 'flex-basis',
      'grid-template-columns', 'grid-template-rows', 'grid-column-start', 'grid-column-end', 'grid-row-start', 'grid-row-end',
      'gap', 'row-gap', 'column-gap', 'align-items', 'justify-content', 'align-content', 'align-self', 'justify-self',
      'border-top-left-radius', 'border-top-right-radius', 'border-bottom-left-radius', 'border-bottom-right-radius',
      'overflow-x', 'overflow-y', 'cursor', 'transition', 'transform', 'content', 'box-sizing',
      'fill', 'stroke', 'stroke-width', 'list-style-type', 'list-style-position',
      'vertical-align', 'text-indent', 'text-overflow', 'visibility', 'object-fit'
    ];

    properties.forEach(prop => {
      defaults[prop] = computed.getPropertyValue(prop);
    });

    document.body.removeChild(dummy);
    this.defaultStylesCache.set(tagName, defaults);
    return defaults;
  }
}
