// Background service worker
chrome.runtime.onInstalled.addListener(() => {
  console.log('Live Site Clone: Extension installed');
  
  // Set behavior to open side panel on click
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
    .catch((error) => console.error(error));
});

// Listen for messages from content scripts or popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'CLONE_RESULT') {
    // We could handle server-side storage or other background tasks here
    console.log('Received clone result in background:', message.data.tagName);
    
    // Persist to local storage for the popup to see later
    chrome.storage.local.set({ lastClone: message.data });
  }
});
