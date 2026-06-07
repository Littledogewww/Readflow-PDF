// extension_glue.js

// Immediate URL cleanup to prevent PDF.js from loading expired blob URLs on page refresh
(function() {
  try {
    const url = new URL(window.location.href);
    if (url.searchParams.has('bookId') && url.searchParams.has('file')) {
      url.searchParams.delete('file');
      window.history.replaceState({}, '', url.toString());
    }
  } catch (e) {
    console.warn('[ReadFlow] URL cleanup failed:', e);
  }
})();

// --- Global State ---
let vocabList = [];
let settings = {
  modifierKey: 'Alt',
  targetLang: 'zh-CN',
  translationProvider: 'google',
  geminiApiKey: '',
  geminiModel: 'gemini-1.5-flash',
  dockPosition: 'right',
  sidebarWidth: 380,
  sidebarHeight: 300,
  sidebarOpen: false,
  cardDetailMode: 'contextual',
  toggleShortcutModifier: 'Alt',
  toggleShortcutKey: 'b',
  alwaysTranslate: false,
  theme: 'light',
  // v2.0 new fields
  accentHue: 20,
  accentSaturation: 75,
  startupBehavior: 'library',
  customAiBaseUrl: '',
  customAiKey: '',
  customAiModel: 'deepseek-chat',
  customAiPrompt: 'You are a professional academic translator and contextual dictionary.\nTranslate the term "{word}" from its academic context into {targetLang}.\n\nContext sentence: "{context}"\n\nRules:\n1. Provide the most precise translation that fits the academic/technical context\n2. If it is an English term, also provide: [part of speech] phonetic (if applicable)\n3. Add a brief academic definition (1 sentence max)\n4. Format: Translation | [optional: phonetic] | [optional: definition]\n5. Response must be concise, dictionary-style. No markdown, no extra explanation.',
  // v2.1 new fields
  bgStyle: 'solid',
  accentHueEnd: 200,
};
let toastTimeout = null;

// Target language code mapping for human display
const LANG_NAMES = {
  'zh-CN': 'Chinese (Simplified)',
  'zh-TW': 'Chinese (Traditional)',
  'en': 'English',
  'es': 'Spanish',
  'ja': 'Japanese',
  'fr': 'French',
  'de': 'German'
};

// Elements that will be created dynamically
let sidebar = null;
let vocabListContainer = null;
let sidebarBadge = null;
let searchInput = null;
let selectScope = null;
let selectSort = null;
let setModifier = null;
let setLang = null;
let setProvider = null;
let setAiKey = null;
let setAiModel = null;
let aiSettingsGroup = null;
let setCardMode = null;
let setTheme = null;
let setAlwaysTranslate = null;
let setToggleShortcutModifier = null;
let setToggleShortcutKey = null;
// v2.0 new elements
let setAccentHue = null;
let setStartupBehavior = null;
let setCustomAiBaseUrl = null;
let setCustomAiKey = null;
let setCustomAiModel = null;
let setCustomAiPrompt = null;
let customAiSettingsGroup = null;
// v2.1 new elements
let setBgStyle = null;
let setAccentHueEnd = null;
let customColorSettingsSubgroup = null;
let settingAccentHueEndRow = null;

// --- Initialize when DOM is loaded ---
document.addEventListener('DOMContentLoaded', async () => {
  // 1. Load settings & vocabulary database
  await loadExtensionData();

  // 2. Build and inject Sidebar DOM
  injectSidebarDOM();

  // 3. Inject Toggle Button to PDF.js Toolbar
  injectToolbarButton();

  // 4. Setup Event Listeners
  setupExtensionEventListeners();

  // 5. Initialize Drag Resizer
  initResizer();

  // Apply theme on load
  applyTheme();

  // Initialize welcome overlay if needed
  initWelcomeOverlay();

  // 6. Polling listener to bind to PDF.js native EventBus when initialized
  const checkInterval = setInterval(() => {
    if (window.PDFViewerApplication && window.PDFViewerApplication.eventBus) {
      clearInterval(checkInterval);
      
      // Hook native resize/sidebar toggle changes to update our layouts
      window.addEventListener('resize', (e) => {
        if (e.isTrusted) {
          updateLayout();
        }
      });
      window.PDFViewerApplication.eventBus.on('sidebarviewchanged', () => {
        setTimeout(updateLayout, 50);
      });
      window.PDFViewerApplication.eventBus.on('pagesinit', async () => {
        hideWelcomeOverlay();
        
        // Restore last read page
        const urlParams = new URLSearchParams(window.location.search);
        const bookId = urlParams.get('bookId');
        if (bookId) {
          try {
            const db = await openLibraryDB();
            const tx = db.transaction(LIB_STORE_NAME, 'readonly');
            const store = tx.objectStore(LIB_STORE_NAME);
            const entry = await new Promise((resolve) => {
              const req = store.get(bookId);
              req.onsuccess = () => resolve(req.result);
              req.onerror = () => resolve(null);
            });
            if (entry && entry.lastReadPage && entry.lastReadPage > 1) {
              window.PDFViewerApplication.page = entry.lastReadPage;
            }
          } catch (err) {
            console.error('[ReadFlow] Failed to restore page:', err);
          }
        }
      });

      // Auto save page on page changing
      window.PDFViewerApplication.eventBus.on('pagechanging', (e) => {
        const urlParams = new URLSearchParams(window.location.search);
        const bookId = urlParams.get('bookId');
        if (bookId && e.pageNumber) {
          saveLastReadPage(bookId, e.pageNumber);
        }
      });

      // Load book from library if bookId is present in url
      const urlParams = new URLSearchParams(window.location.search);
      const bookId = urlParams.get('bookId');
      if (bookId) {
        loadBookFromLibrary(bookId);
      }
      
      // Initial Layout Update
      updateLayout();
    }
  }, 100);
});

// --- Data Loading & Storage ---
async function loadExtensionData() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['vocabList', 'settings'], (result) => {
      if (result.vocabList) {
        vocabList = migrateVocabData(result.vocabList);
      }
      if (result.settings) {
        settings = { ...settings, ...result.settings };
      }
      resolve();
    });
  });
}

/**
 * v3.0 Data Migration: Convert old flat vocab entries to word-centric format.
 * Old format: each entry has `context` (string), `page`, `charOffset`, `length`
 * New format: each entry has `contexts` (array of { sentence, page, charOffset, length, addedAt })
 * Entries with same word + source_pdf are merged into one.
 */
function migrateVocabData(rawList) {
  if (!rawList || rawList.length === 0) return rawList;

  // Check if already migrated: look for `contexts` array on first item
  if (rawList[0].contexts && Array.isArray(rawList[0].contexts)) {
    return rawList; // Already in v3 format
  }

  // Check if it's old format: has `context` string but no `contexts` array
  const needsMigration = rawList.some(item => typeof item.context === 'string' && !item.contexts);
  if (!needsMigration) return rawList;

  console.log('[ReadFlow] Migrating vocab data from v2 to v3 format...');

  // Group by {source_pdf}__{word.toLowerCase()}
  const groups = new Map();
  for (const item of rawList) {
    const key = `${item.source_pdf}__${item.word.toLowerCase()}`;
    if (!groups.has(key)) {
      groups.set(key, {
        id: key,
        word: item.word,
        translation: item.translation,
        phonetic: item.phonetic || '',
        source_pdf: item.source_pdf,
        lookups: item.lookups || 1,
        timestamp: item.timestamp || Date.now(),
        contexts: []
      });
    }
    const group = groups.get(key);
    // Take the most recent translation and highest lookups
    if (item.timestamp > group.timestamp) {
      group.timestamp = item.timestamp;
      group.translation = item.translation;
    }
    if ((item.lookups || 1) > group.lookups) {
      group.lookups = item.lookups;
    }
    // Add context as a sentence entry (deduplicate by sentence text)
    const sentence = (item.context || '').trim();
    if (sentence && !group.contexts.some(c => c.sentence === sentence)) {
      group.contexts.push({
        sentence,
        page: item.page,
        charOffset: item.charOffset || 0,
        length: item.length || item.word.length,
        addedAt: item.timestamp || Date.now()
      });
    }
  }

  const migrated = Array.from(groups.values());
  console.log(`[ReadFlow] Migration complete: ${rawList.length} entries → ${migrated.length} word cards`);

  // Persist migrated data
  chrome.storage.local.set({ vocabList: migrated });
  return migrated;
}

function updateBadgeCount() {
  if (!sidebarBadge) return;
  let list = vocabList;
  if (selectScope && selectScope.value === 'current') {
    const currentPdf = getCurrentPdfName();
    list = vocabList.filter(item => item.source_pdf === currentPdf);
  }
  sidebarBadge.textContent = list.length;
}

