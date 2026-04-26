export class Extractor {
  constructor() {
    this.defaultStylesCache = new Map();
  }

  async extract(element) {
    // Deep clone the element
    const clonedElement = element.cloneNode(true);
    
    // Collect and resolve styles
    const styles = await this.collectStyles(element, clonedElement);
    
    // Cleanup the cloned element
    this.cleanup(clonedElement);

    return {
      html: clonedElement.outerHTML,
      css: styles,
      tagName: element.tagName.toLowerCase()
    };
  }

  async collectStyles(originalElement, clonedRoot) {
    const originalElements = this.getAllElements(originalElement);
    const clonedElements = this.getAllElements(clonedRoot);
    
    let cssOutput = '';
    
    for (let i = 0; i < originalElements.length; i++) {
      const el = originalElements[i];
      const clonedEl = clonedElements[i];
      
      // If the cloned element doesn't exist (e.g. shadow root mismatch), skip
      if (!clonedEl) continue;

      const computed = window.getComputedStyle(el);
      const uniqueId = `dc-${i}`;
      
      clonedEl.setAttribute('data-dc-id', uniqueId);
      
      // Process element styles
      cssOutput += await this.getStylesForElement(`[data-dc-id="${uniqueId}"]`, computed, el.tagName);
      
      // Handle pseudo-elements
      for (const pseudo of ['before', 'after']) {
        const pseudoComputed = window.getComputedStyle(el, `:${pseudo}`);
        const content = pseudoComputed.getPropertyValue('content');
        if (content && content !== 'none' && content !== '') {
          cssOutput += await this.getStylesForElement(`[data-dc-id="${uniqueId}"]::${pseudo}`, pseudoComputed, el.tagName, true);
        }
      }

      // Special handling for <img> and <source> tags
      if ((el.tagName === 'IMG' || el.tagName === 'SOURCE') && (el.src || el.srcset)) {
        try {
          if (el.src) {
            const base64 = await this.imageToBase64(el.src);
            clonedEl.setAttribute('src', base64);
          }
          if (el.srcset) {
            const srcsetParts = el.srcset.split(',').map(part => part.trim());
            const resolvedParts = await Promise.all(srcsetParts.map(async part => {
              const [url, size] = part.split(/\s+/);
              try {
                const b64 = await this.imageToBase64(url);
                return size ? `${b64} ${size}` : b64;
              } catch (e) {
                return part;
              }
            }));
            clonedEl.setAttribute('srcset', resolvedParts.join(', '));
          }
        } catch (e) {
          console.warn('Failed to convert image/srcset to base64:', el.src || el.srcset);
        }
      }

      // Handle inline <svg>
      if (el.tagName === 'svg') {
        clonedEl.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
      }
    }

    return cssOutput;
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

  async getStylesForElement(selector, computed, tagName, isPseudo = false) {
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
      let value = computed.getPropertyValue(prop);
      const defaultValue = defaults[prop];

      // List of properties that should almost always be captured if they have a meaningful value
      const criticalProps = [
        'font-size', 'font-weight', 'line-height', 'text-align',
        'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
        'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
        'display', 'position', 'color', 'background-color', 'box-sizing'
      ];

      const isCritical = criticalProps.includes(prop);
      const isFontFamily = prop === 'font-family';

      // Capture if:
      // 1. It's different from default
      // 2. It's a critical property and has a meaningful value (not 0px, not transparent, etc.)
      // 3. It's font-family
      
      let shouldCapture = value !== defaultValue || isFontFamily;

      if (!shouldCapture && isCritical) {
        if (prop.includes('padding') || prop.includes('margin')) {
          if (value !== '0px') shouldCapture = true;
        } else if (prop === 'font-size') {
          shouldCapture = true; // Always capture font size to be safe
        } else if (prop === 'background-color') {
          if (value !== 'transparent' && value !== 'rgba(0, 0, 0, 0)') shouldCapture = true;
        } else if (prop === 'display') {
          if (value !== 'inline') shouldCapture = true;
        } else {
          shouldCapture = true;
        }
      }

      if (!shouldCapture) continue;
      
      if (value) {
        // Handle background-image Base64 conversion (multiple URLs support)
        if (prop === 'background-image' && value.includes('url(')) {
          const urls = value.match(/url\(['"]?(.*?)['"]?\)/g);
          if (urls) {
            for (const urlMatch of urls) {
              const url = urlMatch.match(/url\(['"]?(.*?)['"]?\)/)[1];
              if (url && !url.startsWith('data:')) {
                try {
                  const base64 = await this.imageToBase64(url);
                  value = value.replace(urlMatch, `url("${base64}")`);
                } catch (e) {
                  // Fallback to absolute URL
                  const absoluteUrl = new URL(url, window.location.href).href;
                  value = value.replace(urlMatch, `url("${absoluteUrl}")`);
                }
              }
            }
          }
        }
        elementCss += `  ${prop}: ${value};\n`;
        hasCustomStyles = true;
      }
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

  async imageToBase64(url) {
    if (!url) return '';
    if (url.startsWith('data:')) return url;

    // Resolve relative URLs
    const absoluteUrl = new URL(url, window.location.href).href;

    try {
      // For SVGs, try to fetch as text first to handle them more cleanly
      if (absoluteUrl.toLowerCase().endsWith('.svg')) {
        const response = await fetch(absoluteUrl);
        const text = await response.text();
        return `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(text)))}`;
      }

      // For other images, use canvas
      return new Promise((resolve, reject) => {
        const img = new Image();
        img.crossOrigin = 'Anonymous';
        img.onload = () => {
          const canvas = document.createElement('canvas');
          canvas.width = img.width;
          canvas.height = img.height;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0);
          try {
            resolve(canvas.toDataURL('image/png'));
          } catch (e) {
            // If canvas fails (CORS), resolve with absolute URL as fallback
            resolve(absoluteUrl);
          }
        };
        img.onerror = () => resolve(absoluteUrl); // Fallback to absolute URL
        img.src = absoluteUrl;
      });
    } catch (e) {
      return absoluteUrl;
    }
  }

  cleanup(element) {
    const allElements = this.getAllElements(element);
    allElements.forEach(el => {
      if (el.tagName === 'SCRIPT') {
        el.remove();
        return;
      }
      
      // Remove event handlers
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
}
