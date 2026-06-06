// background.js

// Keep track of tabs being redirected to avoid loops
const redirectingTabs = new Set();

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  // We look for URL changes
  if (changeInfo.url) {
    const url = changeInfo.url;
    
    // Ignore if this is already our viewer
    const viewerUrl = chrome.runtime.getURL("pdfjs-viewer/web/viewer.html");
    if (url.startsWith(viewerUrl)) {
      return;
    }

    // Check if the URL is a PDF file
    if (isPdfUrl(url)) {
      // Prevent recursive updates for the same tab URL
      if (redirectingTabs.has(tabId)) {
        redirectingTabs.delete(tabId);
        return;
      }

      // Mark tab as redirecting
      redirectingTabs.add(tabId);

      const targetUrl = `${viewerUrl}?file=${encodeURIComponent(url)}`;
      chrome.tabs.update(tabId, { url: targetUrl });
    }
  }
});

function isPdfUrl(url) {
  try {
    const parsedUrl = new URL(url);
    const pathname = parsedUrl.pathname.toLowerCase();
    
    // Direct checks
    if (pathname.endsWith('.pdf')) {
      return true;
    }
    
    // File URLs ending with .pdf
    if (url.startsWith('file://') && url.toLowerCase().includes('.pdf')) {
      // Ensure it's not a directory or other resource
      return url.toLowerCase().endsWith('.pdf') || url.toLowerCase().split('?')[0].endsWith('.pdf');
    }

    // Google Drive PDF viewer or other patterns
    // If it has a PDF extension anywhere in the path prior to queries
    const cleanPath = pathname.split('?')[0];
    if (cleanPath.endsWith('.pdf')) {
      return true;
    }

    return false;
  } catch (e) {
    // If URL parsing fails, do a basic string check
    const lower = url.toLowerCase();
    return lower.endsWith('.pdf') || lower.includes('.pdf?') || lower.includes('.pdf#');
  }
}