// --- DOM Injections ---
function injectSidebarDOM() {
  const outerContainer = document.getElementById('outerContainer');
  if (!outerContainer) return;

  sidebar = document.createElement('aside');
  sidebar.id = 'sidebar';
  
  sidebar.innerHTML = `
    <!-- Resizer Divider Handle -->
    <div id="sidebar-resizer" class="sidebar-resizer"></div>

    <div class="sidebar-header">
      <div class="sidebar-tabs">
        <button id="tab-vocab" class="tab-btn active" aria-label="词汇列表">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="pointer-events: none;">
            <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"></path>
            <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"></path>
          </svg>
          <span>词汇列表</span>
        </button>
        <button id="tab-settings" class="tab-btn" aria-label="参数设置">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="pointer-events: none;">
            <circle cx="12" cy="12" r="3"></circle>
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
          </svg>
          <span>参数设置</span>
        </button>
      </div>
      
      <!-- Docking Controls -->
      <div class="sidebar-dock-controls" style="display: flex; gap: 4px; margin-left: auto; margin-right: 10px; align-items: center;">
        <button id="btn-dock-left" class="dock-btn" title="靠左停靠" aria-label="靠左停靠">
          <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor"><rect x="1" y="1" width="4" height="14" rx="0.5" fill="currentColor" opacity="0.9"/><rect x="6" y="1" width="9" height="14" rx="0.5" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>
        </button>
        <button id="btn-dock-bottom" class="dock-btn" title="靠下停靠" aria-label="靠下停靠">
          <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor"><rect x="1" y="11" width="14" height="4" rx="0.5" fill="currentColor" opacity="0.9"/><rect x="1" y="1" width="14" height="9" rx="0.5" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>
        </button>
        <button id="btn-dock-right" class="dock-btn" title="靠右停靠" aria-label="靠右停靠">
          <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor"><rect x="11" y="1" width="4" height="14" rx="0.5" fill="currentColor" opacity="0.9"/><rect x="1" y="1" width="9" height="14" rx="0.5" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>
        </button>
      </div>

      <button id="btn-close-sidebar" class="close-btn" title="关闭侧边栏" aria-label="关闭侧边栏">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="pointer-events: none;">
          <line x1="18" y1="6" x2="6" y2="18"></line>
          <line x1="6" y1="6" x2="18" y2="18"></line>
        </svg>
      </button>
    </div>

    <!-- Tab Content: Vocab List -->
    <div id="sidebar-vocab-pane" class="tab-pane active">
      <div class="pane-actions">
        <div class="search-input-wrapper">
          <span class="search-icon">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="11" cy="11" r="8"></circle>
              <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
            </svg>
          </span>
          <input type="text" id="search-input" placeholder="搜索已收集的词汇..." class="search-input">
        </div>
        <div class="filter-row">
          <select id="select-scope" class="filter-select" aria-label="搜索范围">
            <option value="current">当前 PDF</option>
            <option value="all">所有 PDF</option>
          </select>
          <select id="select-sort" class="filter-select" aria-label="排序方式">
            <option value="time-desc">最新添加</option>
            <option value="time-asc">最早添加</option>
            <option value="lookups-desc">查询次数 ⬇</option>
            <option value="alpha">字母 A-Z</option>
          </select>
        </div>
      </div>

      <div id="vocab-list-container" class="vocab-list-container">
        <div class="empty-state">
          <svg viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="opacity: 0.4;">
            <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"></path>
            <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"></path>
          </svg>
          <p>暂无收集词汇</p>
        </div>
      </div>

      <div class="sidebar-footer">
        <button id="btn-export-csv" class="footer-btn">导出 CSV</button>
        <button id="btn-export-anki" class="footer-btn primary-btn">导出 Anki (TSV)</button>
      </div>
    </div>

    <!-- Tab Content: Settings -->
    <div id="sidebar-settings-pane" class="tab-pane">
      <div class="settings-group">
        <h3>取词与快捷键</h3>
        <div class="setting-row">
          <label for="setting-modifier">快捷修饰键</label>
          <select id="setting-modifier" class="setting-select">
            <option value="Alt">Alt 键 (推荐)</option>
            <option value="Ctrl">Ctrl 键</option>
            <option value="Shift">Shift 键</option>
            <option value="None">无 (直接选词)</option>
          </select>
        </div>
        <div class="setting-row" style="margin-top: 10px;">
          <label for="setting-always-translate">无修饰键直接选词</label>
          <input type="checkbox" id="setting-always-translate" class="setting-checkbox" style="width: auto; cursor: pointer;">
        </div>
        <div class="setting-row" style="margin-top: 10px;">
          <label for="setting-toggle-shortcut-modifier">快捷键切换直接选词</label>
          <div style="display: flex; gap: 6px; align-items: center;">
            <select id="setting-toggle-shortcut-modifier" class="setting-select" style="min-width: 60px; max-width: 80px; padding: 4px;">
              <option value="Alt">Alt</option>
              <option value="Ctrl">Ctrl</option>
              <option value="Shift">Shift</option>
              <option value="None">无</option>
            </select>
            <span style="font-size: 11px; color: var(--text-muted);">+</span>
            <input type="text" id="setting-toggle-shortcut-key" class="setting-input-text" style="width: 55px; text-align: center; cursor: pointer; text-transform: uppercase; padding: 4px;" readonly placeholder="按键...">
          </div>
        </div>
        <p class="setting-help">按住修饰键并双击单词或划选文本将触发收集。您也可以使用设定的快捷键一键开启/关闭“无需修饰键直接选词”。</p>
      </div>

      <div class="settings-group">
        <h3>翻译设置</h3>
        <div class="setting-row">
          <label for="setting-lang">目标翻译语言</label>
          <select id="setting-lang" class="setting-select">
            <option value="zh-CN">中文 (简体)</option>
            <option value="zh-TW">中文 (繁体)</option>
            <option value="en">English (Definitions)</option>
            <option value="es">Español</option>
            <option value="ja">日本語</option>
            <option value="fr">Français</option>
            <option value="de">Deutsch</option>
          </select>
        </div>
        <div class="setting-row">
          <label for="setting-provider">翻译服务商</label>
          <select id="setting-provider" class="setting-select">
            <option value="google">Google 翻译 (内置)</option>
            <option value="dictionary">英汉/英英词典 (仅英文)</option>
            <option value="gemini">Gemini AI (上下文翻译)</option>
            <option value="custom-ai">🔧 自定义 AI 接口</option>
          </select>
        </div>
      </div>

      <div id="ai-settings-group" class="settings-group" style="display: none;">
        <h3>Gemini AI 配置</h3>
        <div class="setting-row column">
          <label for="setting-ai-key">Gemini API Key</label>
          <input type="password" id="setting-ai-key" placeholder="输入 API 密钥..." class="setting-input-text">
        </div>
        <div class="setting-row">
          <label for="setting-ai-model">AI 模型</label>
          <select id="setting-ai-model" class="setting-select">
            <option value="gemini-1.5-flash">Gemini 1.5 Flash (推荐)</option>
            <option value="gemini-1.5-pro">Gemini 1.5 Pro</option>
          </select>
        </div>
        <p class="setting-help">使用 Gemini AI 翻译时，AI 将自动结合生词的上下文，在专业语境下输出极其精准的专业释义。</p>
      </div>

      <div id="custom-ai-settings-group" class="settings-group" style="display: none;">
        <h3>🔧 自定义 AI 接口</h3>
        <div class="setting-row">
          <label for="setting-custom-ai-preset">服务商预设</label>
          <select id="setting-custom-ai-preset" class="setting-select">
            <option value="">自定义</option>
            <option value="deepseek">DeepSeek</option>
            <option value="qwen">阿里百炼 (Qwen)</option>
            <option value="moonshot">Moonshot (Kimi)</option>
            <option value="openrouter">OpenRouter</option>
            <option value="ollama">Ollama (本地)</option>
          </select>
        </div>
        <div class="setting-row column">
          <label for="setting-custom-ai-url">Base URL</label>
          <input type="text" id="setting-custom-ai-url" placeholder="https://api.deepseek.com/v1" class="setting-input-text">
        </div>
        <div class="setting-row column">
          <label for="setting-custom-ai-key">API Key</label>
          <input type="password" id="setting-custom-ai-key" placeholder="sk-..." class="setting-input-text">
        </div>
        <div class="setting-row column">
          <label for="setting-custom-ai-model">模型名称</label>
          <input type="text" id="setting-custom-ai-model" placeholder="deepseek-chat" class="setting-input-text">
        </div>
        <div class="setting-row column">
          <label for="setting-custom-ai-prompt">Prompt 模板</label>
          <textarea id="setting-custom-ai-prompt" class="setting-textarea" rows="4" placeholder="使用 {word}, {context}, {targetLang} 作为占位符..."></textarea>
        </div>
        <div style="display: flex; align-items: center; gap: 10px; margin-top: 8px;">
          <button id="btn-test-custom-ai" class="setting-btn">🔍 测试连接</button>
          <span id="custom-ai-test-result" class="setting-help" style="margin: 0; font-weight: 600;"></span>
        </div>
        <p class="setting-help">使用 OpenAI 兼容格式（/v1/chat/completions），可对接 DeepSeek、Qwen、Moonshot、Ollama 等任意服务。</p>
      </div>

      <div class="settings-group">
        <h3>外观与主题色</h3>
        <div class="setting-row">
          <label for="setting-theme">界面主题</label>
          <select id="setting-theme" class="setting-select">
            <option value="light">明亮纸张</option>
            <option value="dark-ui">暗黑界面 (白纸)</option>
            <option value="dark-all">暗黑护眼 (黑纸)</option>
            <option value="custom">🎨 自定义色彩主题</option>
          </select>
        </div>
        <div id="custom-color-settings-subgroup" style="display: none; margin-top: 10px; border-left: 2px solid var(--primary); padding-left: 10px;">
          <div class="setting-row">
            <label for="setting-bg-style">背景类型</label>
            <select id="setting-bg-style" class="setting-select">
              <option value="solid">单色背景</option>
              <option value="gradient">渐变背景</option>
            </select>
          </div>
          <div id="setting-accent-hue-end-row" class="setting-row" style="display: none; margin-top: 10px; flex-direction: column; align-items: stretch; gap: 4px;">
            <label for="setting-accent-hue-end" style="align-self: flex-start;">渐变结束色相</label>
            <input type="range" id="setting-accent-hue-end" min="0" max="360" step="1" value="200" class="hue-slider" aria-label="自定义结束色相 0-360">
          </div>
        </div>
        <div style="margin-top: 14px;">
          <label style="font-size: 12px; font-weight: 600; color: var(--text-sub); display: block; margin-bottom: 8px;">主题色调</label>
          <div class="color-swatches" id="color-swatches">
            <button class="color-swatch" data-hue="20" title="橙红 (默认)" style="background:hsl(20,75%,48%)" aria-label="橙红"></button>
            <button class="color-swatch" data-hue="225" title="靛蓝" style="background:hsl(225,70%,50%)" aria-label="靛蓝"></button>
            <button class="color-swatch" data-hue="152" title="翡翠绿" style="background:hsl(152,60%,40%)" aria-label="翡翠绿"></button>
            <button class="color-swatch" data-hue="345" title="玫瑰红" style="background:hsl(345,72%,48%)" aria-label="玫瑰红"></button>
            <button class="color-swatch" data-hue="195" title="青蓝" style="background:hsl(195,78%,42%)" aria-label="青蓝"></button>
            <button class="color-swatch" data-hue="40" title="琥珀金" style="background:hsl(40,88%,45%)" aria-label="琥珀金"></button>
            <button class="color-swatch" data-hue="270" title="紫罗兰" style="background:hsl(270,58%,50%)" aria-label="紫罗兰"></button>
            <button class="color-swatch" data-hue="215" title="深蓝灰" style="background:hsl(215,32%,45%)" aria-label="深蓝灰"></button>
          </div>
          <div style="margin-top: 10px;">
            <input type="range" id="setting-accent-hue" min="0" max="360" step="1" value="20" class="hue-slider" aria-label="自定义色相 0-360">
          </div>
        </div>
        <div class="setting-row" style="margin-top: 12px;">
          <label for="setting-card-mode">卡片展示模式</label>
          <select id="setting-card-mode" class="setting-select">
            <option value="minimal">极简模式 (仅释义)</option>
            <option value="contextual">上下文模式 (释义+例句)</option>
            <option value="full">完整模式 (展示来源及详情)</option>
          </select>
        </div>
        <div class="setting-row" style="margin-top: 12px;">
          <label>全屏阅读</label>
          <button id="btn-toggle-fullscreen-setting" class="setting-btn">⛶ 进入全屏</button>
        </div>
        <p class="setting-help">全屏模式下将鼠标移至屏幕边缘可唤出边栏；缩放默认切换为适合页宽。按 Esc 或 F11 退出。</p>
      </div>

      <div class="settings-group">
        <h3>启动行为</h3>
        <div class="setting-row">
          <label for="setting-startup-behavior">打开阅读器时</label>
          <select id="setting-startup-behavior" class="setting-select">
            <option value="library">进入书架界面</option>
            <option value="reopen">重新打开上次文件</option>
          </select>
        </div>
        <p class="setting-help">选择「进入书架」时，打开 ReadFlow（无文件参数）将跳转至书架。</p>
      </div>

      <div class="settings-group">
        <h3>存储与同步</h3>
        <div class="setting-row">
          <button id="btn-clear-db" class="btn-danger">清空所有本地生词库</button>
        </div>
      </div>
    </div>
  `;

  outerContainer.appendChild(sidebar);

  // Link JS variables
  vocabListContainer = document.getElementById('vocab-list-container');
  searchInput = document.getElementById('search-input');
  selectScope = document.getElementById('select-scope');
  selectSort = document.getElementById('select-sort');
  setModifier = document.getElementById('setting-modifier');
  setLang = document.getElementById('setting-lang');
  setProvider = document.getElementById('setting-provider');
  setAiKey = document.getElementById('setting-ai-key');
  setAiModel = document.getElementById('setting-ai-model');
  aiSettingsGroup = document.getElementById('ai-settings-group');
  setCardMode = document.getElementById('setting-card-mode');
  setTheme = document.getElementById('setting-theme');
  setAlwaysTranslate = document.getElementById('setting-always-translate');
  setToggleShortcutModifier = document.getElementById('setting-toggle-shortcut-modifier');
  setToggleShortcutKey = document.getElementById('setting-toggle-shortcut-key');
  // v2.0 new elements
  setAccentHue = document.getElementById('setting-accent-hue');
  setStartupBehavior = document.getElementById('setting-startup-behavior');
  setCustomAiBaseUrl = document.getElementById('setting-custom-ai-url');
  setCustomAiKey = document.getElementById('setting-custom-ai-key');
  setCustomAiModel = document.getElementById('setting-custom-ai-model');
  setCustomAiPrompt = document.getElementById('setting-custom-ai-prompt');
  customAiSettingsGroup = document.getElementById('custom-ai-settings-group');
  // v2.1 new elements
  setBgStyle = document.getElementById('setting-bg-style');
  setAccentHueEnd = document.getElementById('setting-accent-hue-end');
  customColorSettingsSubgroup = document.getElementById('custom-color-settings-subgroup');
  settingAccentHueEndRow = document.getElementById('setting-accent-hue-end-row');

  // Sync settings pane options
  setModifier.value = settings.modifierKey;
  setLang.value = settings.targetLang;
  setProvider.value = settings.translationProvider;
  setAiKey.value = settings.geminiApiKey || '';
  setAiModel.value = settings.geminiModel || 'gemini-1.5-flash';
  setCardMode.value = settings.cardDetailMode || 'contextual';
  setTheme.value = settings.theme || 'light';
  setAlwaysTranslate.checked = settings.alwaysTranslate || false;
  setToggleShortcutModifier.value = settings.toggleShortcutModifier || 'Alt';
  setToggleShortcutKey.value = (settings.toggleShortcutKey || 'b').toUpperCase();
  if (setAccentHue) setAccentHue.value = settings.accentHue || 20;
  if (setStartupBehavior) setStartupBehavior.value = settings.startupBehavior || 'library';
  if (setCustomAiBaseUrl) setCustomAiBaseUrl.value = settings.customAiBaseUrl || '';
  if (setCustomAiKey) setCustomAiKey.value = settings.customAiKey || '';
  if (setCustomAiModel) setCustomAiModel.value = settings.customAiModel || 'deepseek-chat';
  if (setCustomAiPrompt) setCustomAiPrompt.value = settings.customAiPrompt || '';
  if (setBgStyle) setBgStyle.value = settings.bgStyle || 'solid';
  if (setAccentHueEnd) setAccentHueEnd.value = settings.accentHueEnd || 200;
  // Mark active swatch
  updateSwatchActiveState(settings.accentHue || 20);
  toggleAiSettingsVisibility();
  toggleCustomColorSettingsVisibility();
}

