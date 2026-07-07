document.addEventListener('DOMContentLoaded', async () => {
  const startBtn = document.getElementById('start-btn');
  const resetBtn = document.getElementById('reset-btn');
  const initialState = document.getElementById('initial-state');
  const resultContainer = document.getElementById('result-container');
  const tagNameSpan = document.getElementById('tag-name');
  const copyHtmlBtn = document.getElementById('copy-html');
  const copyCssBtn = document.getElementById('copy-css');
  const copyJsxBtn = document.getElementById('copy-jsx');
  const copyVueBtn = document.getElementById('copy-vue');
  const downloadBtn = document.getElementById('download-btn');
  const copyCodeBtn = document.getElementById('copy-code');
  const tokensToggle = document.getElementById('opt-tokens');
  const minifyToggle = document.getElementById('opt-minify');
  const inlineToggle = document.getElementById('opt-inline');
  const warnBanner = document.getElementById('cross-origin-warn');

  let lastResult = null;

  // Restore persisted options.
  const opts = await chrome.storage.local.get(['inlineAssets', 'useTokens', 'minify']);
  tokensToggle.checked = opts.useTokens !== false; // default on
  minifyToggle.checked = !!opts.minify;            // default off
  inlineToggle.checked = !!opts.inlineAssets;      // default off

  tokensToggle.addEventListener('change', () => chrome.storage.local.set({ useTokens: tokensToggle.checked }));
  minifyToggle.addEventListener('change', () => chrome.storage.local.set({ minify: minifyToggle.checked }));
  inlineToggle.addEventListener('change', () => chrome.storage.local.set({ inlineAssets: inlineToggle.checked }));

  // Apply the post-processing pipeline (tokens → pretty/minify) to the CSS.
  function processedCss() {
    let css = lastResult.css || '';
    if (tokensToggle.checked) css = LSC.extractTokens(css);
    return minifyToggle.checked ? LSC.minifyCss(css) : LSC.prettyCss(css);
  }

  // Load last result from storage
  async function loadResult() {
    const storage = await chrome.storage.local.get('lastClone');
    if (storage.lastClone) {
      lastResult = storage.lastClone;
      tagNameSpan.textContent = `<${lastResult.tagName.toLowerCase()}>`;
      const skipped = lastResult.skippedSheets || 0;
      if (skipped > 0) {
        warnBanner.textContent = `⚠ ${skipped} cross-origin stylesheet${skipped > 1 ? 's' : ''} could not be read — some styles may be missing or approximated.`;
        warnBanner.classList.remove('hidden');
      } else {
        warnBanner.classList.add('hidden');
      }
      initialState.classList.add('hidden');
      resultContainer.classList.remove('hidden');
    } else {
      initialState.classList.remove('hidden');
      resultContainer.classList.add('hidden');
    }
  }

  await loadResult();

  // Listen for storage changes to update UI in real-time if popup is open
  chrome.storage.onChanged.addListener((changes) => {
    if (changes.lastClone) {
      loadResult();
    }
  });

  async function startPicker() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['src/content/index.js']
      });
    } catch (e) {
      // Script might already be there
    }

    chrome.tabs.sendMessage(tab.id, { action: 'START_PICKER' });
    // No longer closing the window, as this is now a side panel
  }

  startBtn.addEventListener('click', startPicker);
  resetBtn.addEventListener('click', async () => {
    await chrome.storage.local.remove('lastClone');
    startPicker();
  });

  copyHtmlBtn.addEventListener('click', () => {
    if (lastResult) {
      copyToClipboard(lastResult.html);
      showFeedback(copyHtmlBtn, 'HTML');
    }
  });

  copyCssBtn.addEventListener('click', () => {
    if (lastResult) {
      copyToClipboard(processedCss());
      showFeedback(copyCssBtn, 'CSS');
    }
  });

  copyJsxBtn.addEventListener('click', () => {
    if (!lastResult) return;
    const jsx = `export default function ClonedComponent() {\n  return (\n${LSC.toJsx(lastResult.html)}\n  );\n}`;
    copyToClipboard(jsx);
    showFeedback(copyJsxBtn, 'JSX');
  });

  copyVueBtn.addEventListener('click', () => {
    if (!lastResult) return;
    const css = tokensToggle.checked ? LSC.extractTokens(lastResult.css) : lastResult.css;
    copyToClipboard(LSC.toVue(lastResult.html, css));
    showFeedback(copyVueBtn, 'Vue');
  });

  // Assemble the standalone HTML document from the last clone result.
  async function buildFullHtml() {
    let iconBase64 = '';
    try {
      const response = await fetch(chrome.runtime.getURL('assets/icons/icon128.png'));
      const blob = await response.blob();
      iconBase64 = await new Promise((resolve) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result);
        reader.readAsDataURL(blob);
      });
    } catch (e) {
      console.error('Failed to load icon:', e);
    }

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Cloned ${lastResult.tagName}</title>
  ${iconBase64 ? `<link rel="icon" type="image/png" href="${iconBase64}">` : ''}
  <style>
${processedCss()}
  </style>
</head>
<body>
${lastResult.html}
</body>
</html>`;
  }

  downloadBtn.addEventListener('click', async () => {
    if (!lastResult) return;
    const fullHtml = await buildFullHtml();
    const blob = new Blob([fullHtml], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `cloned-${lastResult.tagName.toLowerCase()}.html`;
    a.click();
    URL.revokeObjectURL(url);
  });

  copyCodeBtn.addEventListener('click', async () => {
    if (!lastResult) return;
    const fullHtml = await buildFullHtml();
    copyToClipboard(fullHtml);
    showFeedback(copyCodeBtn, 'Code');
  });

  function copyToClipboard(text) {
    const el = document.createElement('textarea');
    el.value = text;
    document.body.appendChild(el);
    el.select();
    document.execCommand('copy');
    document.body.removeChild(el);
  }

  function showFeedback(btn, label) {
    const originalContent = btn.innerHTML;
    btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg> Copied!`;
    const originalBg = btn.style.background;
    const originalColor = btn.style.color;
    
    btn.style.background = '#dcfce7';
    btn.style.color = '#166534';
    
    setTimeout(() => {
      btn.innerHTML = originalContent;
      btn.style.background = originalBg;
      btn.style.color = originalColor;
    }, 2000);
  }
});
