// popup.js

document.addEventListener("DOMContentLoaded", async () => {
  const vocabCountEl = document.getElementById("vocab-count");
  const todayCountEl = document.getElementById("today-count");
  const summaryKeyEl = document.getElementById("summary-key");
  const summaryLangEl = document.getElementById("summary-lang");
  const btnOpenViewer = document.getElementById("btn-open-viewer");

  // Load words from storage
  chrome.storage.local.get(["vocabList", "settings"], (result) => {
    const vocabList = result.vocabList || [];
    const settings = result.settings || {
      modifierKey: "Alt",
      targetLang: "zh-CN",
      theme: "light"
    };

    // Set theme
    const theme = settings.theme || 'light';
    if (theme === 'light') {
      document.documentElement.setAttribute('data-theme', 'light');
    } else {
      document.documentElement.setAttribute('data-theme', 'dark');
    }

    // Calculate counts
    vocabCountEl.textContent = vocabList.length;
    
    // Count today's words
    const startOfToday = new Date().setHours(0, 0, 0, 0);
    const todayWords = vocabList.filter(item => item.timestamp >= startOfToday);
    todayCountEl.textContent = todayWords.length;

    // Display settings
    summaryKeyEl.textContent = settings.modifierKey || "Alt";
    
    const langMap = {
      "zh-CN": "中文 (简体)",
      "zh-TW": "中文 (繁体)",
      "en": "English",
      "es": "Español",
      "ja": "日本語",
      "fr": "Français",
      "de": "Deutsch"
    };
    summaryLangEl.textContent = langMap[settings.targetLang] || settings.targetLang || "中文 (简体)";
  });

  // Open PDF viewer button click
  btnOpenViewer.addEventListener("click", () => {
    chrome.tabs.create({ url: chrome.runtime.getURL("pdfjs-viewer/web/viewer.html") });
  });
});