function injectToolbarButton() {
  const outerContainer = document.getElementById('outerContainer');
  if (!outerContainer) return;

  const btn = document.createElement('button');
  btn.id = 'btn-toggle-sidebar';
  btn.className = 'floating-fab-btn';
  btn.title = '打开生词本';
  
  btn.innerHTML = `
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="pointer-events: none;">
      <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"></path>
      <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"></path>
    </svg>
    <span id="sidebar-badge" class="badge">0</span>
  `;

  // Append directly to the outer container for floating display
  outerContainer.appendChild(btn);
  sidebarBadge = document.getElementById('sidebar-badge');
  updateBadgeCount();

  // Inject fullscreen toggle floating button
  const btnFs = document.createElement('button');
  btnFs.id = 'btn-toggle-fullscreen';
  btnFs.className = 'floating-fab-secondary';
  btnFs.title = '全屏阅读模式';
  btnFs.innerHTML = `
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="pointer-events: none;">
      <path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"></path>
    </svg>
  `;
  outerContainer.appendChild(btnFs);

  // Inject back-to-library floating button
  const btnLib = document.createElement('button');
  btnLib.id = 'btn-back-to-library';
  btnLib.className = 'floating-fab-secondary';
  btnLib.title = '返回书架';
  btnLib.innerHTML = `
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="pointer-events: none;">
      <path d="M19 12H5M12 19l-7-7 7-7"></path>
    </svg>
  `;
  outerContainer.appendChild(btnLib);
}

// --- Setup Event Listeners ---
function setupExtensionEventListeners() {
  // Sidebar show/hide triggers
  const btnToggle = document.getElementById('btn-toggle-sidebar');
  const btnClose = document.getElementById('btn-close-sidebar');
  if (btnToggle) btnToggle.addEventListener('click', toggleSidebar);
  if (btnClose) btnClose.addEventListener('click', toggleSidebar);

  // Fullscreen button
  const btnFs = document.getElementById('btn-toggle-fullscreen');
  if (btnFs) btnFs.addEventListener('click', toggleFullscreenMode);
  const btnFsSetting = document.getElementById('btn-toggle-fullscreen-setting');
  if (btnFsSetting) btnFsSetting.addEventListener('click', toggleFullscreenMode);
  document.addEventListener('fullscreenchange', onFullscreenChange);

  // Back to library button
  const btnLib = document.getElementById('btn-back-to-library');
  if (btnLib) btnLib.addEventListener('click', async () => {
    const urlParams = new URLSearchParams(window.location.search);
    const bookId = urlParams.get('bookId');
    if (bookId && window.PDFViewerApplication) {
      await saveLastReadPage(bookId, window.PDFViewerApplication.page);
    }
    window.location.href = chrome.runtime.getURL('library.html');
  });

  // Docking controls
  const btnDockLeft = document.getElementById('btn-dock-left');
  const btnDockBottom = document.getElementById('btn-dock-bottom');
  const btnDockRight = document.getElementById('btn-dock-right');
  if (btnDockLeft) btnDockLeft.addEventListener('click', () => changeDockPosition('left'));
  if (btnDockBottom) btnDockBottom.addEventListener('click', () => changeDockPosition('bottom'));
  if (btnDockRight) btnDockRight.addEventListener('click', () => changeDockPosition('right'));

  // Tab switching
  const tabVocab = document.getElementById('tab-vocab');
  const tabSettings = document.getElementById('tab-settings');
  if (tabVocab) tabVocab.addEventListener('click', () => switchTab('vocab'));
  if (tabSettings) tabSettings.addEventListener('click', () => switchTab('settings'));

  // Search & sorting
  if (searchInput) searchInput.addEventListener('input', renderSidebarVocabList);
  if (selectScope) selectScope.addEventListener('change', () => {
    renderSidebarVocabList();
    updateBadgeCount();
  });
  if (selectSort) selectSort.addEventListener('change', renderSidebarVocabList);

  // Settings
  if (setModifier) setModifier.addEventListener('change', updateSettingField);
  if (setLang) setLang.addEventListener('change', updateSettingField);
  if (setProvider) setProvider.addEventListener('change', () => {
    updateSettingField();
    toggleAiSettingsVisibility();
  });
  if (setAiKey) setAiKey.addEventListener('change', updateSettingField);
  if (setAiModel) setAiModel.addEventListener('change', updateSettingField);
  if (setCardMode) setCardMode.addEventListener('change', () => {
    updateSettingField();
    renderSidebarVocabList();
  });
  if (setTheme) {
    setTheme.addEventListener('change', () => {
      updateSettingField();
      toggleCustomColorSettingsVisibility();
    });
  }
  if (setBgStyle) {
    setBgStyle.addEventListener('change', () => {
      updateSettingField();
      toggleCustomColorSettingsVisibility();
    });
  }
  if (setAlwaysTranslate) setAlwaysTranslate.addEventListener('change', updateSettingField);
  if (setToggleShortcutModifier) setToggleShortcutModifier.addEventListener('change', updateSettingField);
  if (setToggleShortcutKey) {
    setToggleShortcutKey.addEventListener('keydown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (['alt', 'control', 'shift', 'meta', 'escape', 'tab'].includes(e.key.toLowerCase())) return;
      setToggleShortcutKey.value = e.key.toUpperCase();
      settings.toggleShortcutKey = e.key;
      updateSettingField();
    });
  }

  // v2.0: Accent color — swatch buttons
  document.addEventListener('click', (e) => {
    const swatch = e.target.closest('.color-swatch');
    if (swatch) {
      const hue = parseInt(swatch.dataset.hue);
      settings.accentHue = hue;
      if (setAccentHue) setAccentHue.value = hue;
      applyAccentColor(hue, settings.accentSaturation);
      updateSwatchActiveState(hue);
      chrome.storage.local.set({ settings });
    }
  });

  // v2.0: Accent hue slider
  if (setAccentHue) {
    setAccentHue.addEventListener('input', () => {
      const hue = parseInt(setAccentHue.value);
      settings.accentHue = hue;
      applyAccentColor(hue, settings.accentSaturation);
      updateSwatchActiveState(hue);
    });
    setAccentHue.addEventListener('change', () => { chrome.storage.local.set({ settings }); });
  }

  // v2.1: Accent hue end slider
  if (setAccentHueEnd) {
    setAccentHueEnd.addEventListener('input', () => {
      const hue = parseInt(setAccentHueEnd.value);
      settings.accentHueEnd = hue;
      applyAccentColor(settings.accentHue, settings.accentSaturation);
    });
    setAccentHueEnd.addEventListener('change', () => { chrome.storage.local.set({ settings }); });
  }

  // v2.0: Startup behavior
  if (setStartupBehavior) setStartupBehavior.addEventListener('change', updateSettingField);

  // v2.0: Custom AI preset auto-fill
  const presetSelect = document.getElementById('setting-custom-ai-preset');
  if (presetSelect) {
    presetSelect.addEventListener('change', () => {
      const presets = {
        deepseek: { url: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
        qwen:     { url: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
        moonshot: { url: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k' },
        openrouter:{ url: 'https://openrouter.ai/api/v1', model: 'openai/gpt-4o-mini' },
        ollama:   { url: 'http://localhost:11434/v1', model: 'llama3' },
      };
      const p = presets[presetSelect.value];
      if (p) {
        if (setCustomAiBaseUrl) setCustomAiBaseUrl.value = p.url;
        if (setCustomAiModel) setCustomAiModel.value = p.model;
        settings.customAiBaseUrl = p.url;
        settings.customAiModel = p.model;
        chrome.storage.local.set({ settings });
      }
    });
  }

  // v2.0: Custom AI fields
  if (setCustomAiBaseUrl) setCustomAiBaseUrl.addEventListener('change', updateSettingField);
  if (setCustomAiKey) setCustomAiKey.addEventListener('change', updateSettingField);
  if (setCustomAiModel) setCustomAiModel.addEventListener('change', updateSettingField);
  if (setCustomAiPrompt) setCustomAiPrompt.addEventListener('change', updateSettingField);

  // v2.0: Test custom AI connection
  const btnTestAi = document.getElementById('btn-test-custom-ai');
  if (btnTestAi) btnTestAi.addEventListener('click', testCustomAiConnection);

  const btnClear = document.getElementById('btn-clear-db');
  if (btnClear) btnClear.addEventListener('click', clearEntireDatabase);

  // Exporters
  const btnCsv = document.getElementById('btn-export-csv');
  const btnAnki = document.getElementById('btn-export-anki');
  if (btnCsv) btnCsv.addEventListener('click', exportVocabCsv);
  if (btnAnki) btnAnki.addEventListener('click', exportVocabAnki);

  // Selection events hook inside PDF pages
  const viewerContainer = document.getElementById('viewerContainer');
  if (viewerContainer) {
    viewerContainer.addEventListener('mouseup', handleTextSelection);
  }

  // Global Keydown Shortcut Listener
  window.addEventListener('keydown', (e) => {
    if (e.target.tagName.toUpperCase() === 'INPUT' || e.target.tagName.toUpperCase() === 'TEXTAREA') {
      return;
    }
    const targetModifier = settings.toggleShortcutModifier || 'Alt';
    const targetKey = (settings.toggleShortcutKey || 'b').toLowerCase();
    
    let modifierMatch = false;
    if (targetModifier === 'Alt' && e.altKey && !e.ctrlKey && !e.shiftKey) modifierMatch = true;
    else if (targetModifier === 'Ctrl' && e.ctrlKey && !e.altKey && !e.shiftKey) modifierMatch = true;
    else if (targetModifier === 'Shift' && e.shiftKey && !e.altKey && !e.ctrlKey) modifierMatch = true;
    else if (targetModifier === 'None' && !e.altKey && !e.ctrlKey && !e.shiftKey) modifierMatch = true;
    
    if (modifierMatch && e.key.toLowerCase() === targetKey) {
      e.preventDefault();
      settings.alwaysTranslate = !settings.alwaysTranslate;
      chrome.storage.local.set({ settings });
      if (setAlwaysTranslate) {
        setAlwaysTranslate.checked = settings.alwaysTranslate;
      }
      showSystemToast(settings.alwaysTranslate ? '已开启无修饰键直接选词翻译' : '已关闭无修饰键选词（恢复快捷键取词）');
    }
  });

  // Hook into PDF.js native page rendering completion event
  document.addEventListener('pagerendered', (e) => {
    const pageNum = e.detail.pageNumber;
    const pageDiv = e.target; // page DOM container (.page)
    const textLayerDiv = pageDiv.querySelector('.textLayer');
    if (textLayerDiv) {
      applyPageHighlights(pageNum, textLayerDiv);
    }
  });
}

function toggleSidebar() {
  settings.sidebarOpen = !settings.sidebarOpen;
  chrome.storage.local.set({ settings });
  updateLayout();
}

function changeDockPosition(position) {
  settings.dockPosition = position;
  chrome.storage.local.set({ settings });
  
  // Re-adjust resizer class on sidebar
  const resizer = document.getElementById('sidebar-resizer');
  if (resizer) {
    resizer.className = 'sidebar-resizer';
  }

  updateLayout();
  renderSidebarVocabList(); // Re-render to trigger layout changes (e.g. grid in dock-bottom)
}

function updateLayout() {
  const outer = document.getElementById('outerContainer');
  const main = document.getElementById('mainContainer');
  const sb = document.getElementById('sidebar');
  if (!outer || !main || !sb) return;

  const isOpen = settings.sidebarOpen;
  const dock = settings.dockPosition || 'right';

  // Toggle CSS classes on outer container for styling hooks
  outer.classList.toggle('readflow-sidebar-open', isOpen);
  
  // Clean custom class names on sidebar and set layout position
  sb.className = '';
  sb.classList.add(`dock-${dock}`);
  if (isOpen) {
    sb.classList.add('open');
  }

  // Measure native left outline sidebar container width
  const nativeOpen = outer.classList.contains('sidebarOpen');
  const nativeSidebar = document.getElementById('sidebarContainer');
  const nativeWidth = nativeOpen && nativeSidebar ? nativeSidebar.getBoundingClientRect().width : 0;

  // Reset styles before applying dynamic positioning overrides
  main.style.left = '';
  main.style.right = '';
  main.style.top = '';
  main.style.bottom = '';
  
  sb.style.left = '';
  sb.style.right = '';
  sb.style.top = '';
  sb.style.bottom = '';
  sb.style.width = '';
  sb.style.height = '';

  // Synchronize docking buttons visual active states
  const btnLeft = document.getElementById('btn-dock-left');
  const btnBottom = document.getElementById('btn-dock-bottom');
  const btnRight = document.getElementById('btn-dock-right');
  
  if (btnLeft) btnLeft.classList.toggle('active', dock === 'left');
  if (btnBottom) btnBottom.classList.toggle('active', dock === 'bottom');
  if (btnRight) btnRight.classList.toggle('active', dock === 'right');

  // Check fullscreen mode
  const isFs = !!document.fullscreenElement;
  if (isFs) {
    // In fullscreen: main always spans 100% of viewport, sidebars are floating covers
    main.style.left = '0';
    main.style.right = '0';
    main.style.top = '0';
    main.style.bottom = '0';

    sb.style.display = isOpen ? 'flex' : 'none';
    if (isOpen) {
      if (dock === 'right') {
        const w = settings.sidebarWidth || 380;
        sb.style.width = w + 'px';
        sb.style.right = '0';
        sb.style.top = '0';
        sb.style.height = '100vh';
        outer.style.setProperty('--sidebar-width-active', w + 'px');
        outer.style.setProperty('--sidebar-height-active', '0px');
      } else if (dock === 'left') {
        const w = settings.sidebarWidth || 380;
        sb.style.width = w + 'px';
        sb.style.left = '0';
        sb.style.top = '0';
        sb.style.height = '100vh';
        outer.style.setProperty('--sidebar-width-active', '0px');
        outer.style.setProperty('--sidebar-height-active', '0px');
      } else if (dock === 'bottom') {
        const h = settings.sidebarHeight || 300;
        sb.style.height = h + 'px';
        sb.style.left = '0';
        sb.style.right = '0';
        sb.style.bottom = '0';
        outer.style.setProperty('--sidebar-width-active', '0px');
        outer.style.setProperty('--sidebar-height-active', h + 'px');
      }
    } else {
      outer.style.setProperty('--sidebar-width-active', '0px');
      outer.style.setProperty('--sidebar-height-active', '0px');
    }
    
    window.dispatchEvent(new Event('resize'));
    if (window.PDFViewerApplication && window.PDFViewerApplication.pdfViewer) {
      const viewer = window.PDFViewerApplication.pdfViewer;
      if (viewer.currentScaleValue === 'auto' || 
          viewer.currentScaleValue === 'page-width' || 
          viewer.currentScaleValue === 'page-fit' ||
          viewer.currentScaleValue === 'page-height') {
        viewer.currentScaleValue = viewer.currentScaleValue;
      }
    }
    return;
  }

  if (!isOpen) {
    // Notebook closed: PDF workspace flows right to native outline edge
    main.style.left = nativeWidth + 'px';
    main.style.right = '0';
    main.style.top = '0';
    main.style.bottom = '0';
    
    sb.style.display = 'none';
    outer.style.setProperty('--sidebar-width-active', '0px');
    outer.style.setProperty('--sidebar-height-active', '0px');
    window.dispatchEvent(new Event('resize'));
    return;
  }

  sb.style.display = 'flex';

  // Notebook open: align sidebar and container boundaries by dock position
  if (dock === 'right') {
    const w = settings.sidebarWidth || 380;
    sb.style.width = w + 'px';
    sb.style.right = '0';
    sb.style.top = '0';
    sb.style.height = '100vh';

    main.style.left = nativeWidth + 'px';
    main.style.right = w + 'px';
    main.style.top = '0';
    main.style.bottom = '0';

    outer.style.setProperty('--sidebar-width-active', w + 'px');
    outer.style.setProperty('--sidebar-height-active', '0px');
  } 
  else if (dock === 'left') {
    const w = settings.sidebarWidth || 380;
    sb.style.width = w + 'px';
    sb.style.left = nativeWidth + 'px';
    sb.style.top = '0';
    sb.style.height = '100vh';

    main.style.left = (nativeWidth + w) + 'px';
    main.style.right = '0';
    main.style.top = '0';
    main.style.bottom = '0';

    outer.style.setProperty('--sidebar-width-active', '0px');
    outer.style.setProperty('--sidebar-height-active', '0px');
  } 
  else if (dock === 'bottom') {
    const h = settings.sidebarHeight || 300;
    sb.style.height = h + 'px';
    sb.style.left = nativeWidth + 'px';
    sb.style.right = '0';
    sb.style.bottom = '0';

    main.style.left = nativeWidth + 'px';
    main.style.right = '0';
    main.style.top = '0';
    main.style.bottom = h + 'px';

    outer.style.setProperty('--sidebar-width-active', '0px');
    outer.style.setProperty('--sidebar-height-active', h + 'px');
  }

  // Force PDF.js viewport re-layout zoom alignment and scale recalculation
  window.dispatchEvent(new Event('resize'));
  if (window.PDFViewerApplication && window.PDFViewerApplication.pdfViewer) {
    const viewer = window.PDFViewerApplication.pdfViewer;
    if (viewer.currentScaleValue === 'auto' || 
        viewer.currentScaleValue === 'page-width' || 
        viewer.currentScaleValue === 'page-fit' ||
        viewer.currentScaleValue === 'page-height') {
      viewer.currentScaleValue = viewer.currentScaleValue;
    }
  }
}

function initResizer() {
  const resizer = document.getElementById('sidebar-resizer');
  if (!resizer) return;

  let isDragging = false;
  let startX = 0;
  let startY = 0;
  let startWidth = 0;
  let startHeight = 0;

  resizer.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return; // Allow only left click
    isDragging = true;
    resizer.classList.add('dragging');
    
    // Add resizing class to disable transitions and optimize redraw performance
    const outer = document.getElementById('outerContainer');
    if (outer) outer.classList.add('resizing');
    
    document.body.style.userSelect = 'none';
    document.body.style.cursor = settings.dockPosition === 'bottom' ? 'ns-resize' : 'ew-resize';

    startX = e.clientX;
    startY = e.clientY;
    startWidth = settings.sidebarWidth || 380;
    startHeight = settings.sidebarHeight || 300;

    e.preventDefault();
  });

  window.addEventListener('mousemove', (e) => {
    if (!isDragging) return;

    const dock = settings.dockPosition;
    if (dock === 'right') {
      const deltaX = e.clientX - startX;
      const newWidth = Math.max(200, Math.min(800, startWidth - deltaX));
      settings.sidebarWidth = newWidth;
    } 
    else if (dock === 'left') {
      const deltaX = e.clientX - startX;
      const newWidth = Math.max(200, Math.min(800, startWidth + deltaX));
      settings.sidebarWidth = newWidth;
    } 
    else if (dock === 'bottom') {
      const deltaY = e.clientY - startY;
      const newHeight = Math.max(150, Math.min(600, startHeight - deltaY));
      settings.sidebarHeight = newHeight;
    }

    updateLayout();
  });

  window.addEventListener('mouseup', () => {
    const outerContainer = document.getElementById('outerContainer');
    if (outerContainer) outerContainer.classList.remove('resizing');

    if (isDragging) {
      isDragging = false;
      resizer.classList.remove('dragging');
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
      chrome.storage.local.set({ settings });
    }
  });

  // --- Native PDF.js Sidebar Resizer drag listener and observer for real-time resizing ---
  const nativeResizer = document.getElementById('sidebarResizer');
  const outerContainer = document.getElementById('outerContainer');
  if (nativeResizer && outerContainer) {
    nativeResizer.addEventListener('mousedown', () => {
      outerContainer.classList.add('resizing');
      
      let isNativeDragging = true;
      
      const onNativeMouseMove = () => {
        if (isNativeDragging) {
          updateLayout();
        }
      };
      
      const onNativeMouseUp = () => {
        isNativeDragging = false;
        outerContainer.classList.remove('resizing');
        window.removeEventListener('mousemove', onNativeMouseMove);
        window.removeEventListener('mouseup', onNativeMouseUp);
        updateLayout();
      };
      
      window.addEventListener('mousemove', onNativeMouseMove);
      window.addEventListener('mouseup', onNativeMouseUp);
    });
  }

  const nativeSidebar = document.getElementById('sidebarContainer');
  if (nativeSidebar) {
    const nativeObserver = new MutationObserver(() => {
      updateLayout();
    });
    nativeObserver.observe(nativeSidebar, {
      attributes: true,
      attributeFilter: ['style', 'class']
    });
  }
}

