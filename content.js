(() => {
  'use strict';

  const STORAGE_KEY = 'enabled';
  const TOKEN_ATTR = 'data-cite-hider';
  const TOKEN_VALUE = 'token';
  const ROOT_STATE_ON = 'on';
  const ROOT_STATE_OFF = 'off';

  // [cite: 1], [cite: 2, 5], [cite: 1-3] 等にマッチ（直前の水平空白もキャプチャ）
  const CITE_REGEX = /([ \t\u00A0]*)\[\s*cite\s*:\s*\d+(?:\s*[,，\-–]\s*\d+)*\s*\]/gi;

  // 入力欄およびコードブロック・非表示対象外要素
  const EXCLUDED_SELECTOR = [
    'textarea',
    'input',
    'select',
    'option',
    'pre',
    'code',
    'kbd',
    'samp',
    'var',
    'script',
    'style',
    'noscript',
    'template',
    'svg',
    'math',
    '[contenteditable="true"]',
    '[contenteditable=""]',
    '[contenteditable="plaintext-only"]',
    '[role="textbox"]',
    `[${TOKEN_ATTR}="${TOKEN_VALUE}"]`
  ].join(', ');

  let isEnabled = true;
  let isMutating = false;
  let syncTimer = null;

  /** @type {WeakMap<Text, { baseText: string, sourceText: string, siblings: Node[] }>} */
  const splitRecords = new WeakMap();
  /** @type {WeakSet<Node>} */
  const observedRoots = new WeakSet();
  /** @type {Set<ShadowRoot>} */
  const trackedShadowRoots = new Set();
  /** @type {MutationObserver[]} */
  const observers = [];

  /**
   * ルート要素の data 属性を更新し、CSS による非表示を即時切り替える。
   */
  function applyRootState() {
    const root = document.documentElement;
    if (!root) return;
    root.setAttribute(TOKEN_ATTR, isEnabled ? ROOT_STATE_ON : ROOT_STATE_OFF);
  }

  /**
   * ShadowRoot 内のトークン要素へ表示/非表示スタイルを反映する。
   */
  function applyShadowTokenState(span) {
    if (!(span instanceof HTMLElement)) return;
    if (isEnabled) {
      span.style.setProperty('display', 'none', 'important');
      span.style.setProperty('visibility', 'hidden', 'important');
      span.style.setProperty('user-select', 'none', 'important');
    } else {
      span.style.removeProperty('display');
      span.style.removeProperty('visibility');
      span.style.removeProperty('user-select');
    }
  }

  /**
   * 全ての監視済み ShadowRoot 内の既存トークンの状態を同期する。
   */
  function syncAllShadowTokens() {
    for (const shadowRoot of trackedShadowRoots) {
      if (!shadowRoot.host?.isConnected) {
        trackedShadowRoots.delete(shadowRoot);
        continue;
      }
      const tokens = shadowRoot.querySelectorAll(`[${TOKEN_ATTR}="${TOKEN_VALUE}"]`);
      for (const token of tokens) {
        applyShadowTokenState(token);
      }
    }
  }

  /**
   * 自身による DOM 変更が MutationObserver の無限ループを起こさないよう保護実行する。
   */
  function withMutationGuard(fn) {
    if (isMutating) return;
    isMutating = true;
    try {
      fn();
    } finally {
      for (const obs of observers) {
        obs.takeRecords();
      }
      isMutating = false;
    }
  }

  /**
   * ノードが入力欄・コードブロック・既処理トークン等の除外対象内にあるか判定する。
   * Shadow DOM 境界を越えてホスト側までチェックする。
   */
  function isExcludedNode(node) {
    if (!node) return true;

    let current = node.nodeType === Node.ELEMENT_NODE
      ? /** @type {Element} */ (node)
      : node.parentElement;

    if (!current && node.parentNode instanceof ShadowRoot) {
      current = node.parentNode.host;
    }

    while (current) {
      if (current instanceof HTMLElement && current.isContentEditable) {
        return true;
      }
      if (current.closest(EXCLUDED_SELECTOR)) {
        return true;
      }
      const rootNode = current.getRootNode();
      if (rootNode instanceof ShadowRoot) {
        current = rootNode.host;
      } else {
        break;
      }
    }

    return false;
  }

  const BLOCK_TAGS = new Set([
    'P', 'DIV', 'LI', 'UL', 'OL', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
    'BLOCKQUOTE', 'SECTION', 'ARTICLE', 'HEADER', 'FOOTER', 'MAIN', 'ASIDE',
    'TD', 'TH', 'TR', 'DT', 'DD', 'FIGCAPTION', 'BODY'
  ]);

  /**
   * テキストノードの直前に同一ブロック内の先行テキスト・要素があるかを確認する。
   */
  function hasPreviousMeaningfulSibling(node) {
    let cur = node;
    while (cur) {
      let prev = cur.previousSibling;
      while (prev) {
        if (prev.nodeType === Node.TEXT_NODE) {
          if ((prev.nodeValue || '').length > 0) return true;
        } else if (prev.nodeType === Node.ELEMENT_NODE) {
          const el = /** @type {Element} */ (prev);
          if (el.getAttribute(TOKEN_ATTR) !== TOKEN_VALUE && (el.textContent || '').length > 0) {
            return true;
          }
        }
        prev = prev.previousSibling;
      }
      const parent = cur.parentElement;
      if (!parent || BLOCK_TAGS.has(parent.tagName)) {
        break;
      }
      cur = parent;
    }
    return false;
  }

  /**
   * テキストから [cite: *] の切り出し範囲（直前/直後の余分な半角スペース含む）を計算する。
   * @returns {{ baseText: string, parts: Array<{ type: 'token' | 'text', value: string }> } | null}
   */
  function parseCiteSegments(text, hasPrevSibling) {
    CITE_REGEX.lastIndex = 0;
    const matches = [];
    let match;

    while ((match = CITE_REGEX.exec(text)) !== null) {
      const fullMatch = match[0];
      const leadingSpaces = match[1] || '';
      const matchStart = match.index;
      const matchEnd = matchStart + fullMatch.length;
      const citeStart = matchStart + leadingSpaces.length;

      let tokenStart = citeStart;
      let tokenEnd = matchEnd;

      if (leadingSpaces.length > 0) {
        const charBeforeSpaces = matchStart > 0 ? text[matchStart - 1] : '';
        const charAfterCite = text[matchEnd] || '';

        // 改行直後のインデント空白は保持する
        const isAfterNewline = charBeforeSpaces === '\n' || charBeforeSpaces === '\r';
        // 英数字同士が直結して単語がくっつく場合のみ直前スペースを残す
        const joinsWordWithoutSpace = /[A-Za-z0-9]/.test(charAfterCite);

        if (!isAfterNewline && !joinsWordWithoutSpace) {
          tokenStart = matchStart;
        }
      } else {
        // 直前に空白がなく、行頭（または改行直後）で、直後に半角スペース1つ＋非空白が続く場合
        const isAtLineStart =
          (matchStart === 0 && !hasPrevSibling) ||
          (matchStart > 0 && (text[matchStart - 1] === '\n' || text[matchStart - 1] === '\r'));
        if (isAtLineStart && /^[ \t\u00A0](?=\S)/.test(text.slice(matchEnd))) {
          tokenEnd = matchEnd + 1;
        }
      }

      matches.push({ start: tokenStart, end: tokenEnd });
    }

    if (matches.length === 0) return null;

    const baseText = text.slice(0, matches[0].start);
    const parts = [];

    for (let i = 0; i < matches.length; i++) {
      const current = matches[i];
      parts.push({ type: 'token', value: text.slice(current.start, current.end) });

      const nextStart = i + 1 < matches.length ? matches[i + 1].start : text.length;
      if (current.end < nextStart) {
        parts.push({ type: 'text', value: text.slice(current.end, nextStart) });
      }
    }

    return { baseText, parts };
  }

  /**
   * 以前分割生成した兄弟ノードを安全にクリーンアップする。
   */
  function removeSplitSiblings(siblings) {
    for (const sib of siblings) {
      if (sib.parentNode) {
        sib.parentNode.removeChild(sib);
      }
    }
  }

  /**
   * 非表示トークン用の <span> を生成する。
   */
  function createHiddenSpan(tokenText, inShadowDom) {
    const span = document.createElement('span');
    span.setAttribute(TOKEN_ATTR, TOKEN_VALUE);
    span.setAttribute('aria-hidden', 'true');
    span.textContent = tokenText;
    if (inShadowDom) {
      applyShadowTokenState(span);
    }
    return span;
  }

  /**
   * 単一の Text ノードを検査・分割して [cite: *] をラップする。
   * ストリーミング更新（全置換 / appendData）の両方に対応する。
   */
  function processTextNode(node) {
    if (!isEnabled) return;
    if (!node || !node.parentNode || !node.isConnected) return;
    if (isExcludedNode(node)) return;

    const currentText = node.nodeValue || '';
    const existing = splitRecords.get(node);

    if (existing) {
      if (currentText === existing.baseText) {
        return;
      }

      if (currentText.startsWith(existing.sourceText)) {
        // フレームワークが元の全文ベースで上書き追記したケース
        removeSplitSiblings(existing.siblings);
        splitRecords.delete(node);
      } else if (currentText.startsWith(existing.baseText)) {
        // フレームワークが分割後テキストノードに appendData したケース
        const parsedAppended = parseCiteSegments(currentText, hasPreviousMeaningfulSibling(node));
        if (!parsedAppended) {
          existing.baseText = currentText;
          return;
        }
        const inShadow = node.getRootNode() instanceof ShadowRoot;
        const newSiblings = parsedAppended.parts.map((part) =>
          part.type === 'token'
            ? createHiddenSpan(part.value, inShadow)
            : document.createTextNode(part.value)
        );
        const anchor = node.nextSibling;
        const parent = node.parentNode;
        node.nodeValue = parsedAppended.baseText;
        for (const sib of newSiblings) {
          parent.insertBefore(sib, anchor);
        }
        existing.baseText = parsedAppended.baseText;
        existing.sourceText = currentText;
        existing.siblings = [...newSiblings, ...existing.siblings];
        return;
      } else {
        // 全く別のテキストへ差し替わったケース
        removeSplitSiblings(existing.siblings);
        splitRecords.delete(node);
      }
    }

    if (!currentText || currentText.indexOf('[') === -1) return;

    const parsed = parseCiteSegments(currentText, hasPreviousMeaningfulSibling(node));
    if (!parsed) return;

    const parent = node.parentNode;
    const anchor = node.nextSibling;
    const inShadow = node.getRootNode() instanceof ShadowRoot;

    const siblings = parsed.parts.map((part) =>
      part.type === 'token'
        ? createHiddenSpan(part.value, inShadow)
        : document.createTextNode(part.value)
    );

    node.nodeValue = parsed.baseText;
    for (const sib of siblings) {
      parent.insertBefore(sib, anchor);
    }

    splitRecords.set(node, {
      baseText: parsed.baseText,
      sourceText: currentText,
      siblings
    });
  }

  /**
   * 要素サブツリーを再帰的に走査してテキストノードを処理する（Open Shadow DOM も対応）。
   */
  function scanSubtree(root) {
    if (!root || !isEnabled) return;

    if (root.nodeType === Node.TEXT_NODE) {
      processTextNode(/** @type {Text} */ (root));
      return;
    }

    if (root instanceof Element) {
      if (isExcludedNode(root)) return;
      if (root.shadowRoot) {
        observeRoot(root.shadowRoot);
        scanSubtree(root.shadowRoot);
      }
    }

    const walker = document.createTreeWalker(
      root,
      NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
      {
        acceptNode(node) {
          if (node.nodeType === Node.ELEMENT_NODE) {
            const el = /** @type {Element} */ (node);
            if (isExcludedNode(el)) {
              return NodeFilter.FILTER_REJECT;
            }
            if (el.shadowRoot) {
              observeRoot(el.shadowRoot);
              scanSubtree(el.shadowRoot);
            }
            return NodeFilter.FILTER_SKIP;
          }
          return NodeFilter.FILTER_ACCEPT;
        }
      }
    );

    const textNodes = [];
    let currentNode;
    while ((currentNode = walker.nextNode()) !== null) {
      textNodes.push(/** @type {Text} */ (currentNode));
    }

    for (const textNode of textNodes) {
      processTextNode(textNode);
    }
  }

  /**
   * 現在ページ上の非表示トークン件数を集計する。
   */
  function getStats() {
    let totalTokens = document.querySelectorAll(`[${TOKEN_ATTR}="${TOKEN_VALUE}"]`).length;
    for (const shadowRoot of trackedShadowRoots) {
      if (!shadowRoot.host?.isConnected) {
        trackedShadowRoots.delete(shadowRoot);
        continue;
      }
      totalTokens += shadowRoot.querySelectorAll(`[${TOKEN_ATTR}="${TOKEN_VALUE}"]`).length;
    }

    return {
      enabled: isEnabled,
      hiddenCount: isEnabled ? totalTokens : 0,
      detectedCount: totalTokens
    };
  }

  /**
   * バッジ更新をデバウンスして background.js へ通知する。
   */
  function scheduleStatsSync() {
    if (syncTimer !== null) {
      clearTimeout(syncTimer);
    }
    syncTimer = setTimeout(() => {
      syncTimer = null;
      const stats = getStats();
      try {
        chrome.runtime?.sendMessage?.({
          type: 'CITE_COUNT_UPDATED',
          ...stats
        }).catch(() => {});
      } catch {
        // 拡張機能コンテキスト無効化時は無視
      }
    }, 120);
  }

  /**
   * Document または ShadowRoot に対して MutationObserver を登録する。
   */
  function observeRoot(root) {
    if (!root || observedRoots.has(root)) return;
    observedRoots.add(root);

    if (root instanceof ShadowRoot) {
      trackedShadowRoots.add(root);
    }

    const observer = new MutationObserver((mutations) => {
      if (isMutating || !isEnabled) return;

      withMutationGuard(() => {
        for (const mutation of mutations) {
          if (mutation.type === 'characterData') {
            processTextNode(/** @type {Text} */ (mutation.target));
          } else if (mutation.type === 'childList') {
            for (const added of mutation.addedNodes) {
              scanSubtree(added);
            }
          }
        }
      });

      scheduleStatsSync();
    });

    observer.observe(root, {
      childList: true,
      subtree: true,
      characterData: true
    });

    observers.push(observer);
  }

  /**
   * 機能の ON/OFF を切り替え、DOM とカウントを即時反映する。
   */
  function setEnabled(nextEnabled) {
    isEnabled = Boolean(nextEnabled);
    applyRootState();
    withMutationGuard(() => {
      syncAllShadowTokens();
      if (isEnabled && document.body) {
        scanSubtree(document.body);
      }
    });
    scheduleStatsSync();
  }

  /**
   * 初期化処理。
   */
  async function init() {
    try {
      const stored = await chrome.storage.local.get({ [STORAGE_KEY]: true });
      isEnabled = Boolean(stored[STORAGE_KEY]);
    } catch {
      isEnabled = true;
    }

    applyRootState();

    const startObserving = () => {
      const target = document.body || document.documentElement;
      if (!target) return;
      observeRoot(document);
      if (isEnabled) {
        withMutationGuard(() => {
          scanSubtree(target);
        });
      }
      scheduleStatsSync();
    };

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', startObserving, { once: true });
      // document_start 時点でも documentElement があれば監視を張っておく
      if (document.documentElement) {
        observeRoot(document);
      }
    } else {
      startObserving();
    }

    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== 'local' || !(STORAGE_KEY in changes)) return;
      setEnabled(changes[STORAGE_KEY].newValue);
    });

    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (!message) return;

      if (message.type === 'GET_STATUS') {
        sendResponse(getStats());
        return;
      }

      if (message.type === 'SET_ENABLED') {
        setEnabled(message.enabled);
        sendResponse(getStats());
      }
    });
  }

  init();
})();
