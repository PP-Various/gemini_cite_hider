(() => {
  'use strict';

  const ROOT_ATTR = 'data-cite-hider';
  const CITE_REGEX = /([ \t\u00A0]*)\[\s*cite\s*:\s*\d+(?:\s*[,，\-–]\s*\d+)*\s*\]/gi;
  const CODE_SPAN_REGEX = /(`{3,}|~{3,})[\s\S]*?\1|`[^`\r\n]+`/g;
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
    '[contenteditable="true"]',
    '[contenteditable=""]',
    '[contenteditable="plaintext-only"]',
    '[role="textbox"]'
  ].join(', ');

  let shouldSanitizeCopyEvent = false;

  /**
   * 拡張機能が現在 ON かどうかを DOM ルート属性から判定する。
   */
  function isActive() {
    return document.documentElement?.getAttribute(ROOT_ATTR) !== 'off';
  }

  /**
   * 非コード領域のテキストから [cite: *] と不要な前後空白を除去する。
   */
  function stripCiteSegment(text, allowStartOfLineTrim = true) {
    if (!text || text.indexOf('[') === -1) return text;

    CITE_REGEX.lastIndex = 0;
    let result = '';
    let lastIndex = 0;
    let match;

    while ((match = CITE_REGEX.exec(text)) !== null) {
      const fullMatch = match[0];
      const leadingSpaces = match[1] || '';
      const matchStart = match.index;
      const matchEnd = matchStart + fullMatch.length;
      const citeStart = matchStart + leadingSpaces.length;

      let cutStart = citeStart;
      let cutEnd = matchEnd;

      if (leadingSpaces.length > 0) {
        const charBeforeSpaces = matchStart > 0 ? text[matchStart - 1] : '';
        const charAfterCite = text[matchEnd] || '';
        const isAfterNewline = charBeforeSpaces === '\n' || charBeforeSpaces === '\r';
        const joinsWordWithoutSpace = /[A-Za-z0-9]/.test(charAfterCite);

        if (!isAfterNewline && !joinsWordWithoutSpace) {
          cutStart = matchStart;
        }
      } else {
        const isAtLineStart =
          (allowStartOfLineTrim && matchStart === 0) ||
          (matchStart > 0 && (text[matchStart - 1] === '\n' || text[matchStart - 1] === '\r'));
        if (isAtLineStart && /^[ \t\u00A0](?=\S)/.test(text.slice(matchEnd))) {
          cutEnd = matchEnd + 1;
        }
      }

      result += text.slice(lastIndex, cutStart);
      lastIndex = cutEnd;
    }

    if (lastIndex === 0) return text;
    return result + text.slice(lastIndex);
  }

  /**
   * プレーンテキスト（Markdown 含む）からコードブロック外のみの [cite: *] を除去する。
   */
  function stripCitationsFromPlainText(text) {
    if (typeof text !== 'string' || text.indexOf('[') === -1) return text;

    CODE_SPAN_REGEX.lastIndex = 0;
    let out = '';
    let lastIndex = 0;
    let match;

    while ((match = CODE_SPAN_REGEX.exec(text)) !== null) {
      if (match.index > lastIndex) {
        const segment = text.slice(lastIndex, match.index);
        out += stripCiteSegment(segment, lastIndex === 0);
      }
      out += match[0];
      lastIndex = match.index + match[0].length;
    }

    if (lastIndex === 0) {
      return stripCiteSegment(text, true);
    }
    if (lastIndex < text.length) {
      out += stripCiteSegment(text.slice(lastIndex), false);
    }
    return out;
  }

  /**
   * HTML 文字列からコードブロック・入力要素以外の [cite: *] を除去する。
   */
  function stripCitationsFromHtml(html) {
    if (typeof html !== 'string' || html.indexOf('[') === -1) return html;
    try {
      const parser = new DOMParser();
      const parsed = parser.parseFromString(html, 'text/html');
      const walker = parsed.createTreeWalker(
        parsed.body,
        NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
        {
          acceptNode(node) {
            if (node.nodeType === Node.ELEMENT_NODE) {
              const el = /** @type {Element} */ (node);
              if (el.matches(EXCLUDED_SELECTOR)) {
                return NodeFilter.FILTER_REJECT;
              }
              return NodeFilter.FILTER_SKIP;
            }
            return NodeFilter.FILTER_ACCEPT;
          }
        }
      );

      let current;
      while ((current = walker.nextNode()) !== null) {
        const val = current.nodeValue;
        if (val && val.indexOf('[') !== -1) {
          const hasPrev = Boolean(current.previousSibling);
          const cleaned = stripCiteSegment(val, !hasPrev);
          if (cleaned !== val) {
            current.nodeValue = cleaned;
          }
        }
      }

      return parsed.body.innerHTML;
    } catch {
      return html;
    }
  }

  /**
   * 要素または選択範囲が入力欄・コードブロックなどの除外対象内か判定する。
   */
  function isTargetExcluded(target) {
    const checkElement = (el) => {
      if (!el || !(el instanceof Element)) return false;
      if (el instanceof HTMLElement && el.isContentEditable) return true;
      return Boolean(el.closest(EXCLUDED_SELECTOR));
    };

    if (target instanceof Node) {
      const el = target.nodeType === Node.ELEMENT_NODE ? target : target.parentElement;
      if (checkElement(el)) return true;
    }

    const sel = window.getSelection?.();
    if (sel && sel.rangeCount > 0 && !sel.isCollapsed) {
      const anchorEl =
        sel.anchorNode?.nodeType === Node.ELEMENT_NODE
          ? sel.anchorNode
          : sel.anchorNode?.parentElement;
      const focusEl =
        sel.focusNode?.nodeType === Node.ELEMENT_NODE
          ? sel.focusNode
          : sel.focusNode?.parentElement;
      if (checkElement(anchorEl) || checkElement(focusEl)) {
        return true;
      }
    }

    return false;
  }

  /**
   * プログラムが一時生成した非表示・オフスクリーン・readOnly のコピー用入力要素か判定する。
   */
  function isProgrammaticTempInput(el) {
    if (!(el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement)) {
      return false;
    }
    if (el.readOnly) return true;
    const rect = el.getBoundingClientRect();
    if (
      rect.width <= 2 ||
      rect.height <= 2 ||
      rect.right < 0 ||
      rect.bottom < 0 ||
      rect.left > window.innerWidth ||
      rect.top > window.innerHeight
    ) {
      return true;
    }
    const style = getComputedStyle(el);
    return style.opacity === '0' || style.visibility === 'hidden' || style.display === 'none';
  }

  // 1. navigator.clipboard.writeText のサニタイズ
  if (typeof Clipboard !== 'undefined' && Clipboard.prototype?.writeText) {
    const originalWriteText = Clipboard.prototype.writeText;
    Clipboard.prototype.writeText = function (text) {
      const nextText = isActive() && typeof text === 'string'
        ? stripCitationsFromPlainText(text)
        : text;
      return originalWriteText.call(this, nextText);
    };
  }

  // 2. navigator.clipboard.write(ClipboardItem[]) のサニタイズ
  if (
    typeof Clipboard !== 'undefined' &&
    typeof ClipboardItem !== 'undefined' &&
    Clipboard.prototype?.write
  ) {
    const originalWrite = Clipboard.prototype.write;
    Clipboard.prototype.write = function (items) {
      if (!isActive() || !Array.isArray(items)) {
        return originalWrite.call(this, items);
      }

      try {
        const sanitizedItems = items.map((item) => {
          if (!(item instanceof ClipboardItem)) return item;
          const hasTargetType =
            item.types.includes('text/plain') || item.types.includes('text/html');
          if (!hasTargetType) return item;

          const dataRecord = {};
          for (const type of item.types) {
            if (type === 'text/plain') {
              dataRecord[type] = item.getType(type).then(async (blob) => {
                const raw = await blob.text();
                return new Blob([stripCitationsFromPlainText(raw)], { type });
              });
            } else if (type === 'text/html') {
              dataRecord[type] = item.getType(type).then(async (blob) => {
                const raw = await blob.text();
                return new Blob([stripCitationsFromHtml(raw)], { type });
              });
            } else {
              dataRecord[type] = item.getType(type);
            }
          }

          const options = item.presentationStyle
            ? { presentationStyle: item.presentationStyle }
            : undefined;
          return new ClipboardItem(dataRecord, options);
        });

        return originalWrite.call(this, sanitizedItems);
      } catch {
        return originalWrite.call(this, items);
      }
    };
  }

  // 3. 一時 textarea + document.execCommand('copy') 方式のサニタイズ
  if (typeof Document !== 'undefined' && Document.prototype?.execCommand) {
    const originalExecCommand = Document.prototype.execCommand;
    Document.prototype.execCommand = function (commandId, showUI, value) {
      if (isActive() && String(commandId).toLowerCase() === 'copy') {
        const active = document.activeElement;
        if (isProgrammaticTempInput(active)) {
          const cleaned = stripCitationsFromPlainText(active.value);
          if (cleaned !== active.value) {
            active.value = cleaned;
            active.select();
          }
        }
      }
      return originalExecCommand.call(this, commandId, showUI, value);
    };
  }

  // 4. サイト側 copy イベント内の clipboardData.setData をサニタイズ
  if (typeof DataTransfer !== 'undefined' && DataTransfer.prototype?.setData) {
    const originalSetData = DataTransfer.prototype.setData;
    DataTransfer.prototype.setData = function (format, data) {
      if (shouldSanitizeCopyEvent && isActive() && typeof data === 'string') {
        const lower = String(format).toLowerCase();
        if (lower === 'text/plain' || lower === 'text') {
          data = stripCitationsFromPlainText(data);
        } else if (lower === 'text/html') {
          data = stripCitationsFromHtml(data);
        }
      }
      return originalSetData.call(this, format, data);
    };
  }

  window.addEventListener(
    'copy',
    (event) => {
      const target = event.target;
      const isTemp = isProgrammaticTempInput(target);
      shouldSanitizeCopyEvent = isActive() && (isTemp || !isTargetExcluded(target));
      queueMicrotask(() => {
        shouldSanitizeCopyEvent = false;
      });
    },
    true
  );
})();