function switchTab(tab) {
  const tabVocab = document.getElementById('tab-vocab');
  const tabSettings = document.getElementById('tab-settings');
  const paneVocab = document.getElementById('sidebar-vocab-pane');
  const paneSettings = document.getElementById('sidebar-settings-pane');

  if (tab === 'vocab') {
    tabVocab.classList.add('active');
    tabSettings.classList.remove('active');
    paneVocab.classList.add('active');
    paneSettings.classList.remove('active');
    renderSidebarVocabList();
  } else {
    tabVocab.classList.remove('active');
    tabSettings.classList.add('active');
    paneVocab.classList.remove('active');
    paneSettings.classList.add('active');
  }
}

function toggleAiSettingsVisibility() {
  const provider = settings.translationProvider;
  if (aiSettingsGroup) aiSettingsGroup.style.display = (provider === 'gemini') ? 'block' : 'none';
  if (customAiSettingsGroup) customAiSettingsGroup.style.display = (provider === 'custom-ai') ? 'block' : 'none';
}

function updateSettingField() {
  settings.modifierKey = setModifier.value;
  settings.targetLang = setLang.value;
  settings.translationProvider = setProvider.value;
  settings.geminiApiKey = setAiKey.value;
  settings.geminiModel = setAiModel.value;
  settings.cardDetailMode = setCardMode.value;
  if (setTheme) settings.theme = setTheme.value;
  if (setAlwaysTranslate) settings.alwaysTranslate = setAlwaysTranslate.checked;
  if (setToggleShortcutModifier) settings.toggleShortcutModifier = setToggleShortcutModifier.value;
  // v2.0 new fields
  if (setStartupBehavior) settings.startupBehavior = setStartupBehavior.value;
  if (setCustomAiBaseUrl) settings.customAiBaseUrl = setCustomAiBaseUrl.value;
  if (setCustomAiKey) settings.customAiKey = setCustomAiKey.value;
  if (setCustomAiModel) settings.customAiModel = setCustomAiModel.value;
  if (setCustomAiPrompt) settings.customAiPrompt = setCustomAiPrompt.value;
  // v2.1 new fields
  if (setBgStyle) settings.bgStyle = setBgStyle.value;
  if (setAccentHueEnd) settings.accentHueEnd = parseInt(setAccentHueEnd.value);

  chrome.storage.local.set({ settings });
  applyTheme();
}

function toggleCustomColorSettingsVisibility() {
  const isCustomTheme = settings.theme === 'custom';
  if (customColorSettingsSubgroup) {
    customColorSettingsSubgroup.style.display = isCustomTheme ? 'block' : 'none';
  }
  if (settingAccentHueEndRow) {
    settingAccentHueEndRow.style.display = (isCustomTheme && settings.bgStyle === 'gradient') ? 'flex' : 'none';
  }
}

