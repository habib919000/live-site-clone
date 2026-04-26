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
        const result = await extractor.extract(element);
        
        // Save to storage so popup can read it
        await chrome.storage.local.set({ lastClone: result });
        
        // Notify background as well
        chrome.runtime.sendMessage({
          action: 'CLONE_RESULT',
          data: result
        });
        
        // Removed the alert to provide a smoother UX
      });
    }
    if (picker) picker.start();
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    console.log('Live Site Clone: Message received', message);
    
    if (message.action === 'START_PICKER') {
      initPicker();
      sendResponse({ status: 'picker_started' });
    }
    return true;
  });
})();
