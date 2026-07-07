export class Extractor {
  constructor() {
    this.defaultStylesCache = new Map();
  }

  async extract(element) {
    // Deep clone the element (preserves original tags, classes, inline styles)
    const clonedElement = element.cloneNode(true);

    // Primary path: pull authored CSS rules that apply to this subtree.
    // Preserves class selectors, shorthand, custom properties, media queries.
    const matchEls = this.getMatchElements(element);
    const source = this.collectSourceStyles(matchEls);

    let css;
    if (source.hasMatches) {
      const vars = this.collectRootVars();
      const rules = this.rewriteCssUrls(source.css);
      const atRules = this.collectAtRules(source.animations, source.fonts, rules);
      css = vars + atRules + rules;
      this.rewriteAssets(clonedElement);
    } else {
      // Fallback: cross-origin sheets or no matched rules — snapshot computed styles.
      css = await this.collectComputedStyles(element, clonedElement);
    }

    this.cleanup(clonedElement);

    return {
      html: clonedElement.outerHTML,
      css,
      tagName: element.tagName.toLowerCase()
    };
  }

  // ---------------------------------------------------------------------------
  // Source-rule extraction (standard practice)
  // ---------------------------------------------------------------------------

  // Subtree elements plus the ancestor chain, so inherited rules
  // (body typography, :root/html custom properties) are captured too.
  getMatchElements(element) {
    const els = this.getAllElements(element);
    let p = element.parentElement;
    while (p) {
      els.push(p);
      p = p.parentElement;
    }
    return els;
  }

  collectSourceStyles(matchEls) {
    const animations = new Set();
    const fonts = new Set();
    const state = { hasMatches: false };
    let css = '';

    for (const sheet of Array.from(document.styleSheets)) {
      let rules;
      try {
        rules = sheet.cssRules;
      } catch (e) {
        // Cross-origin stylesheet — not readable. Skip (best effort).
        continue;
      }
      if (!rules) continue;
      css += this.processRules(rules, matchEls, animations, fonts, state);
    }

    return { css, animations, fonts, hasMatches: state.hasMatches };
  }

  processRules(rules, matchEls, animations, fonts, state) {
    let css = '';

    for (const rule of Array.from(rules)) {
      if (rule.type === CSSRule.STYLE_RULE) {
        const kept = this.matchingSelectors(rule.selectorText, matchEls);
        if (kept.length) {
          state.hasMatches = true;
          css += `${kept.join(',\n')} {\n${this.formatBody(rule.style)}}\n\n`;
          this.recordRefs(rule.style, animations, fonts);
        }
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

  // Keep the authored declaration block: shorthand, custom props, !important
  // are preserved exactly as written (unlike getComputedStyle).
  formatBody(style) {
    let body = '';
    for (let i = 0; i < style.length; i++) {
      const prop = style[i];
      const value = style.getPropertyValue(prop);
      const priority = style.getPropertyPriority(prop) ? ' !important' : '';
      body += `  ${prop}: ${value}${priority};\n`;
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

  matchingSelectors(selectorText, els) {
    const kept = [];
    for (const sel of this.splitSelectors(selectorText)) {
      const test = this.stripPseudo(sel) || '*';
      let ok = false;
      try {
        ok = els.some(el => el.matches(test));
      } catch (e) {
        // Unknown/unsupported selector — keep it rather than lose styling.
        ok = true;
      }
      if (ok) kept.push(sel);
    }
    return kept;
  }

  // Emit :root custom-property definitions so var() references resolve.
  collectRootVars() {
    let vars = '';
    for (const sheet of Array.from(document.styleSheets)) {
      let rules;
      try {
        rules = sheet.cssRules;
      } catch (e) {
        continue;
      }
      if (!rules) continue;
      for (const rule of Array.from(rules)) {
        if (rule.type !== CSSRule.STYLE_RULE) continue;
        if (!/(^|,)\s*(:root|html)\b/.test(rule.selectorText)) continue;
        let body = '';
        for (let i = 0; i < rule.style.length; i++) {
          const prop = rule.style[i];
          if (prop.startsWith('--')) {
            body += `  ${prop}: ${rule.style.getPropertyValue(prop)};\n`;
          }
        }
        if (body) vars += `:root {\n${body}}\n\n`;
      }
    }
    return vars;
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

  // Resolve img/source and inline-style asset URLs to absolute.
  rewriteAssets(root) {
    this.getAllElements(root).forEach(el => {
      if (el.tagName === 'IMG' || el.tagName === 'SOURCE') {
        if (el.getAttribute('src')) el.setAttribute('src', el.src);
        const srcset = el.getAttribute('srcset');
        if (srcset) {
          const resolved = srcset.split(',').map(part => {
            const [url, size] = part.trim().split(/\s+/);
            try {
              const abs = new URL(url, window.location.href).href;
              return size ? `${abs} ${size}` : abs;
            } catch (e) {
              return part.trim();
            }
          });
          el.setAttribute('srcset', resolved.join(', '));
        }
      }
      const inline = el.getAttribute('style');
      if (inline && inline.includes('url(')) {
        el.setAttribute('style', this.rewriteCssUrls(inline));
      }
      if (el.tagName === 'svg') {
        el.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
      }
    });
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

  async collectComputedStyles(originalElement, clonedRoot) {
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

      // Resolve asset URLs to absolute (link, not base64).
      if ((el.tagName === 'IMG' || el.tagName === 'SOURCE') && el.getAttribute('src')) {
        clonedEl.setAttribute('src', el.src);
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