// --- Text Selection & Offsets Logic ---
async function handleTextSelection(e) {
  const selection = window.getSelection();
  if (!selection || selection.toString().trim() === '') {
    return;
  }

  // Modifier key validation (skipped if alwaysTranslate mode is toggled active)
  if (!settings.alwaysTranslate) {
    if (settings.modifierKey === 'Alt' && !e.altKey) return;
    if (settings.modifierKey === 'Ctrl' && !e.ctrlKey) return;
    if (settings.modifierKey === 'Shift' && !e.shiftKey) return;
  }

  const selectedText = selection.toString();
  const word = selectedText.trim();
  if (word.length > 80 || /^[0-9\s.,\/#!$%\^&\*;:{}=\-_`~()]+$/.test(word)) {
    return;
  }

  const range = selection.getRangeAt(0);
  const textLayerEl = range.startContainer.parentElement.closest('.textLayer');
  if (!textLayerEl) return;

  const pageDiv = textLayerEl.closest('.page');
  const pageNum = parseInt(pageDiv.dataset.pageNumber);
  const currentPdf = getCurrentPdfName();

  // Reconstruct cleanly spaced text representation using visual layouts
  const { text: fullPageText, offset: charOffset } = getPageTextAndOffset(textLayerEl, range);
  
  // Find trimmed word offsets inside selection text to ignore spacing padding
  const leadingSpaceLength = selectedText.indexOf(word);
  const finalCharOffset = charOffset + leadingSpaceLength;

  const context = getContextSentence(fullPageText, finalCharOffset, word.length);
  const rect = range.getBoundingClientRect();

  // Clear selections
  selection.removeAllRanges();

  // Loading toast
  showToastLoading(word, rect);

  try {
    const translationResult = await translateWord(word, context);
    
    // Save to Database
    const vocabItem = await saveVocabWord({
      word,
      translation: translationResult.translation,
      phonetic: translationResult.phonetic || '',
      context,
      pageNum,
      charOffset: finalCharOffset,
      length: word.length,
      currentPdf
    });

    // Reapply highlights immediately
    applyPageHighlights(pageNum, textLayerEl);

    // Show toast result
    showToastResult(vocabItem, rect);

    // Update list & badge count
    updateBadgeCount();
    renderSidebarVocabList();
  } catch (err) {
    console.error('Translation failed:', err);
    showToastError(word, rect);
  }
}

// Bounding box horizontal & vertical spatial layout text reconstruction
function getPageTextAndOffset(textLayerEl, range) {
  let reconstructedText = "";
  let charOffset = -1;
  let foundStart = false;
  let lastRect = null;

  // Retrieve current viewer zoom scale dynamically
  const zoomScale = window.PDFViewerApplication.pdfViewer.currentScale || 1.0;
  const yThreshold = 6 * zoomScale;
  const xThreshold = 1.0 * zoomScale;

  function traverse(node) {
    if (node === range.startContainer) {
      charOffset = reconstructedText.length + range.startOffset;
      foundStart = true;
    }

    if (node.nodeType === Node.TEXT_NODE) {
      reconstructedText += node.textContent;
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      const tagName = node.tagName.toUpperCase();

      if (tagName === 'BR') {
        reconstructedText += '\n';
      } else if (tagName === 'SPAN' || tagName === 'MARK') {
        const rect = node.getBoundingClientRect();

        // Spacing calculations based on physical gaps
        if (lastRect && rect.width > 0 && lastRect.width > 0) {
          const yDiff = Math.abs(rect.top - lastRect.top);
          const xDiff = rect.left - lastRect.right;

          if (yDiff > yThreshold) {
            reconstructedText += '\n';
          } else if (xDiff > xThreshold) {
            reconstructedText += ' ';
          }
        }

        if (rect.width > 0) {
          lastRect = rect;
        }

        for (let i = 0; i < node.childNodes.length; i++) {
          traverse(node.childNodes[i]);
        }
      }
    }
  }

  for (let i = 0; i < textLayerEl.childNodes.length; i++) {
    traverse(textLayerEl.childNodes[i]);
  }

  return { text: reconstructedText, offset: charOffset };
}

// --- v3.0: Smart Sentence Segmentation Engine ---
// Abbreviation whitelist — periods after these tokens do NOT end a sentence
const ABBREVIATIONS = new Set([
  // Titles
  'mr', 'mrs', 'ms', 'dr', 'prof', 'jr', 'sr', 'rev',
  // Corporate
  'inc', 'ltd', 'corp', 'co', 'llc',
  // Latin / common
  'etc', 'vs', 'approx', 'dept', 'est', 'al', 'cf', 'ref',
  // Academic / scientific
  'fig', 'figs', 'eq', 'eqs', 'tab', 'sec', 'ch', 'pp', 'ed', 'trans', 'ibid',
  'vol', 'no', 'rev', 'op', 'cit', 'proc', 'int', 'natl',
  // Units / misc
  'st', 'ave', 'blvd', 'tel', 'fax', 'min', 'max', 'avg',
]);

// Multi-char abbreviations where both parts matter (handled as bigrams)
const MULTI_ABBREVS = ['e.g', 'i.e', 'et al', 'Ph.D', 'M.D', 'B.A', 'M.A', 'U.S', 'U.K'];

/**
 * segmentSentences(text)
 * Splits text into sentences with offset tracking.
 * Returns: Array<{ sentence: string, start: number, end: number }>
 */
function segmentSentences(text) {
  if (!text || text.length === 0) return [];

  const sentences = [];
  let sentenceStart = 0;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    // Always split on ? and !
    if (ch === '?' || ch === '!') {
      const sentEnd = i + 1;
      const raw = text.slice(sentenceStart, sentEnd).trim();
      if (raw.length > 0) {
        sentences.push({ sentence: raw, start: sentenceStart, end: sentEnd });
      }
      sentenceStart = sentEnd;
      continue;
    }

    // Period detection — the main complexity
    if (ch === '.') {
      // Check what comes AFTER the period
      let afterIdx = i + 1;
      // Skip whitespace after the period
      while (afterIdx < text.length && (text[afterIdx] === ' ' || text[afterIdx] === '\t')) {
        afterIdx++;
      }
      const charAfter = afterIdx < text.length ? text[afterIdx] : '';

      // Rule 1: Period followed by a digit → NOT a sentence end (e.g. "3.14")
      if (/\d/.test(charAfter) && i > 0 && /\d/.test(text[i - 1])) {
        continue;
      }

      // Rule 2: Check for multi-char abbreviations (e.g., i.e.)
      let isMultiAbbrev = false;
      for (const ma of MULTI_ABBREVS) {
        const dotlessLen = ma.replace(/\./g, '').length + ma.split('.').length - 1;
        const startCheck = Math.max(0, i - dotlessLen);
        const slice = text.slice(startCheck, i + 1).toLowerCase();
        if (slice.endsWith(ma.toLowerCase() + '.') || slice.endsWith(ma.toLowerCase())) {
          isMultiAbbrev = true;
          break;
        }
      }
      if (isMultiAbbrev) {
        continue;
      }

      // Rule 3: Extract the token before the period
      let tokenStart = i - 1;
      while (tokenStart >= sentenceStart && /[a-zA-Z]/.test(text[tokenStart])) {
        tokenStart--;
      }
      tokenStart++;
      const tokenBefore = text.slice(tokenStart, i).toLowerCase();

      // Rule 4: Single letter followed by period → numbering label (a. b. c.) — NOT a sentence end
      if (/^[a-z]$/i.test(tokenBefore)) {
        continue;
      }

      // Rule 5: Number followed by period → numbering label (1. 2. 3.) — NOT a sentence end
      let numStart = i - 1;
      while (numStart >= sentenceStart && /\d/.test(text[numStart])) {
        numStart--;
      }
      numStart++;
      if (numStart < i && /^\d+$/.test(text.slice(numStart, i))) {
        // But allow if the number is at the very end of what looks like a sentence
        // (e.g., "published in 2024." should split if followed by capital)
        const isEndOfLongText = (i - sentenceStart) > 15;
        if (!isEndOfLongText || !/[A-Z]/.test(charAfter)) {
          continue;
        }
      }

      // Rule 6: Token is a known abbreviation → NOT a sentence end
      if (tokenBefore.length > 0 && ABBREVIATIONS.has(tokenBefore)) {
        continue;
      }

      // Rule 7: Period NOT followed by uppercase letter or newline/end → NOT a sentence end
      if (charAfter && !/[A-Z\n\r]/.test(charAfter) && afterIdx < text.length) {
        continue;
      }

      // All checks passed — this IS a sentence boundary
      const sentEnd = i + 1;
      const raw = text.slice(sentenceStart, sentEnd).trim();
      if (raw.length > 0) {
        sentences.push({ sentence: raw, start: sentenceStart, end: sentEnd });
      }
      sentenceStart = sentEnd;
      continue;
    }

    // Newline handling: if previous text ends with a period, it's already handled.
    // If newline appears with significant gap (paragraph break), treat as sentence boundary
    if (ch === '\n' || ch === '\r') {
      // Look ahead for double-newline (paragraph break)
      if (i + 1 < text.length && (text[i + 1] === '\n' || text[i + 1] === '\r')) {
        const raw = text.slice(sentenceStart, i).trim();
        if (raw.length > 0) {
          sentences.push({ sentence: raw, start: sentenceStart, end: i });
        }
        sentenceStart = i + 1;
        while (sentenceStart < text.length && /[\n\r\s]/.test(text[sentenceStart])) {
          sentenceStart++;
        }
        i = sentenceStart - 1;
      }
    }
  }

  // Remaining text as final sentence
  const remaining = text.slice(sentenceStart).trim();
  if (remaining.length > 0) {
    sentences.push({ sentence: remaining, start: sentenceStart, end: text.length });
  }

  return sentences;
}

function getContextSentence(fullText, startOffset, wordLength) {
  const sentences = segmentSentences(fullText);

  // Find the sentence that contains the word
  for (const s of sentences) {
    // Account for whitespace differences: find effective range
    const effStart = fullText.indexOf(s.sentence.charAt(0), s.start);
    if (startOffset >= s.start && startOffset < s.end) {
      return s.sentence.replace(/\s+/g, ' ').trim();
    }
  }

  // Fallback: return a window around the word (±120 chars)
  const fallbackStart = Math.max(0, startOffset - 120);
  const fallbackEnd = Math.min(fullText.length, startOffset + wordLength + 120);
  return fullText.slice(fallbackStart, fallbackEnd).replace(/\s+/g, ' ').trim();
}

