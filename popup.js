// popup.js - ReadFlow PDF v2.0

document.addEventListener("DOMContentLoaded", async () => {
  const vocabCountEl = document.getElementById("vocab-count");
  const todayCountEl = document.getElementById("today-count");
  const summaryKeyEl = document.getElementById("summary-key");
  const summaryLangEl = document.getElementById("summary-lang");
  const summaryStartupEl = document.getElementById("summary-startup");
  const btnOpenLibrary = document.getElementById("btn-open-library");
  const btnOpenViewer = document.getElementById("btn-open-viewer");

  chrome.storage.local.get(["vocabList", "settings"], (result) => {
    const vocabList = result.vocabList || [];
    const settings = result.settings || {
      modifierKey: "Alt",
      targetLang: "zh-CN",
      theme: "light",
      startupBehavior: "library"
    };

    // Apply theme
    const theme = settings.theme || 'light';
    document.documentElement.setAttribute('data-theme', theme === 'light' ? 'light' : 'dark');

    // Apply accent color if custom
    if (settings.accentHue !== undefined) {
      const h = settings.accentHue;
      const s = settings.accentSaturation || 75;
      document.documentElement.style.setProperty('--primary', `hsl(${h}, ${s}%, 42%)`);
      document.documentElement.style.setProperty('--primary-gradient',
        `linear-gradient(135deg, hsl(${h}, ${s}%, 38%) 0%, hsl(${h}, ${s + 5}%, 52%) 100%)`);
    }

    // Counts
    vocabCountEl.textContent = vocabList.length;
    const startOfToday = new Date().setHours(0, 0, 0, 0);
    const todayWords = vocabList.filter(item => item.timestamp >= startOfToday);
    todayCountEl.textContent = todayWords.length;

    // Settings summary
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

    const startupMap = {
      'library': '进入书架',
      'reopen': '重新打开上次文件'
    };
    if (summaryStartupEl) {
      summaryStartupEl.textContent = startupMap[settings.startupBehavior] || '进入书架';
    }
  });

  // Library button
  if (btnOpenLibrary) {
    btnOpenLibrary.addEventListener("click", () => {
      chrome.tabs.create({ url: chrome.runtime.getURL("library.html") });
    });
  }

  // Direct viewer button
  if (btnOpenViewer) {
    btnOpenViewer.addEventListener("click", () => {
      chrome.tabs.create({ url: chrome.runtime.getURL("pdfjs-viewer/web/viewer.html") });
    });
  }
});
