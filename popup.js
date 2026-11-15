(() => {
  'use strict';

  const STORAGE_KEY = 'enabled';
  const SUPPORTED_HOSTS = new Set([
    'gemini.google.com',
    'notebook.google.com',
    'notebooklm.google.com'
  ]);

  const toggleEl = document.getElementById('toggle-enabled');
  const countEl = document.getElementById('hidden-count');
  const noteEl = document.getElementById('stat-note');
  const sitePillEl = document.getElementById('site-pill');
  const sitePillTextEl = document.getElementById('site-pill-text');

  let activeTabId = null;
  let isSupportedTab = false;

  /**
   * 現在のタブが対象ドメインかどうかを判定する。
   */
  function isSupportedUrl(url) {
    if (!url) return false;
    try {
      const parsed = new URL(url);
      return parsed.protocol === 'https:' && SUPPORTED_HOSTS.has(parsed.hostname);
    } catch {
      return false;
    }
  }

  /**
   * ポップアップの表示状態を最新の状態に合わせて更新する。
   */
  function renderState({ enabled, hiddenCount = 0, detectedCount = 0, connected = false }) {
    toggleEl.checked = Boolean(enabled);

    if (!isSupportedTab) {
      sitePillEl.dataset.state = 'inactive';
      sitePillTextEl.textContent = '対象外ページ';
      countEl.textContent = '0';
      noteEl.textContent = 'Gemini または NotebookLM のタブでカウントが表示されます';
      return;
    }

    if (!enabled) {
      sitePillEl.dataset.state = 'paused';
      sitePillTextEl.textContent = '停止中';
      countEl.textContent = '0';
      noteEl.textContent =
        detectedCount > 0
          ? `一時停止中（ページ内に ${detectedCount} 件の引用表記があります）`
          : '現在は機能を停止しています';
      return;
    }

    sitePillEl.dataset.state = 'active';
    sitePillTextEl.textContent = '適用中';
    countEl.textContent = String(hiddenCount);

    if (!connected) {
      noteEl.textContent = 'ページ読み込み後に自動適用されます（未反映時は再読み込みしてください）';
    } else if (hiddenCount > 0) {
      noteEl.textContent = '表示およびクリップボードへのコピーから除外しています';
    } else {
      noteEl.textContent = 'このタブで露出した [cite: *] 表記は見つかっていません';
    }
  }

  /**
   * アクティブタブのコンテンツスクリプトから現在の件数を取得する。
   */
  async function fetchTabStats(tabId) {
    if (typeof tabId !== 'number') return null;
    try {
      return await chrome.tabs.sendMessage(tabId, { type: 'GET_STATUS' });
    } catch {
      return null;
    }
  }

  async function init() {
    const stored = await chrome.storage.local.get({ [STORAGE_KEY]: true });
    let enabled = Boolean(stored[STORAGE_KEY]);

    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    activeTabId = activeTab?.id ?? null;
    isSupportedTab = isSupportedUrl(activeTab?.url);

    if (isSupportedTab && activeTabId !== null) {
      const stats = await fetchTabStats(activeTabId);
      if (stats) {
        enabled = Boolean(stats.enabled);
        renderState({
          enabled,
          hiddenCount: Number(stats.hiddenCount) || 0,
          detectedCount: Number(stats.detectedCount) || 0,
          connected: true
        });
      } else {
        renderState({ enabled, connected: false });
      }
    } else {
      renderState({ enabled, connected: false });
    }

    toggleEl.addEventListener('change', async () => {
      const nextEnabled = toggleEl.checked;
      await chrome.storage.local.set({ [STORAGE_KEY]: nextEnabled });

      if (isSupportedTab && activeTabId !== null) {
        try {
          const stats = await chrome.tabs.sendMessage(activeTabId, {
            type: 'SET_ENABLED',
            enabled: nextEnabled
          });
          renderState({
            enabled: nextEnabled,
            hiddenCount: Number(stats?.hiddenCount) || 0,
            detectedCount: Number(stats?.detectedCount) || 0,
            connected: true
          });
          return;
        } catch {
          // ページ未接続時はストレージ経由で次回ロード時に反映
        }
      }

      renderState({ enabled: nextEnabled, connected: false });
    });
  }

  init();
})();