// --- Translation Engine ---
async function translateWord(word, context) {
  const provider = settings.translationProvider;

  if (provider === 'google') {
    return await translateGoogle(word);
  } else if (provider === 'dictionary') {
    if (/^[A-Za-z\s'-]+$/.test(word)) {
      try {
        return await lookupEnglishDictionary(word);
      } catch (e) {
        return await translateGoogle(word);
      }
    } else {
      return await translateGoogle(word);
    }
  } else if (provider === 'gemini') {
    if (!settings.geminiApiKey) throw new Error('AI API Key is missing.');
    return await translateGemini(word, context);
  } else if (provider === 'custom-ai') {
    if (!settings.customAiBaseUrl || !settings.customAiKey) {
      throw new Error('\u81ea\u5b9a\u4e49 AI \u672a\u914d\u7f6e URL \u6216 API Key');
    }
    return await translateCustomAI(word, context);
  }
  return await translateGoogle(word);
}

async function translateGoogle(word) {
  const target = settings.targetLang;
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${target}&dt=t&q=${encodeURIComponent(word)}`;
  
  const response = await fetch(url);
  if (!response.ok) throw new Error('Google Translation request failed');
  
  const data = await response.json();
  const translation = data[0].map(item => item[0]).join('').trim();
  return { translation, phonetic: '' };
}

async function lookupEnglishDictionary(word) {
  const url = `https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word.toLowerCase())}`;
  
  const response = await fetch(url);
  if (!response.ok) throw new Error('Dictionary API failed');
  
  const data = await response.json();
  const entry = data[0];
  const phonetic = entry.phonetic || (entry.phonetics && entry.phonetics.length > 0 ? entry.phonetics.find(p => p.text)?.text : '') || '';
  
  const meanings = entry.meanings.slice(0, 2).map(m => {
    return `[${m.partOfSpeech}] ${m.definitions[0].definition}`;
  }).join('; ');
  
  return { translation: meanings, phonetic };
}

async function translateGemini(word, context) {
  const apiKey = settings.geminiApiKey;
  const model = settings.geminiModel;
  const targetLangName = LANG_NAMES[settings.targetLang] || 'Chinese';
  
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const prompt = `You are a professional contextual dictionary translator. Translate the word/phrase "${word}" to ${targetLangName} taking its specific context into account.
Context: "${context}"
Respond with ONLY the translation, part of speech, and optional phonetic spelling, in a compact dictionary style. Do not include markdown formatting or introductions.`;

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }]
    })
  });
  
  if (!response.ok) {
    const errData = await response.json();
    throw new Error(errData.error?.message || 'Gemini API failed');
  }

  const data = await response.json();
  return { translation: data.candidates[0].content.parts[0].text.trim(), phonetic: '' };
}

// --- Storage Integration (v3.0 Word-Centric Model) ---
async function saveVocabWord(wordData) {
  const wordKey = `${wordData.currentPdf}__${wordData.word.toLowerCase()}`;
  const index = vocabList.findIndex(item => item.id === wordKey);
  const now = Date.now();

  const newContext = {
    sentence: wordData.context,
    page: wordData.pageNum,
    charOffset: wordData.charOffset,
    length: wordData.length,
    addedAt: now
  };

  let item;
  if (index !== -1) {
    // Word already exists in this PDF — merge
    item = vocabList[index];
    item.lookups = (item.lookups || 1) + 1;
    item.timestamp = now;
    // Update translation to the latest (context-aware translation may differ)
    item.translation = wordData.translation;
    if (wordData.phonetic) item.phonetic = wordData.phonetic;

    // Deduplicate: only add if sentence is meaningfully different
    const isDuplicate = item.contexts.some(c => {
      if (c.sentence === newContext.sentence) return true;
      // Simple similarity: if >85% of words overlap, treat as duplicate
      const wordsA = new Set(c.sentence.toLowerCase().split(/\s+/));
      const wordsB = new Set(newContext.sentence.toLowerCase().split(/\s+/));
      const intersection = [...wordsA].filter(w => wordsB.has(w)).length;
      const union = new Set([...wordsA, ...wordsB]).size;
      return union > 0 && (intersection / union) > 0.85;
    });

    if (!isDuplicate && newContext.sentence.trim().length > 0) {
      item.contexts.push(newContext);
    }
  } else {
    // New word — create fresh entry
    item = {
      id: wordKey,
      word: wordData.word,
      translation: wordData.translation,
      phonetic: wordData.phonetic || '',
      source_pdf: wordData.currentPdf,
      lookups: 1,
      timestamp: now,
      contexts: newContext.sentence.trim().length > 0 ? [newContext] : []
    };
    vocabList.push(item);
  }

  await new Promise((resolve) => {
    chrome.storage.local.set({ vocabList }, resolve);
  });
  return item;
}

async function deleteVocabWord(id) {
  vocabList = vocabList.filter(item => item.id !== id);
  await new Promise((resolve) => {
    chrome.storage.local.set({ vocabList }, resolve);
  });
  
  // Re-apply highlights on all loaded pages to clear deleted marks
  const pages = document.querySelectorAll('.page[data-page-number]');
  pages.forEach(pageDiv => {
    const pageNum = parseInt(pageDiv.dataset.pageNumber);
    const textLayerDiv = pageDiv.querySelector('.textLayer');
    if (textLayerDiv) {
      applyPageHighlights(pageNum, textLayerDiv);
    }
  });

  updateBadgeCount();
  renderSidebarVocabList();
}

async function clearEntireDatabase() {
  if (confirm('您确定要清空所有的本地词汇数据库吗？高亮记录与单词卡将永久丢失。')) {
    vocabList = [];
    await new Promise((resolve) => {
      chrome.storage.local.set({ vocabList }, resolve);
    });

    const pages = document.querySelectorAll('.page[data-page-number]');
    pages.forEach(pageDiv => {
      const pageNum = parseInt(pageDiv.dataset.pageNumber);
      const textLayerDiv = pageDiv.querySelector('.textLayer');
      if (textLayerDiv) {
        applyPageHighlights(pageNum, textLayerDiv);
      }
    });

    updateBadgeCount();
    renderSidebarVocabList();
    alert('生词数据库已成功清空！');
  }
}

// --- Highlighting Engine (v3.0 Word-Centric) ---
function applyPageHighlights(pageNum, textLayerContainer) {
  // Clear existing highlights
  const marks = textLayerContainer.querySelectorAll('mark.readflow-highlight');
  marks.forEach(mark => {
    const parent = mark.parentNode;
    if (parent) {
      while (mark.firstChild) {
        parent.insertBefore(mark.firstChild, mark);
      }
      parent.removeChild(mark);
    }
  });
  textLayerContainer.normalize();

  const currentPdf = getCurrentPdfName();
  
  // Collect all highlight targets for this page from contexts[] arrays
  const highlightTargets = [];
  vocabList.forEach(item => {
    if (item.source_pdf !== currentPdf) return;
    const contexts = item.contexts || [];
    contexts.forEach(ctx => {
      if (ctx.page === pageNum) {
        highlightTargets.push({
          charOffset: ctx.charOffset,
          length: ctx.length,
          lookups: item.lookups,
          vocabId: item.id
        });
      }
    });
  });
  
  // Sort descending by charOffset (right-to-left splits to avoid offset invalidation)
  highlightTargets.sort((a, b) => b.charOffset - a.charOffset);
  
  highlightTargets.forEach(target => {
    applyRangeHighlight(textLayerContainer, target.charOffset, target.length, target.lookups, target.vocabId);
  });
}

function applyRangeHighlight(container, charOffset, length, lookups, vocabId) {
  let reconstructedText = "";
  let lastRect = null;
  const textNodes = [];

  const zoomScale = window.PDFViewerApplication.pdfViewer.currentScale || 1.0;
  const yThreshold = 6 * zoomScale;
  const xThreshold = 1.0 * zoomScale;

  function traverse(node) {
    if (node.nodeType === Node.TEXT_NODE) {
      const start = reconstructedText.length;
      reconstructedText += node.textContent;
      const end = reconstructedText.length;
      textNodes.push({ node, start, end });
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      const tagName = node.tagName.toUpperCase();
      
      if (tagName === 'BR') {
        reconstructedText += '\n';
      } else if (tagName === 'SPAN' || tagName === 'MARK') {
        const rect = node.getBoundingClientRect();

        if (lastRect && rect.width > 0 && lastRect.width > 0) {
          const yDiff = Math.abs(rect.top - lastRect.top);
          const xDiff = rect.left - lastRect.right;
          
          if (yDiff > yThreshold) {
            reconstructedText += '\n';
          } else if (xDiff > xThreshold) {
            reconstructedText += ' ';
          }
        }

        if (rect.width > 0) {
          lastRect = rect;
        }

        for (let i = 0; i < node.childNodes.length; i++) {
          traverse(node.childNodes[i]);
        }
      }
    }
  }

  for (let i = 0; i < container.childNodes.length; i++) {
    traverse(container.childNodes[i]);
  }

  const targetStart = charOffset;
  const targetEnd = charOffset + length;

  for (const item of textNodes) {
    const overlapStart = Math.max(item.start, targetStart);
    const overlapEnd = Math.min(item.end, targetEnd);

    if (overlapStart < overlapEnd) {
      const localStart = overlapStart - item.start;
      const localLength = overlapEnd - overlapStart;

      try {
        const textNodeToHighlight = item.node.splitText(localStart);
        textNodeToHighlight.splitText(localLength);

        const mark = document.createElement('mark');
        mark.className = `readflow-highlight level-${Math.min(lookups || 1, 3)}`;
        mark.dataset.vocabId = vocabId;
        mark.dataset.word = textNodeToHighlight.textContent;

        textNodeToHighlight.parentNode.insertBefore(mark, textNodeToHighlight);
        mark.appendChild(textNodeToHighlight);
      } catch (err) {
        console.warn("Failed splitting text node for highlight range:", err);
      }
    }
  }
}

// --- Floating Toast tooltips UI ---
function showToastLoading(word, selectionRect) {
  removeToast();
  
  const toast = document.createElement('div');
  toast.className = 'readflow-toast';
  toast.innerHTML = `
    <div class="toast-header">
      <span class="toast-word">${escapeHtml(word)}</span>
    </div>
    <div style="font-size: 11px; color: var(--text-muted);">正在查询翻译...</div>
  `;
  
  positionAndShowToast(toast, selectionRect);
}

function showToastResult(vocabItem, selectionRect) {
  removeToast();

  const toast = document.createElement('div');
  toast.className = 'readflow-toast';
  
  const phoneticHtml = vocabItem.phonetic 
    ? `<div class="toast-dict-phonetic">${escapeHtml(vocabItem.phonetic)}</div>` 
    : '';

  toast.innerHTML = `
    <div class="toast-header">
      <span class="toast-word" title="${escapeHtml(vocabItem.word)}">${escapeHtml(vocabItem.word)}</span>
      <div class="toast-actions">
        <button class="toast-action-btn speak-btn" title="朗读单词">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon>
            <path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"></path>
          </svg>
        </button>
        <button class="toast-action-btn close-btn" title="关闭">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <line x1="18" y1="6" x2="6" y2="18"></line>
            <line x1="6" y1="6" x2="18" y2="18"></line>
          </svg>
        </button>
      </div>
    </div>
    ${phoneticHtml}
    <div class="toast-translation">${escapeHtml(vocabItem.translation)}</div>
    <div style="display: flex; align-items: center; justify-content: space-between; margin-top: 4px;">
      <span class="toast-badge">已记录 (${vocabItem.lookups}次)</span>
      <span style="font-size: 9px; color: var(--text-muted);">P. ${vocabItem.page}</span>
    </div>
  `;

  toast.querySelector('.speak-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    speakWord(vocabItem.word);
  });

  toast.querySelector('.close-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    removeToast();
  });

  toast.addEventListener('mouseenter', () => {
    if (toastTimeout) clearTimeout(toastTimeout);
  });

  toast.addEventListener('mouseleave', () => {
    startToastFadeTimer(1000);
  });

  positionAndShowToast(toast, selectionRect);
  startToastFadeTimer(2500);
}

function showToastError(word, selectionRect) {
  removeToast();
  
  const toast = document.createElement('div');
  toast.className = 'readflow-toast';
  toast.innerHTML = `
    <div class="toast-header">
      <span class="toast-word">${escapeHtml(word)}</span>
      <button class="toast-action-btn close-btn">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <line x1="18" y1="6" x2="6" y2="18"></line>
          <line x1="6" y1="6" x2="18" y2="18"></line>
        </svg>
      </button>
    </div>
    <div style="font-size: 11px; color: var(--danger);">翻译请求失败，请检查网络。</div>
  `;
  
  toast.querySelector('.close-btn').addEventListener('click', () => removeToast());
  positionAndShowToast(toast, selectionRect);
  startToastFadeTimer(3000);
}

function positionAndShowToast(toast, selectionRect) {
  const viewerContainer = document.getElementById('viewerContainer');
  viewerContainer.appendChild(toast);
  
  const viewportRect = viewerContainer.getBoundingClientRect();
  const toastWidth = toast.offsetWidth || 260;
  const toastHeight = toast.offsetHeight || 100;
  
  let left = selectionRect.left - viewportRect.left + viewerContainer.scrollLeft + (selectionRect.width / 2) - (toastWidth / 2);
  let top = selectionRect.top - viewportRect.top + viewerContainer.scrollTop - toastHeight - 12;

  // Align boundaries
  if (left < 10) left = 10;
  if (left + toastWidth > viewerContainer.scrollWidth - 10) {
    left = viewerContainer.scrollWidth - toastWidth - 10;
  }
  
  if (selectionRect.top - viewportRect.top < toastHeight + 20) {
    top = selectionRect.top - viewportRect.top + viewerContainer.scrollTop + selectionRect.height + 12;
  }

  toast.style.left = `${left}px`;
  toast.style.top = `${top}px`;

  requestAnimationFrame(() => {
    toast.classList.add('active');
  });
}

function removeToast() {
  if (toastTimeout) clearTimeout(toastTimeout);
  const toast = document.querySelector('.readflow-toast');
  if (toast) {
    toast.classList.remove('active');
    setTimeout(() => {
      if (toast && toast.parentNode) toast.parentNode.removeChild(toast);
    }, 250);
  }
}

function startToastFadeTimer(duration) {
  if (toastTimeout) clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => {
    removeToast();
  }, duration);
}

function speakWord(word) {
  if ('speechSynthesis' in window) {
    const utterance = new SpeechSynthesisUtterance(word);
    utterance.lang = 'en-US';
    window.speechSynthesis.speak(utterance);
  }
}

// --- Sidebar Vocabulary Manager ---
function renderSidebarVocabList() {
  if (!vocabListContainer) return;
  vocabListContainer.innerHTML = '';
  
  const query = searchInput.value.toLowerCase().trim();
  const scope = selectScope.value;
  const sort = selectSort.value;
  const currentPdf = getCurrentPdfName();

  let list = vocabList;
  if (scope === 'current') {
    list = vocabList.filter(item => item.source_pdf === currentPdf);
  }

  if (query) {
    list = list.filter(item => 
      item.word.toLowerCase().includes(query) || 
      item.translation.toLowerCase().includes(query) || 
      (item.contexts || []).some(c => c.sentence.toLowerCase().includes(query))
    );
  }

  list.sort((a, b) => {
    if (sort === 'time-desc') return b.timestamp - a.timestamp;
    if (sort === 'time-asc') return a.timestamp - b.timestamp;
    if (sort === 'lookups-desc') return b.lookups - a.lookups;
    if (sort === 'alpha') return a.word.localeCompare(b.word);
    return 0;
  });

  if (list.length === 0) {
    vocabListContainer.innerHTML = `
      <div class="empty-state">
        <svg viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="opacity: 0.4;">
          <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"></path>
          <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"></path>
        </svg>
        <p>${query ? '未搜索到匹配的词汇' : '词汇列表为空'}</p>
      </div>
    `;
    return;
  }

  const cardMode = settings.cardDetailMode || 'contextual';
  list.forEach(item => {
    const card = document.createElement('div');
    card.className = `vocab-card level-${Math.min(item.lookups || 1, 3)} card-mode-${cardMode}`;
    const contexts = item.contexts || [];

    let innerContent = `
      <div class="card-top">
        <div class="card-word-title">
          <span>${escapeHtml(item.word)}</span>
          <span class="card-lookups-badge">${item.lookups || 1}次查询</span>
        </div>
        <div class="card-actions">
          <button class="card-btn speak-btn" title="朗读" aria-label="朗读单词">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon>
              <path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"></path>
            </svg>
          </button>
          <button class="card-btn jump-btn" title="跳转到 PDF 页面" aria-label="跳转到 PDF 页面">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="10"></circle>
              <circle cx="12" cy="12" r="6"></circle>
              <circle cx="12" cy="12" r="2"></circle>
            </svg>
          </button>
          <button class="card-btn delete-btn delete" title="删除" aria-label="删除单词">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="3 6 5 6 21 6"></polyline>
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
              <line x1="10" y1="11" x2="10" y2="17"></line>
              <line x1="14" y1="11" x2="14" y2="17"></line>
            </svg>
          </button>
        </div>
      </div>
      <div class="card-translation">${escapeHtml(item.translation)}</div>
    `;

    // Multi-sentence contexts (v3.0)
    if (cardMode !== 'minimal' && contexts.length > 0) {
      const maxVisible = 3;
      const visibleContexts = contexts.slice(0, maxVisible);
      const hiddenContexts = contexts.slice(maxVisible);

      let contextsHtml = '<div class="card-contexts">';
      visibleContexts.forEach(ctx => {
        const highlighted = highlightWordInText(ctx.sentence, item.word);
        contextsHtml += `
          <div class="context-item">
            <span class="context-page-badge">P.${ctx.page}</span>
            <span class="context-sentence">${highlighted}</span>
          </div>
        `;
      });

      if (hiddenContexts.length > 0) {
        contextsHtml += `<div class="context-hidden" style="display: none;">`;
        hiddenContexts.forEach(ctx => {
          const highlighted = highlightWordInText(ctx.sentence, item.word);
          contextsHtml += `
            <div class="context-item">
              <span class="context-page-badge">P.${ctx.page}</span>
              <span class="context-sentence">${highlighted}</span>
            </div>
          `;
        });
        contextsHtml += `</div>`;
        contextsHtml += `<button class="context-expand-btn" data-collapsed="true">展开更多 (${hiddenContexts.length}条)</button>`;
      }

      contextsHtml += '</div>';
      innerContent += contextsHtml;
    }

    if (cardMode === 'full') {
      const pages = [...new Set(contexts.map(c => c.page))].sort((a, b) => a - b);
      innerContent += `
        <div class="card-meta">
          <span class="source-pdf" title="${escapeHtml(item.source_pdf)}">
            <svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display: inline-block; vertical-align: middle; margin-right: 3px; opacity: 0.8;">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
              <polyline points="14 2 14 8 20 8"></polyline>
            </svg>
            <span>${escapeHtml(item.source_pdf)}</span>
          </span>
          <span>第 ${pages.join(', ')} 页</span>
        </div>
      `;
    }

    card.innerHTML = innerContent;

    card.querySelector('.speak-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      speakWord(item.word);
    });

    card.querySelector('.jump-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      jumpToWordLocation(item);
    });

    card.querySelector('.delete-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      deleteVocabWord(item.id);
    });

    // Expand/collapse button for extra contexts
    const expandBtn = card.querySelector('.context-expand-btn');
    if (expandBtn) {
      expandBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const hidden = card.querySelector('.context-hidden');
        const isCollapsed = expandBtn.dataset.collapsed === 'true';
        if (hidden) {
          hidden.style.display = isCollapsed ? 'block' : 'none';
        }
        expandBtn.dataset.collapsed = isCollapsed ? 'false' : 'true';
        expandBtn.textContent = isCollapsed ? '收起' : `展开更多 (${contexts.length - 3}条)`;
      });
    }

    card.addEventListener('dblclick', () => {
      jumpToWordLocation(item);
    });

    vocabListContainer.appendChild(card);
  });
}

function jumpToWordLocation(item) {
  // v3.0: Jump to the most recent context's page
  if (!window.PDFViewerApplication) return;
  
  const contexts = item.contexts || [];
  if (contexts.length === 0) return;
  
  // Jump to the most recently added context
  const latestCtx = contexts.reduce((latest, ctx) => 
    (ctx.addedAt || 0) > (latest.addedAt || 0) ? ctx : latest, contexts[0]);
  
  window.PDFViewerApplication.page = latestCtx.page;
  
  // After page changes and renders, trigger flashing highlights
  setTimeout(() => {
    const pageDiv = document.querySelector(`.page[data-page-number="${latestCtx.page}"]`);
    if (!pageDiv) return;
    
    const mark = pageDiv.querySelector(`mark[data-vocab-id="${item.id}"]`);
    if (mark) {
      mark.classList.add('highlight-flash');
      setTimeout(() => {
        mark.classList.remove('highlight-flash');
      }, 1000);
    }
  }, 500);
}

function highlightWordInText(text, word) {
  if (!text || !word) return escapeHtml(text || '');
  const escaped = escapeHtml(text);
  const escapedWord = word.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
  const regex = new RegExp(`(${escapedWord})`, 'gi');
  return escaped.replace(regex, '<mark>$1</mark>');
}

// --- CSV and Anki Card Exports (v3.0 Word-Centric) ---
function exportVocabCsv() {
  let list = vocabList;
  const currentPdf = getCurrentPdfName();
  if (selectScope.value === 'current') {
    list = vocabList.filter(item => item.source_pdf === currentPdf);
  }

  if (list.length === 0) {
    alert('当前没有可导出的词汇！');
    return;
  }

  const csvRows = [
    ['Word', 'Translation', 'Lookups', 'Sentences', 'Pages', 'Source PDF', 'Last Queried']
  ];

  list.forEach(item => {
    const contexts = item.contexts || [];
    const sentences = contexts.map(c => c.sentence).join('\n');
    const pages = [...new Set(contexts.map(c => c.page))].sort((a, b) => a - b).join(', ');
    
    csvRows.push([
      item.word,
      item.translation,
      (item.lookups || 1).toString(),
      sentences,
      pages,
      item.source_pdf,
      new Date(item.timestamp).toLocaleString()
    ]);
  });

  const csvContent = "data:text/csv;charset=utf-8,\ufeff" 
    + csvRows.map(e => e.map(val => `"${(val || '').replace(/"/g, '""')}"`).join(",")).join("\n");
  
  const encodedUri = encodeURI(csvContent);
  const link = document.createElement("a");
  link.setAttribute("href", encodedUri);
  link.setAttribute("download", `ReadFlow_Export_${Date.now()}.csv`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

function exportVocabAnki() {
  let list = vocabList;
  const currentPdf = getCurrentPdfName();
  if (selectScope.value === 'current') {
    list = vocabList.filter(item => item.source_pdf === currentPdf);
  }

  if (list.length === 0) {
    alert('当前没有可导出的词汇！');
    return;
  }

  let fileContent = '';
  list.forEach(item => {
    const word = item.word;
    const phonetic = item.phonetic ? `[${item.phonetic}] ` : '';
    const translation = item.translation.replace(/\n/g, '<br>');
    const contexts = item.contexts || [];
    
    // Build context HTML with all sentences, each with page number
    const contextHtml = contexts.map(ctx => {
      const boldWord = ctx.sentence.replace(
        new RegExp(`(${word.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&')})`, 'gi'), 
        '<b>$1</b>'
      );
      return `<small>P.${ctx.page}: ${boldWord}</small>`;
    }).join('<br>');

    const source = `${item.source_pdf}`;

    const backContent = `${phonetic}<strong>${translation}</strong><br><br>${contextHtml}<br><br><small style="color:#888;">Source: ${source} | ${item.lookups || 1}x lookups</small>`;
    fileContent += `${word}\t${backContent}\n`;
  });

  const blob = new Blob([fileContent], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.setAttribute("href", url);
  link.setAttribute("download", `Anki_ReadFlow_${Date.now()}.txt`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

// --- Helpers ---
function getCurrentPdfName() {
  try {
    if (!window.PDFViewerApplication) return 'document.pdf';
    const app = window.PDFViewerApplication;
    
    // Check if the title is set and ends with .pdf (e.g. from local file open or drag-and-drop)
    if (app._title && app._title.toLowerCase().endsWith('.pdf')) {
      return app._title;
    }
    
    const url = app.url;
    if (!url) return 'document.pdf';
    if (url.startsWith('blob:')) {
      return app.contentDispositionFilename || 'local_document.pdf';
    }
    const pathname = new URL(url).pathname;
    const parts = pathname.split('/');
    const lastPart = parts[parts.length - 1];
    return lastPart.endsWith('.pdf') ? decodeURIComponent(lastPart) : 'document.pdf';
  } catch (e) {
    return 'document.pdf';
  }
}

function escapeHtml(unsafe) {
  return unsafe
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// --- Theme Applier ---
function applyTheme() {
  const theme = settings.theme || 'light';
  const outer = document.getElementById('outerContainer');
  if (!outer) return;

  if (theme === 'light') {
    outer.setAttribute('data-theme', 'light');
  } else if (theme === 'custom') {
    outer.setAttribute('data-theme', 'custom');
  } else {
    outer.setAttribute('data-theme', 'dark');
  }

  const viewer = document.getElementById('viewer');
  if (viewer) {
    viewer.classList.toggle('invert-pages', theme === 'dark-all');
  }

  // Apply accent color
  applyAccentColor(settings.accentHue, settings.accentSaturation);
}

// --- Welcome Screen Overlay Loader ---
function initWelcomeOverlay() {
  const urlParams = new URLSearchParams(window.location.search);
  const hasFile = urlParams.has('file');
  const hasBookId = urlParams.has('bookId');

  if (!hasFile && !hasBookId) {
    // Check startup behavior: redirect to library if set
    const startupBehavior = settings.startupBehavior || 'library';
    if (startupBehavior === 'library') {
      window.location.href = chrome.runtime.getURL('library.html');
      return;
    }

    // 'reopen' behavior: show welcome overlay with library shortcut
    showStandardWelcomeOverlay();
  }
}

function showStandardWelcomeOverlay() {
  if (document.getElementById('readflow-welcome-overlay')) return;

  const overlay = document.createElement('div');
  overlay.id = 'readflow-welcome-overlay';
  overlay.innerHTML = `
    <div class="welcome-card">
      <div class="welcome-title">ReadFlow PDF \u9605\u8bfb\u5668</div>
      <div class="welcome-subtitle">\u5f00\u59cb\u60a8\u7684\u987a\u6d41\u9605\u8bfb\u4e4b\u65c5\uff0c\u53cc\u51fb\u8bcd\u6c47\u5373\u523b\u7ffb\u8bd1\u5e76\u8bb0\u5f55\u3002</div>
      <button id="welcome-goto-library" class="welcome-library-btn">
        \ud83d\udcda \u524d\u5f80\u4e66\u67b6
      </button>
      <div id="welcome-dropzone" class="welcome-dropzone">
        <svg viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
          <polyline points="17 8 12 3 7 8"></polyline>
          <line x1="12" y1="3" x2="12" y2="15"></line>
        </svg>
        <span>\u62d6\u62fd PDF \u6587\u4ef6\u5230\u6b64\u5904</span>
        <p>\u6216\u8005\u70b9\u51fb\u533a\u57df\u6d4f\u89c8\u672c\u5730\u6587\u4ef6</p>
      </div>
    </div>
  `;

  const outerContainer = document.getElementById('outerContainer');
  if (outerContainer) outerContainer.appendChild(overlay);

  document.getElementById('welcome-goto-library')?.addEventListener('click', () => {
    window.location.href = chrome.runtime.getURL('library.html');
  });

  const dropzone = document.getElementById('welcome-dropzone');
  if (dropzone) {
    dropzone.addEventListener('click', () => {
      const fileInput = document.getElementById('fileInput');
      if (fileInput) fileInput.click();
    });
    dropzone.addEventListener('dragover', (e) => {
      e.preventDefault();
      dropzone.classList.add('drag-over');
    });
    dropzone.addEventListener('dragleave', () => dropzone.classList.remove('drag-over'));
    dropzone.addEventListener('drop', (e) => {
      e.preventDefault();
      dropzone.classList.remove('drag-over');
      const files = e.dataTransfer.files;
      if (files && files.length > 0) {
        const file = files[0];
        if (file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')) {
          if (window.PDFViewerApplication) {
            window.PDFViewerApplication.open({ url: URL.createObjectURL(file), originalUrl: file.name });
          }
        } else {
          alert('\u8bf7\u9009\u62e9\u6709\u6548\u7684 PDF \u6587\u4ef6\uff01');
        }
      }
    });
  }
}

function hideWelcomeOverlay() {
  const overlay = document.getElementById('readflow-welcome-overlay');
  if (overlay) {
    overlay.classList.add('hidden');
    setTimeout(() => {
      if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
    }, 300);
  }
}

// --- System Toast Messages ---
function showSystemToast(message) {
  const existing = document.querySelector('.readflow-toast.system-toast');
  if (existing && existing.parentNode) {
    existing.parentNode.removeChild(existing);
  }
  
  const toast = document.createElement('div');
  toast.className = 'readflow-toast system-toast';
  toast.style.position = 'fixed';
  toast.style.top = '24px';
  toast.style.left = '50%';
  toast.style.transform = 'translateX(-50%) translateY(-20px)';
  toast.style.transition = 'all var(--transition-normal)';
  toast.style.opacity = '0';
  toast.style.zIndex = '10000002';
  toast.style.background = 'var(--primary)';
  toast.style.color = '#ffffff';
  toast.style.padding = '10px 20px';
  toast.style.borderRadius = '20px';
  toast.style.boxShadow = 'var(--shadow-lg)';
  toast.style.fontSize = '12px';
  toast.style.fontWeight = '600';
  
  toast.innerHTML = `
    <div style="display: flex; align-items: center; gap: 8px;">
      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="12" r="10"></circle>
        <line x1="12" y1="16" x2="12" y2="12"></line>
        <line x1="12" y1="8" x2="12.01" y2="8"></line>
      </svg>
      <span>${escapeHtml(message)}</span>
    </div>
  `;
  
  document.body.appendChild(toast);
  
  requestAnimationFrame(() => {
    toast.style.transform = 'translateX(-50%) translateY(0)';
    toast.style.opacity = '1';
  });
  
  setTimeout(() => {
    toast.style.transform = 'translateX(-50%) translateY(-20px)';
    toast.style.opacity = '0';
    setTimeout(() => {
      if (toast && toast.parentNode) toast.parentNode.removeChild(toast);
    }, 300);
  }, 2500);
}

// --- v2.0: Accent Color ---
function applyAccentColor(hue, saturation) {
  if (hue === undefined || hue === null) return;
  const h = hue;
  const s = saturation || 75;
  const root = document.getElementById('outerContainer') || document.documentElement;
  root.style.setProperty('--primary', `hsl(${h}, ${s}%, 42%)`);
  root.style.setProperty('--primary-light', `hsl(${h}, ${s}%, 55%)`);
  root.style.setProperty('--primary-gradient',
    `linear-gradient(135deg, hsl(${h}, ${s}%, 38%) 0%, hsl(${h}, ${s + 5}%, 52%) 100%)`);
  root.style.setProperty('--primary-subtle', `hsla(${h}, ${s}%, 50%, 0.08)`);

  // Apply custom theme background colors if custom theme is active
  if (settings.theme === 'custom') {
    const isGradient = settings.bgStyle === 'gradient';
    const hEnd = settings.accentHueEnd !== undefined ? settings.accentHueEnd : 200;
    
    // Soft Kindle-like background (saturation 28%, lightness 92%)
    const bgVal = isGradient
      ? `linear-gradient(135deg, hsl(${h}, 28%, 92%) 0%, hsl(${hEnd}, 28%, 92%) 100%)`
      : `hsl(${h}, 28%, 92%)`;
    
    const bgHeaderVal = `rgba(255, 255, 255, 0.45)`;
    const bgSidebarVal = `rgba(255, 255, 255, 0.55)`;
    const bgCardVal = `rgba(255, 255, 255, 0.75)`;
    const bgCardHoverVal = `rgba(255, 255, 255, 0.9)`;
    const borderVal = `hsla(${h}, 20%, 75%, 0.4)`;
    const borderStrongVal = `hsla(${h}, 20%, 65%, 0.6)`;
    
    root.style.setProperty('--custom-bg-app', bgVal);
    root.style.setProperty('--custom-bg-workspace', 'transparent');
    root.style.setProperty('--custom-bg-sidebar', bgSidebarVal);
    root.style.setProperty('--custom-bg-card', bgCardVal);
    root.style.setProperty('--custom-bg-card-hover', bgCardHoverVal);
    root.style.setProperty('--custom-border', borderVal);
    root.style.setProperty('--custom-border-strong', borderStrongVal);
  }
}

function updateSwatchActiveState(activeHue) {
  document.querySelectorAll('.color-swatch').forEach(sw => {
    const h = parseInt(sw.dataset.hue);
    sw.classList.toggle('active', Math.abs(h - activeHue) < 3);
  });
}

// --- v2.0: Fullscreen Mode ---
let _fsEdgeHandler = null;

function toggleFullscreenMode() {
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen().then(() => {
      // In fullscreen: switch to page-width zoom by default
      if (window.PDFViewerApplication && window.PDFViewerApplication.pdfViewer) {
        window.PDFViewerApplication.pdfViewer.currentScaleValue = 'page-width';
      }
    }).catch(err => {
      console.warn('[ReadFlow] Fullscreen request failed:', err);
    });
  } else {
    document.exitFullscreen();
  }
}

function onFullscreenChange() {
  const isFs = !!document.fullscreenElement;
  const outer = document.getElementById('outerContainer');
  if (outer) outer.classList.toggle('readflow-fullscreen', isFs);

  // Update toolbar button icon (both in FAB and in settings if it exists)
  const btnFs = document.getElementById('btn-toggle-fullscreen');
  const btnFsSetting = document.getElementById('btn-toggle-fullscreen-setting');
  const fsLabel = isFs ? '退出全屏' : '全屏阅读模式';
  const fsBtnText = isFs ? '⛶ 退出全屏' : '⛶ 进入全屏';

  if (btnFs) {
    btnFs.title = fsLabel;
    btnFs.innerHTML = isFs
      ? `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="pointer-events:none"><path d="M8 3v3a2 2 0 0 1-2 2H3m18 0h-3a2 2 0 0 1-2-2V3m0 18v-3a2 2 0 0 1 2-2h3M3 16h3a2 2 0 0 1 2 2v3"></path></svg>`
      : `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="pointer-events:none"><path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"></path></svg>`;
  }
  if (btnFsSetting) {
    btnFsSetting.textContent = fsBtnText;
  }

  // Edge hover: reveal sidebars and toolbar in fullscreen
  if (isFs) {
    _fsEdgeHandler = (e) => {
      const sb = document.getElementById('sidebar');
      const sbc = document.getElementById('sidebarContainer');
      const tb = document.getElementById('toolbarContainer');
      const fabToggle = document.getElementById('btn-toggle-sidebar');
      const fabFs = document.getElementById('btn-toggle-fullscreen');
      const fabLib = document.getElementById('btn-back-to-library');

      // 1. Top toolbar hover (within 48px of top or when mouse is inside toolbar)
      const atTop = e.clientY < 48;
      if (tb) {
        tb.classList.toggle('show-toolbar', atTop);
      }

      // 2. Left sidebar hover (within 40px of left)
      const atLeftEdge = e.clientX < 40;
      if (sbc) {
        sbc.classList.toggle('reveal-left', atLeftEdge);
      }

      // 3. Right sidebar hover (within 40px of right)
      const atRightEdge = e.clientX > window.innerWidth - 40;
      if (sb && settings.sidebarOpen) {
        sb.classList.toggle('reveal-right', atRightEdge);
      }

      // 4. FAB opacity fade in fullscreen
      const nearAnyFab = (e.clientX > window.innerWidth - 80 && e.clientY > window.innerHeight - 220);
      const fabs = [fabToggle, fabFs, fabLib];
      fabs.forEach(f => {
        if (f) {
          f.style.opacity = (nearAnyFab || atRightEdge) ? '1' : '0.15';
        }
      });
    };
    document.addEventListener('mousemove', _fsEdgeHandler);
  } else {
    if (_fsEdgeHandler) {
      document.removeEventListener('mousemove', _fsEdgeHandler);
      _fsEdgeHandler = null;
    }
    // Restore layout styles
    const sb = document.getElementById('sidebar');
    const sbc = document.getElementById('sidebarContainer');
    const tb = document.getElementById('toolbarContainer');
    const fabToggle = document.getElementById('btn-toggle-sidebar');
    const fabFs = document.getElementById('btn-toggle-fullscreen');
    const fabLib = document.getElementById('btn-back-to-library');

    if (sb) { sb.classList.remove('reveal-right'); }
    if (sbc) { sbc.classList.remove('reveal-left'); }
    if (tb) { tb.classList.remove('show-toolbar'); }
    
    const fabs = [fabToggle, fabFs, fabLib];
    fabs.forEach(f => { if (f) f.style.opacity = ''; });
  }
}

// --- v2.0: Custom AI Translation ---
async function translateCustomAI(word, context) {
  const baseUrl = settings.customAiBaseUrl.replace(/\/$/, '');
  const apiKey = settings.customAiKey;
  const model = settings.customAiModel || 'deepseek-chat';
  const targetLangName = LANG_NAMES[settings.targetLang] || 'Chinese (Simplified)';

  // Build prompt from template or use default
  const promptTemplate = settings.customAiPrompt ||
    'Translate "{word}" into {targetLang}. Context: "{context}". Provide a concise dictionary-style translation only.';
  const prompt = promptTemplate
    .replace(/{word}/g, word)
    .replace(/{context}/g, context || '')
    .replace(/{targetLang}/g, targetLangName);

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 256,
      temperature: 0.3,
    }),
  });

  if (!response.ok) {
    const errData = await response.json().catch(() => ({}));
    throw new Error(errData.error?.message || `HTTP ${response.status}`);
  }

  const data = await response.json();
  const translation = data.choices?.[0]?.message?.content?.trim() || '';
  return { translation, phonetic: '' };
}

