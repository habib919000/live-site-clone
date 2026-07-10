(async () => {
  console.log('Live Site Clone: Content script initialized');

  // Load modules immediately
  let ElementPicker, Extractor;
  try {
    const pickerMod = await import(chrome.runtime.getURL('src/content/picker.js'));
    const extractorMod = await import(chrome.runtime.getURL('src/content/extractor.js'));
    
    ElementPicker = pickerMod.ElementPicker;
    Extractor = extractorMod.Extractor;
    console.log('Live Site Clone: Modules loaded');
  } catch (err) {
    console.error('Live Site Clone: Failed to load modules', err);
  }

  let picker = null;

  function initPicker() {
    if (!picker && ElementPicker) {
      picker = new ElementPicker(async (element) => {
        const extractor = new Extractor();
        const settings = await chrome.storage.local.get(['inlineAssets', 'multiSelect']);
        const result = await extractor.extract(element, {
          inlineAssets: !!settings.inlineAssets
        });

        // Latest clone drives the single-clone UI.
        const store = { lastClone: result };
        // In multi mode also append to the collected list.
        if (settings.multiSelect) {
          const prev = (await chrome.storage.local.get('lastClones')).lastClones || [];
          prev.push(result);
          store.lastClones = prev;
        }
        await chrome.storage.local.set(store);

        chrome.runtime.sendMessage({ action: 'CLONE_RESULT', data: result });
      });
    }
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    console.log('Live Site Clone: Message received', message);

    if (message.action === 'START_PICKER') {
      // Multi flag arrives with the start message.
      chrome.storage.local.get('multiSelect').then(({ multiSelect }) => {
        if (!picker && ElementPicker) initPicker();
        if (picker) picker.start(!!multiSelect);
      });
      sendResponse({ status: 'picker_started' });
    }
    return true;
  });
})();
