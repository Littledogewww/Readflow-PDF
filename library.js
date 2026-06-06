// library.js - ReadFlow PDF Library v2.0
// Uses File System Access API + IndexedDB for persistent file handles

'use strict';

// ============================================================
// Constants
// ============================================================
const DB_NAME = 'readflow_library_v2';
const DB_VERSION = 1;
const STORE_NAME = 'files';
const VIEWER_URL = chrome.runtime.getURL('pdfjs-viewer/web/viewer.html');

// ============================================================
// IndexedDB Setup
// ============================================================
let db = null;

async function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
        store.createIndex('lastOpenedAt', 'lastOpenedAt', { unique: false });
      }
    };
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror = (e) => reject(e.target.error);
  });
}

async function dbGetAll() {
  const tx = db.transaction(STORE_NAME, 'readonly');
  const store = tx.objectStore(STORE_NAME);
  return new Promise((resolve, reject) => {
    const req = store.index('lastOpenedAt').getAll();
    req.onsuccess = () => {
      // sort most recent first
      const sorted = (req.result || []).sort((a, b) => b.lastOpenedAt - a.lastOpenedAt);
      resolve(sorted);
    };
    req.onerror = () => reject(req.error);
  });
}

async function dbPut(entry) {
  const tx = db.transaction(STORE_NAME, 'readwrite');
  const store = tx.objectStore(STORE_NAME);
  return new Promise((resolve, reject) => {
    const req = store.put(entry);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

async function dbDelete(id) {
  const tx = db.transaction(STORE_NAME, 'readwrite');
  const store = tx.objectStore(STORE_NAME);
  return new Promise((resolve, reject) => {
    const req = store.delete(id);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

// ============================================================
// File Handle Validation
// ============================================================
async function validateHandle(entry) {
  if (!entry.handle) return 'missing';
  try {
    let perm = await entry.handle.queryPermission({ mode: 'read' });
    if (perm === 'prompt') {
      perm = await entry.handle.requestPermission({ mode: 'read' });
    }
    if (perm !== 'granted') return 'denied';

    // Actually try to access the file to confirm it still exists
    await entry.handle.getFile();
    return 'ok';
  } catch (e) {
    if (e.name === 'NotFoundError') return 'deleted';
    return 'error';
  }
}

async function validateAllHandles(entries) {
  const results = [];
  for (const entry of entries) {
    const status = await validateHandle(entry);
    if (status === 'deleted') {
      // Silently remove from DB
      await dbDelete(entry.id);
      showToast(`「${entry.name}」已从书架移除（源文件已删除）`);
    } else {
      results.push({ ...entry, _status: status });
    }
  }
  return results;
}

// ============================================================
// Thumbnail Generation (PDF.js first page)
// ============================================================
let pdfjsLibInstance = null;

async function getPdfjsLib() {
  if (pdfjsLibInstance) return pdfjsLibInstance;
  try {
    const modulePath = chrome.runtime.getURL('pdfjs-viewer/build/pdf.mjs');
    const pdfjs = await import(modulePath);
    pdfjs.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('pdfjs-viewer/build/pdf.worker.mjs');
    pdfjsLibInstance = pdfjs;
    return pdfjs;
  } catch (e) {
    console.error('[ReadFlow] Failed to import pdf.mjs:', e);
    return null;
  }
}

async function generateThumbnail(fileHandle) {
  try {
    const file = await fileHandle.getFile();
    const arrayBuffer = await file.arrayBuffer();

    const pdfjsLib = await getPdfjsLib();
    if (!pdfjsLib) return null;

    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    const page = await pdf.getPage(1);

    const canvas = document.createElement('canvas');
    const viewport = page.getViewport({ scale: 0.6 });
    canvas.width = viewport.width;
    canvas.height = viewport.height;

    await page.render({
      canvasContext: canvas.getContext('2d'),
      viewport
    }).promise;

    return canvas.toDataURL('image/jpeg', 0.75);
  } catch (e) {
    console.warn('[ReadFlow] Thumbnail generation failed:', e);
    return null;
  }
}

// ============================================================
// Add Files
// ============================================================
async function addFiles(handles) {
  let added = 0;
  for (const handle of handles) {
    try {
      const file = await handle.getFile();
      if (!file.name.toLowerCase().endsWith('.pdf')) {
        showToast(`跳过 ${file.name}：不是 PDF 文件`);
        continue;
      }

      const id = `rf_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      const entry = {
        id,
        name: file.name,
        handle,
        fileSize: file.size,
        addedAt: Date.now(),
        lastOpenedAt: Date.now(),
        thumbnailDataUrl: null,
        lastReadPage: 1,
      };

      await dbPut(entry);
      added++;

      // Generate thumbnail async (non-blocking)
      generateThumbnail(handle).then(async (dataUrl) => {
        if (dataUrl) {
          entry.thumbnailDataUrl = dataUrl;
          await dbPut(entry);
          // Update card in UI if still visible
          const thumbEl = document.querySelector(`[data-book-id="${id}"] .book-thumbnail`);
          if (thumbEl) {
            thumbEl.src = dataUrl;
            thumbEl.style.display = 'block';
            const icon = document.querySelector(`[data-book-id="${id}"] .book-cover-icon`);
            const namePreview = document.querySelector(`[data-book-id="${id}"] .book-cover-name-preview`);
            if (icon) icon.style.display = 'none';
            if (namePreview) namePreview.style.display = 'none';
          }
        }
      }).catch(() => {});
    } catch (e) {
      console.error('[ReadFlow] Failed to add file:', e);
    }
  }
  return added;
}

// ============================================================
// Open a PDF in the viewer
// ============================================================
async function openBook(entry) {
  const status = await validateHandle(entry);
  if (status !== 'ok') {
    if (status === 'deleted') {
      await dbDelete(entry.id);
      showToast('源文件已被删除，已从书架移除');
      renderLibrary();
      return;
    }
    showToast('无法访问该文件，请检查权限');
    return;
  }

  // Update lastOpenedAt
  await dbPut({ ...entry, lastOpenedAt: Date.now() });

  // Save last opened reference (name + id) to chrome.storage for reopen feature
  chrome.storage.local.set({
    lastOpenedBook: { id: entry.id, name: entry.name }
  });

  // Navigate to viewer
  window.location.href = `${VIEWER_URL}?bookId=${encodeURIComponent(entry.id)}&bookName=${encodeURIComponent(entry.name)}`;
}

// ============================================================
// UI Rendering
// ============================================================
function formatFileSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(ts) {
  const d = new Date(ts);
  const now = new Date();
  const diffMs = now - d;
  const diffDays = Math.floor(diffMs / 86400000);
  if (diffDays === 0) return '今天';
  if (diffDays === 1) return '昨天';
  if (diffDays < 7) return `${diffDays} 天前`;
  return d.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });
}

function createBookCard(entry) {
  const card = document.createElement('div');
  card.className = 'book-card';
  card.setAttribute('data-book-id', entry.id);
  card.setAttribute('role', 'listitem');
  card.setAttribute('tabindex', '0');
  card.setAttribute('aria-label', `打开 ${entry.name}`);

  const isMissing = entry._status === 'denied' || entry._status === 'error';

  card.innerHTML = `
    <div class="book-cover-wrapper">
      <div class="book-cover${isMissing ? ' missing' : ''}">
        ${isMissing ? '<span class="book-missing-badge">无法访问</span>' : ''}
        ${entry.thumbnailDataUrl
          ? `<img class="book-thumbnail" src="${entry.thumbnailDataUrl}" alt="${entry.name} 封面">`
          : `
            <svg class="book-cover-icon" viewBox="0 0 24 24" width="40" height="40" fill="none"
                 stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"
                 aria-hidden="true">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
              <polyline points="14 2 14 8 20 8"></polyline>
              <line x1="16" y1="13" x2="8" y2="13"></line>
              <line x1="16" y1="17" x2="8" y2="17"></line>
              <polyline points="10 9 9 9 8 9"></polyline>
            </svg>
            <span class="book-cover-name-preview">${entry.name.replace(/\.pdf$/i, '')}</span>
          `
        }
        <div class="book-overlay">
          <button class="book-open-btn" data-action="open" aria-label="打开 ${entry.name}">打开</button>
        </div>
        <button class="book-menu-btn" data-action="menu" aria-label="更多选项" aria-haspopup="true">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor"
               stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <circle cx="12" cy="5" r="1"></circle>
            <circle cx="12" cy="12" r="1"></circle>
            <circle cx="12" cy="19" r="1"></circle>
          </svg>
        </button>
      </div>
    </div>
    <div class="book-info">
      <p class="book-name" title="${entry.name}">${entry.name.replace(/\.pdf$/i, '')}</p>
      <p class="book-meta">${formatDate(entry.lastOpenedAt)} · ${formatFileSize(entry.fileSize || 0)}</p>
    </div>
  `;

  // Open on card click / enter key
  const openBook_ = () => openBook(entry);
  card.addEventListener('click', (e) => {
    if (e.target.closest('[data-action="menu"]')) return;
    openBook_();
  });
  card.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openBook_(); }
  });

  // Menu button
  card.querySelector('[data-action="menu"]').addEventListener('click', (e) => {
    e.stopPropagation();
    showContextMenu(e, entry);
  });

  return card;
}

async function renderLibrary(searchQuery = '') {
  const grid = document.getElementById('lib-grid');
  const emptyState = document.getElementById('lib-empty-state');
  const loadingState = document.getElementById('lib-loading-state');
  const countEl = document.getElementById('lib-count');

  if (loadingState) loadingState.style.display = 'flex';
  if (emptyState) emptyState.style.display = 'none';

  let entries = await dbGetAll();

  // Validate handles & remove deleted files
  entries = await validateAllHandles(entries);

  // Filter by search
  if (searchQuery.trim()) {
    const q = searchQuery.toLowerCase();
    entries = entries.filter(e => e.name.toLowerCase().includes(q));
  }

  // Clear grid (except loading state placeholder)
  Array.from(grid.querySelectorAll('.book-card')).forEach(el => el.remove());
  if (loadingState) loadingState.style.display = 'none';

  if (entries.length === 0) {
    if (emptyState) emptyState.style.display = 'flex';
    if (countEl) countEl.textContent = '暂无文件';
    return;
  }

  if (countEl) countEl.textContent = `${entries.length} 本书`;

  // Use DocumentFragment for performance
  const frag = document.createDocumentFragment();
  entries.forEach(entry => {
    frag.appendChild(createBookCard(entry));
  });
  grid.appendChild(frag);
}

// ============================================================
// Context Menu
// ============================================================
let activeCtxMenu = null;

function showContextMenu(event, entry) {
  closeContextMenu();

  const menu = document.createElement('div');
  menu.className = 'ctx-menu';
  menu.setAttribute('role', 'menu');
  menu.innerHTML = `
    <button class="ctx-item" data-action="open" role="menuitem">
      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5"
           stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path>
        <polyline points="15 3 21 3 21 9"></polyline>
        <line x1="10" y1="14" x2="21" y2="3"></line>
      </svg>
      打开
    </button>
    <button class="ctx-item danger" data-action="remove" role="menuitem">
      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5"
           stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <polyline points="3 6 5 6 21 6"></polyline>
        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"></path>
      </svg>
      从书架移除
    </button>
  `;

  // Position
  let x = event.clientX;
  let y = event.clientY;
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  document.body.appendChild(menu);

  // Adjust if off screen
  const rect = menu.getBoundingClientRect();
  if (rect.right > window.innerWidth) {
    menu.style.left = `${x - rect.width}px`;
  }
  if (rect.bottom > window.innerHeight) {
    menu.style.top = `${y - rect.height}px`;
  }

  activeCtxMenu = menu;

  // Actions
  menu.querySelector('[data-action="open"]').addEventListener('click', () => {
    closeContextMenu();
    openBook(entry);
  });

  menu.querySelector('[data-action="remove"]').addEventListener('click', async () => {
    closeContextMenu();
    await dbDelete(entry.id);
    showToast(`「${entry.name}」已从书架移除`);
    renderLibrary(currentSearchQuery);
  });

  // Close on outside click
  setTimeout(() => {
    document.addEventListener('click', closeContextMenu, { once: true });
  }, 0);
}

function closeContextMenu() {
  if (activeCtxMenu) {
    activeCtxMenu.remove();
    activeCtxMenu = null;
  }
}

// ============================================================
// Toast
// ============================================================
let toastTimer = null;

function showToast(msg, duration = 3000) {
  const toast = document.getElementById('lib-toast');
  if (!toast) return;
  toast.textContent = msg;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), duration);
}

// ============================================================
// Drag & Drop
// ============================================================
let dragCounter = 0;

function initDragDrop() {
  const overlay = document.getElementById('lib-drag-overlay');
  const footer = document.getElementById('lib-footer');

  document.addEventListener('dragenter', (e) => {
    e.preventDefault();
    dragCounter++;
    if (hasPdfFiles(e.dataTransfer)) {
      overlay.classList.add('active');
      footer.classList.add('drag-over');
    }
  });

  document.addEventListener('dragleave', (e) => {
    dragCounter--;
    if (dragCounter <= 0) {
      dragCounter = 0;
      overlay.classList.remove('active');
      footer.classList.remove('drag-over');
    }
  });

  document.addEventListener('dragover', (e) => {
    e.preventDefault();
    if (hasPdfFiles(e.dataTransfer)) {
      e.dataTransfer.dropEffect = 'copy';
    }
  });

  document.addEventListener('drop', async (e) => {
    e.preventDefault();
    dragCounter = 0;
    overlay.classList.remove('active');
    footer.classList.remove('drag-over');

    const items = Array.from(e.dataTransfer.items || []);
    const handles = [];

    for (const item of items) {
      if (item.kind === 'file') {
        try {
          // File System Access API for persistent handles
          if (item.getAsFileSystemHandle) {
            const handle = await item.getAsFileSystemHandle();
            if (handle && handle.kind === 'file') handles.push(handle);
          } else {
            // Fallback: create a non-persistent handle from File
            const file = item.getAsFile();
            if (file && file.name.toLowerCase().endsWith('.pdf')) {
              // Wrap in a minimal handle-like object for non-FSA browsers
              handles.push(createFallbackHandle(file));
            }
          }
        } catch (err) {
          console.warn('[ReadFlow] Error getting file handle:', err);
        }
      }
    }

    if (handles.length === 0) {
      showToast('请拖入 PDF 文件');
      return;
    }

    const added = await addFiles(handles);
    if (added > 0) {
      showToast(`✓ 已添加 ${added} 个文件`);
      renderLibrary(currentSearchQuery);
    }
  });

  // Footer click
  footer.addEventListener('click', () => {
    document.getElementById('lib-file-input').click();
  });
}

function hasPdfFiles(dataTransfer) {
  if (!dataTransfer || !dataTransfer.items) return false;
  return Array.from(dataTransfer.items).some(
    item => item.kind === 'file' &&
      (item.type === 'application/pdf' || !item.type)
  );
}

// Fallback handle for browsers without File System Access API drag support
function createFallbackHandle(file) {
  return {
    kind: 'file',
    name: file.name,
    _file: file,
    getFile: async () => file,
    queryPermission: async () => 'granted',
    requestPermission: async () => 'granted',
  };
}

// ============================================================
// File Input (add button)
// ============================================================
async function initFileInput() {
  const input = document.getElementById('lib-file-input');
  if (!input) return;

  input.addEventListener('change', async () => {
    const files = Array.from(input.files || []);
    if (files.length === 0) return;

    // We can't get persistent FileSystemFileHandle from <input type="file">
    // so we use the showOpenFilePicker API for persistent access
    // But as a fallback for when user uses the file input, we use fallback handles
    const handles = files
      .filter(f => f.name.toLowerCase().endsWith('.pdf'))
      .map(f => createFallbackHandle(f));

    if (handles.length === 0) {
      showToast('请选择 PDF 文件');
      return;
    }

    const added = await addFiles(handles);
    if (added > 0) {
      showToast(`✓ 已添加 ${added} 个文件`);
      renderLibrary(currentSearchQuery);
    }
    input.value = '';
  });
}

// ============================================================
// "Add File" button with File System Access API (persistent)
// ============================================================
async function handleAddFiles() {
  if (window.showOpenFilePicker) {
    try {
      const handles = await window.showOpenFilePicker({
        types: [{ description: 'PDF 文件', accept: { 'application/pdf': ['.pdf'] } }],
        multiple: true,
      });
      const added = await addFiles(handles);
      if (added > 0) {
        showToast(`✓ 已添加 ${added} 个文件`);
        renderLibrary(currentSearchQuery);
      }
    } catch (e) {
      if (e.name !== 'AbortError') {
        console.error('[ReadFlow] showOpenFilePicker failed:', e);
        // Fallback to input
        document.getElementById('lib-file-input').click();
      }
    }
  } else {
    // Fallback
    document.getElementById('lib-file-input').click();
  }
}

// ============================================================
// Theme Toggle
// ============================================================
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  const sunIcon = document.getElementById('lib-theme-icon-sun');
  const moonIcon = document.getElementById('lib-theme-icon-moon');
  if (sunIcon) sunIcon.style.display = theme === 'dark' ? 'none' : 'block';
  if (moonIcon) moonIcon.style.display = theme === 'dark' ? 'block' : 'none';
}

function applyAccentColor(hue, saturation) {
  if (hue === undefined || hue === null) return;
  const h = hue;
  const s = saturation || 75;
  document.documentElement.style.setProperty('--primary', `hsl(${h}, ${s}%, 42%)`);
  document.documentElement.style.setProperty('--primary-hover', `hsl(${h}, ${s}%, 55%)`);
  document.documentElement.style.setProperty('--primary-gradient',
    `linear-gradient(135deg, hsl(${h}, ${s}%, 38%) 0%, hsl(${h}, ${s + 5}%, 52%) 100%)`);
  document.documentElement.style.setProperty('--primary-subtle', `hsla(${h}, ${s}%, 50%, 0.08)`);
}

// ============================================================
// Search
// ============================================================
let currentSearchQuery = '';
let searchTimer = null;

function initSearch() {
  const input = document.getElementById('lib-search-input');
  if (!input) return;
  input.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      currentSearchQuery = input.value;
      renderLibrary(currentSearchQuery);
    }, 200);
  });
}

// ============================================================
// Init
// ============================================================
async function init() {
  try {
    db = await openDB();
  } catch (e) {
    console.error('[ReadFlow] Failed to open DB:', e);
    showToast('书架数据库初始化失败');
    return;
  }

  // Load settings (theme, accent color)
  chrome.storage.local.get(['settings'], (result) => {
    const settings = result.settings || {};
    applyTheme(settings.theme || 'light');
    if (settings.accentHue !== undefined) {
      applyAccentColor(settings.accentHue, settings.accentSaturation);
    }
  });

  // Render library
  await renderLibrary();

  // Init drag & drop
  initDragDrop();

  // Init file input fallback
  await initFileInput();

  // Init search
  initSearch();

  // Add File button
  const addBtn = document.getElementById('lib-add-btn');
  if (addBtn) addBtn.addEventListener('click', handleAddFiles);

  const emptyAddBtn = document.getElementById('lib-empty-add-btn');
  if (emptyAddBtn) emptyAddBtn.addEventListener('click', handleAddFiles);

  // Theme toggle
  const themeBtn = document.getElementById('lib-theme-btn');
  if (themeBtn) {
    themeBtn.addEventListener('click', () => {
      chrome.storage.local.get(['settings'], (result) => {
        const settings = result.settings || {};
        const newTheme = (settings.theme || 'light') === 'light' ? 'dark' : 'light';
        settings.theme = newTheme;
        chrome.storage.local.set({ settings });
        applyTheme(newTheme);
      });
    });
  }

  // Close context menu on Escape
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeContextMenu();
  });

  // Init settings drawer
  initSettings();
}

// ============================================================
// Settings Drawer Logic
// ============================================================
function initSettings() {
  const drawer = document.getElementById('lib-settings-drawer');
  const openBtn = document.getElementById('lib-settings-btn');
  const closeBtn = document.getElementById('lib-drawer-close-btn');
  const backdrop = drawer.querySelector('.lib-drawer-backdrop');

  if (!drawer || !openBtn || !closeBtn || !backdrop) return;

  openBtn.addEventListener('click', () => drawer.classList.add('open'));
  closeBtn.addEventListener('click', () => drawer.classList.remove('open'));
  backdrop.addEventListener('click', () => drawer.classList.remove('open'));

  // Load existing settings
  chrome.storage.local.get(['settings'], (result) => {
    const settings = result.settings || {};
    
    // Populate form elements
    document.getElementById('setting-modifier').value = settings.modifierKey || 'Alt';
    document.getElementById('setting-always-translate').checked = settings.alwaysTranslate || false;
    document.getElementById('setting-lang').value = settings.targetLang || 'zh-CN';
    document.getElementById('setting-provider').value = settings.translationProvider || 'google';
    
    if (settings.geminiApiKey) document.getElementById('setting-ai-key').value = settings.geminiApiKey;
    if (settings.geminiModel) document.getElementById('setting-ai-model').value = settings.geminiModel;
    
    document.getElementById('setting-custom-ai-preset').value = '';
    document.getElementById('setting-custom-ai-url').value = settings.customAiBaseUrl || '';
    document.getElementById('setting-custom-ai-key').value = settings.customAiKey || '';
    document.getElementById('setting-custom-ai-model').value = settings.customAiModel || 'deepseek-chat';
    document.getElementById('setting-custom-ai-prompt').value = settings.customAiPrompt || '';
    document.getElementById('setting-theme').value = settings.theme || 'light';
    document.getElementById('setting-accent-hue').value = settings.accentHue || 20;
    document.getElementById('setting-startup-behavior').value = settings.startupBehavior || 'library';
    document.getElementById('setting-card-mode').value = settings.cardDetailMode || 'contextual';

    // Show/hide AI configuration groups based on provider
    const toggleAiVisibility = () => {
      const p = document.getElementById('setting-provider').value;
      document.getElementById('ai-settings-group').style.display = p === 'gemini' ? 'block' : 'none';
      document.getElementById('custom-ai-settings-group').style.display = p === 'custom-ai' ? 'block' : 'none';
    };
    toggleAiVisibility();

    // Mark active color swatch
    const updateActiveSwatch = (activeHue) => {
      drawer.querySelectorAll('.color-swatch').forEach(sw => {
        const h = parseInt(sw.dataset.hue);
        sw.classList.toggle('active', Math.abs(h - activeHue) < 3);
      });
    };
    updateActiveSwatch(settings.accentHue || 20);

    // Save changes
    const saveSettings = () => {
      const updated = {
        modifierKey: document.getElementById('setting-modifier').value,
        alwaysTranslate: document.getElementById('setting-always-translate').checked,
        targetLang: document.getElementById('setting-lang').value,
        translationProvider: document.getElementById('setting-provider').value,
        geminiApiKey: document.getElementById('setting-ai-key').value,
        geminiModel: document.getElementById('setting-ai-model').value,
        customAiBaseUrl: document.getElementById('setting-custom-ai-url').value,
        customAiKey: document.getElementById('setting-custom-ai-key').value,
        customAiModel: document.getElementById('setting-custom-ai-model').value,
        customAiPrompt: document.getElementById('setting-custom-ai-prompt').value,
        theme: document.getElementById('setting-theme').value,
        accentHue: parseInt(document.getElementById('setting-accent-hue').value),
        accentSaturation: 75,
        startupBehavior: document.getElementById('setting-startup-behavior').value,
        cardDetailMode: document.getElementById('setting-card-mode').value,
      };
      
      chrome.storage.local.set({ settings: updated });
      
      // Live updates to library page theme and accent colors
      applyTheme(updated.theme);
      applyAccentColor(updated.accentHue, updated.accentSaturation);
      updateActiveSwatch(updated.accentHue);
    };

    // Listen to form inputs
    const formInputs = drawer.querySelectorAll('.setting-select, .setting-checkbox, .setting-input-text, .setting-textarea, #setting-accent-hue');
    formInputs.forEach(el => {
      el.addEventListener('change', () => {
        if (el.id === 'setting-provider') toggleAiVisibility();
        saveSettings();
      });
    });

    // Accent hue slider real-time input preview
    document.getElementById('setting-accent-hue').addEventListener('input', (e) => {
      const h = parseInt(e.target.value);
      applyAccentColor(h, 75);
      updateActiveSwatch(h);
    });

    // Accent color swatches click handler
    drawer.addEventListener('click', (e) => {
      const swatch = e.target.closest('.color-swatch');
      if (swatch) {
        const hue = parseInt(swatch.dataset.hue);
        document.getElementById('setting-accent-hue').value = hue;
        applyAccentColor(hue, 75);
        updateActiveSwatch(hue);
        saveSettings();
      }
    });

    // Custom AI provider presets picker
    document.getElementById('setting-custom-ai-preset').addEventListener('change', (e) => {
      const presets = {
        deepseek: { url: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
        qwen:     { url: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
        moonshot: { url: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k' },
        openrouter:{ url: 'https://openrouter.ai/api/v1', model: 'openai/gpt-4o-mini' },
        ollama:   { url: 'http://localhost:11434/v1', model: 'llama3' },
      };
      const p = presets[e.target.value];
      if (p) {
        document.getElementById('setting-custom-ai-url').value = p.url;
        document.getElementById('setting-custom-ai-model').value = p.model;
        saveSettings();
      }
    });

    // Test connection button handler
    document.getElementById('btn-test-custom-ai').addEventListener('click', async () => {
      const resultEl = document.getElementById('custom-ai-test-result');
      const btnTest = document.getElementById('btn-test-custom-ai');
      
      const baseUrl = (document.getElementById('setting-custom-ai-url').value || '').replace(/\/$/, '');
      const apiKey = document.getElementById('setting-custom-ai-key').value || '';
      const model = document.getElementById('setting-custom-ai-model').value || 'deepseek-chat';

      if (!baseUrl || !apiKey) {
        resultEl.textContent = '⚠️ 请先填写 URL 和 API Key';
        resultEl.style.color = 'var(--danger)';
        return;
      }

      btnTest.disabled = true;
      btnTest.textContent = '测试中...';
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
        resultEl.textContent = `✅ 连接成功！回复: "${reply}"`;
        resultEl.style.color = 'var(--success, #16a34a)';
      } catch (e) {
        resultEl.textContent = `❌ 失败: ${e.message}`;
        resultEl.style.color = 'var(--danger)';
      } finally {
        btnTest.disabled = false;
        btnTest.textContent = '🔍 测试连接';
      }
    });
  });
}

document.addEventListener('DOMContentLoaded', init);