async function testCustomAiConnection() {
  const resultEl = document.getElementById('custom-ai-test-result');
  const btnTest = document.getElementById('btn-test-custom-ai');
  if (!resultEl || !btnTest) return;

  const baseUrl = (setCustomAiBaseUrl?.value || '').replace(/\/$/, '');
  const apiKey = setCustomAiKey?.value || '';
  const model = setCustomAiModel?.value || 'deepseek-chat';

  if (!baseUrl || !apiKey) {
    resultEl.textContent = '\u26a0\ufe0f \u8bf7\u5148\u586b\u5199 URL \u548c API Key';
    resultEl.style.color = 'var(--danger)';
    return;
  }

  btnTest.disabled = true;
  btnTest.textContent = '\u6d4b\u8bd5\u4e2d...';
  resultEl.textContent = '';

  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'Reply with the single word: OK' }],
        max_tokens: 10,
        temperature: 0,
      }),
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(err.error?.message || `HTTP ${response.status}`);
    }

    const data = await response.json();
    const reply = data.choices?.[0]?.message?.content?.trim();
    resultEl.textContent = `\u2705 \u8fde\u63a5\u6210\u529f\uff01\u6a21\u578b\u56de\u590d: "${reply}"`;
    resultEl.style.color = 'var(--success, #16a34a)';
  } catch (e) {
    resultEl.textContent = `\u274c \u5931\u8d25: ${e.message}`;
    resultEl.style.color = 'var(--danger)';
  } finally {
    btnTest.disabled = false;
    btnTest.textContent = '\ud83d\udd0d \u6d4b\u8bd5\u8fde\u63a5';
  }
}

