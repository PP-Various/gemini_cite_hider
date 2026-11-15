const STORAGE_KEY = 'enabled';

/**
 * 拡張機能のアイコンバッジに現在のタブの非表示件数・状態を表示する。
 */
function updateBadgeForTab(tabId, hiddenCount, enabled) {
  if (typeof tabId !== 'number') return;

  if (!enabled) {
    chrome.action.setBadgeText({ tabId, text: 'OFF' });
    chrome.action.setBadgeBackgroundColor({ tabId, color: '#6b7280' });
    return;
  }

  const text = hiddenCount > 0 ? (hiddenCount > 999 ? '999+' : String(hiddenCount)) : '';
  chrome.action.setBadgeText({ tabId, text });
  chrome.action.setBadgeBackgroundColor({ tabId, color: '#3b5bdb' });
}

chrome.runtime.onInstalled.addListener(async () => {
  const stored = await chrome.storage.local.get({ [STORAGE_KEY]: true });
  if (typeof stored[STORAGE_KEY] !== 'boolean') {
    await chrome.storage.local.set({ [STORAGE_KEY]: true });
  }
});

chrome.runtime.onMessage.addListener((message, sender) => {
  if (!message || message.type !== 'CITE_COUNT_UPDATED') return;
  const tabId = sender?.tab?.id;
  if (typeof tabId !== 'number') return;

  updateBadgeForTab(tabId, Number(message.hiddenCount) || 0, Boolean(message.enabled));
});
