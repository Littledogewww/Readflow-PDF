// background.js - ReadFlow PDF v2.0

// Keep track of tabs being redirected to avoid loops
const redirectingTabs = new Set();

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url) {
    const url = changeInfo.url;

    const viewerUrl = chrome.runtime.getURL("pdfjs-viewer/web/viewer.html");
    const libraryUrl = chrome.runtime.getURL("library.html");

    // Ignore our own pages
    if (url.startsWith(viewerUrl) || url.startsWith(libraryUrl)) {
      return;
    }

    if (isPdfUrl(url)) {
      if (redirectingTabs.has(tabId)) {
        redirectingTabs.delete(tabId);
        return;
      }
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

    if (pathname.endsWith('.pdf')) return true;

    if (url.startsWith('file://') && url.toLowerCase().includes('.pdf')) {
      return url.toLowerCase().endsWith('.pdf') || url.toLowerCase().split('?')[0].endsWith('.pdf');
    }

    const cleanPath = pathname.split('?')[0];
    if (cleanPath.endsWith('.pdf')) return true;

    return false;
  } catch (e) {
    const lower = url.toLowerCase();
    return lower.endsWith('.pdf') || lower.includes('.pdf?') || lower.includes('.pdf#');
  }
}