// --- IndexedDB for Library Sync ---
const LIB_DB_NAME = 'readflow_library_v2';
const LIB_STORE_NAME = 'files';

function openLibraryDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(LIB_DB_NAME, 1);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(LIB_STORE_NAME)) {
        const store = db.createObjectStore(LIB_STORE_NAME, { keyPath: 'id' });
        store.createIndex('lastOpenedAt', 'lastOpenedAt', { unique: false });
      }
    };
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror = (e) => reject(e.target.error);
  });
}

async function saveLastReadPage(bookId, pageNum) {
  if (!bookId) return;
  try {
    const db = await openLibraryDB();
    const tx = db.transaction(LIB_STORE_NAME, 'readwrite');
    const store = tx.objectStore(LIB_STORE_NAME);
    
    // Get entry first
    const entry = await new Promise((resolve, reject) => {
      const getReq = store.get(bookId);
      getReq.onsuccess = () => resolve(getReq.result);
      getReq.onerror = () => reject(getReq.error);
    });
    
    if (entry) {
      entry.lastReadPage = pageNum;
      entry.lastOpenedAt = Date.now();
      await new Promise((resolve, reject) => {
        const putReq = store.put(entry);
        putReq.onsuccess = () => resolve();
        putReq.onerror = () => reject(putReq.error);
      });
    }
  } catch (err) {
    console.error('[ReadFlow] Failed to save last read page:', err);
  }
}

async function loadBookFromLibrary(bookId) {
  try {
    const db = await openLibraryDB();
    const tx = db.transaction(LIB_STORE_NAME, 'readonly');
    const store = tx.objectStore(LIB_STORE_NAME);
    const entry = await new Promise((resolve, reject) => {
      const getReq = store.get(bookId);
      getReq.onsuccess = () => resolve(getReq.result);
      getReq.onerror = () => reject(getReq.error);
    });

    if (!entry || !entry.handle) {
      showSystemToast('未找到该图书记录');
      showStandardWelcomeOverlay();
      return;
    }

    // Request read permission if needed (usually already active from library tab)
    let perm = await entry.handle.queryPermission({ mode: 'read' });
    if (perm === 'prompt') {
      perm = await entry.handle.requestPermission({ mode: 'read' });
    }
    if (perm !== 'granted') {
      showSystemToast('需要文件读取权限才能打开');
      showStandardWelcomeOverlay();
      return;
    }

    const file = await entry.handle.getFile();
    const localBlobUrl = URL.createObjectURL(file);
    
    if (window.PDFViewerApplication) {
      window.PDFViewerApplication.open({ url: localBlobUrl, originalUrl: entry.name });
    }
  } catch (err) {
    console.error('[ReadFlow] Failed to load book from IndexedDB:', err);
    showSystemToast('打开图书失败，请在书架重新打开');
    showStandardWelcomeOverlay();
  }
}

