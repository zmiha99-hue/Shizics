"use strict";

(() => {
  const NON_CHANNEL_PREFIXES = new Set([
    "",
    "directory",
    "downloads",
    "drops",
    "inventory",
    "jobs",
    "messages",
    "p",
    "payments",
    "search",
    "settings",
    "subscriptions",
    "turbo",
    "u",
    "videos",
    "wallet"
  ]);

  let lastUrl = window.location.href;
  let observer = null;
  let flushTimer = null;

  function extractChannelFromPath(pathname) {
    const parts = String(pathname || "")
      .split("/")
      .map((p) => p.trim().toLowerCase())
      .filter(Boolean);

    if (parts.length === 0) return "";
    if (parts[0] === "popout" && parts.length >= 2) {
      return parts[1];
    }
    if (parts[0] === "moderator" && parts.length >= 2) {
      return parts[1];
    }
    if (NON_CHANNEL_PREFIXES.has(parts[0])) {
      return "";
    }
    return parts[0];
  }

  function simpleHash(input) {
    let hash = 2166136261;
    for (let i = 0; i < input.length; i += 1) {
      hash ^= input.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16);
  }

  function findChatContainer() {
    return (
      document.querySelector('[data-test-selector="chat-scrollable-area__message-container"]') ||
      document.querySelector(".chat-scrollable-area__message-container") ||
      document.querySelector('[role="log"]')
    );
  }

  function findChatInput() {
    return (
      document.querySelector('[data-a-target="chat-input"]') ||
      document.querySelector('textarea[data-test-selector="chat-input"]') ||
      document.querySelector('[data-test-selector="chat-input"] [role="textbox"]')
    );
  }

  function findSendButton() {
    return (
      document.querySelector('[data-a-target="chat-send-button"]') ||
      document.querySelector('button[data-test-selector="chat-send-button"]')
    );
  }

  function detectBlockers() {
    if (
      document.querySelector('iframe[src*="captcha"]') ||
      document.querySelector('iframe[src*="arkose"]') ||
      document.querySelector('[data-test-selector*="captcha"]')
    ) {
      return "Обнаружена проверка CAPTCHA/антибот. Отправка остановлена.";
    }
    const input = findChatInput();
    if (!input) {
      return "Поле ввода чата не найдено (возможно, чат недоступен или требуется вход в Twitch).";
    }
    if (input.disabled || input.getAttribute("aria-disabled") === "true") {
      return "Поле ввода чата отключено (ограничение канала или потеря авторизации).";
    }
    const sendBtn = findSendButton();
    if (!sendBtn) {
      return "Кнопка отправки чата не найдена (изменилась структура страницы).";
    }
    return null;
  }

  function getInputText(inputEl) {
    if (!inputEl) return "";
    if (typeof inputEl.value === "string") {
      return inputEl.value;
    }
    return inputEl.textContent || "";
  }

  function setInputText(inputEl, text) {
    inputEl.focus();
    if (typeof inputEl.value === "string" && inputEl.tagName === "TEXTAREA") {
      const proto = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value");
      if (proto && proto.set) {
        proto.set.call(inputEl, text);
      } else {
        inputEl.value = text;
      }
      inputEl.dispatchEvent(new Event("input", { bubbles: true }));
      inputEl.dispatchEvent(new Event("change", { bubbles: true }));
      return;
    }

    // Twitch chat uses Slate.js contenteditable; paste DataTransfer updates Slate's internal model reliably.
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(inputEl);
    sel.removeAllRanges();
    sel.addRange(range);

    try {
      const dt = new DataTransfer();
      dt.setData("text/plain", text);
      const pasteEv = new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData: dt
      });
      inputEl.dispatchEvent(pasteEv);
    } catch (_err) {
      // Ignore if ClipboardEvent/DataTransfer is restricted.
    }

    if (getInputText(inputEl).replace(/\s+/g, " ").trim().includes(text.trim())) {
      return;
    }

    try {
      document.execCommand("insertText", false, text);
    } catch (_err) {
      inputEl.dispatchEvent(
        new InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "insertText", data: text })
      );
      inputEl.textContent = text;
      inputEl.dispatchEvent(new InputEvent("input", { bubbles: true, data: text, inputType: "insertText" }));
    }
  }

  function extractMessageText(lineEl) {
    const textNodes = lineEl.querySelectorAll(
      '[data-a-target="chat-message-text"], .text-fragment, [data-a-target="emote-name"], .mention-fragment, [data-a-target="chat-message-mention"], .link-fragment'
    );
    if (textNodes.length > 0) {
      const parts = [];
      textNodes.forEach((node) => {
        if (node.tagName === "IMG" && node.alt) {
          parts.push(node.alt);
        } else if (node.textContent) {
          parts.push(node.textContent);
        }
      });
      const joined = parts.join(" ").replace(/\s+/g, " ").trim();
      if (joined) return joined;
    }

    const body = lineEl.querySelector('[data-test-selector="chat-line-message-body"]');
    if (body && body.textContent) {
      return body.textContent.replace(/\s+/g, " ").trim();
    }
    return "";
  }

  function extractAuthor(lineEl) {
    const candidates = lineEl.querySelectorAll(
      '[data-a-target="chat-message-username"], .chat-author__display-name'
    );
    for (const el of candidates) {
      if (el.closest('[data-a-target="chat-reply-header"], .chat-line__reply-line')) {
        continue;
      }
      const name = el.textContent ? el.textContent.trim() : "";
      if (name) return name;
    }
    return "";
  }

  function readVisibleMessages(container) {
    if (!container) return [];
    const lines = container.querySelectorAll(
      '.chat-line__message, [data-a-target="chat-line-message"]'
    );
    const items = [];
    const nowIso = new Date().toISOString();
    const occCounts = new Map();

    lines.forEach((lineEl) => {
      if (lineEl.closest('[data-a-target="whisper-thread"]')) {
        return;
      }

      const author = extractAuthor(lineEl);
      const text = extractMessageText(lineEl);
      if (!author || !text) {
        return;
      }

      const existingExtId = lineEl.dataset ? lineEl.dataset.extMsgId : "";
      let domId =
        existingExtId ||
        lineEl.getAttribute("data-id") ||
        lineEl.getAttribute("data-message-id") ||
        lineEl.getAttribute("id") ||
        "";

      if (!domId) {
        const tsEl = lineEl.querySelector(".chat-line__timestamp, [data-a-target='chat-timestamp']");
        const tsText = tsEl && tsEl.textContent ? tsEl.textContent.trim() : "";
        const baseKey = `${author}|${tsText}|${text}`;
        const occ = (occCounts.get(baseKey) || 0) + 1;
        occCounts.set(baseKey, occ);
        domId = `dom_${simpleHash(`${baseKey}|${occ}`)}`;
      }
      if (lineEl.dataset && !lineEl.dataset.extMsgId) {
        lineEl.dataset.extMsgId = domId;
      }

      items.push({
        id: domId,
        author,
        text,
        timestamp: nowIso
      });
    });

    return items;
  }

  function waitForSentMessageInDom(expectedText, priorCount, timeoutMs = 10000) {
    const normForCmp = (s) => String(s || "").replace(/\s+/g, " ").replace(/\s+([!?.,:])/g, "$1").trim().toLowerCase();
    const targetNorm = normForCmp(expectedText);
    return new Promise((resolve) => {
      const started = Date.now();
      const timer = setInterval(() => {
        const container = findChatContainer();
        const msgs = readVisibleMessages(container);
        const tail = msgs.slice(Math.max(0, Math.min(priorCount, msgs.length) - 3));
        const found = tail.some((m) => {
          const norm = normForCmp(m.text);
          return norm === targetNorm || norm.includes(targetNorm);
        });
        if (found) {
          clearInterval(timer);
          resolve(true);
          return;
        }
        if (Date.now() - started >= timeoutMs) {
          clearInterval(timer);
          resolve(false);
        }
      }, 300);
    });
  }

  async function handleSendOnce(expectedChannel, textToSend) {
    const cleanSend = String(textToSend || "").trim();
    if (!cleanSend || cleanSend.startsWith("/") || cleanSend.startsWith(".") || cleanSend.startsWith("!") || cleanSend.startsWith("{")) {
      return {
        status: "blocked",
        error: "Отправка команд (/, ., !) и сырого JSON запрещена."
      };
    }

    const pageChannel = extractChannelFromPath(window.location.pathname);
    if (!expectedChannel || pageChannel !== expectedChannel.toLowerCase()) {
      return {
        status: "blocked",
        error: `Канал вкладки '${pageChannel || "-"}' не совпадает с разрешённым '${expectedChannel}'.`
      };
    }

    const blocker = detectBlockers();
    if (blocker) {
      return { status: "blocked", error: blocker };
    }

    const inputEl = findChatInput();
    const existingText = getInputText(inputEl);
    if (existingText.trim().length > 0) {
      return {
        status: "blocked",
        error: "В поле ввода уже есть набранный пользователем текст. Отправка отменена."
      };
    }

    const container = findChatContainer();
    const priorCount = readVisibleMessages(container).length;

    setInputText(inputEl, textToSend);
    await new Promise((r) => setTimeout(r, 150));

    if (!getInputText(inputEl).replace(/\s+/g, " ").trim()) {
      return {
        status: "blocked",
        error: "Редактор чата Twitch не принял текст. Клик по отправке не выполнялся."
      };
    }

    const sendBtn = findSendButton();
    if (!sendBtn || sendBtn.disabled || sendBtn.getAttribute("aria-disabled") === "true") {
      return {
        status: "blocked",
        error: "Кнопка отправки недоступна после ввода текста (возможно, ограничение чата или медленный режим)."
      };
    }

    sendBtn.click();

    const appeared = await waitForSentMessageInDom(textToSend, priorCount, 6000);
    if (appeared) {
      return { status: "confirmed", error: "" };
    }
    return {
      status: "uncertain",
      error: "Сообщение отправлено в форму, но не подтверждено в DOM за 6 с. Повтор вслепую не выполняется."
    };
  }

  function sendContextSnapshot() {
    const channel = extractChannelFromPath(window.location.pathname);
    const container = findChatContainer();
    const messages = readVisibleMessages(container);

    try {
      chrome.runtime.sendMessage(
        {
          type: "TWITCH_PAGE_CONTEXT_UPDATE",
          channel,
          chatDetected: Boolean(container),
          messages
        },
        () => {
          void chrome.runtime.lastError;
        }
      );
    } catch (_err) {
      // No-op when extension reloads.
    }
  }

  function scheduleSnapshot() {
    if (flushTimer !== null) {
      clearTimeout(flushTimer);
    }
    flushTimer = setTimeout(() => {
      flushTimer = null;
      sendContextSnapshot();
    }, 250);
  }

  function attachObserver() {
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    const container = findChatContainer();
    if (!container) {
      return;
    }
    observer = new MutationObserver(() => {
      scheduleSnapshot();
    });
    observer.observe(container, { childList: true, subtree: true });
  }

  function initOrRefresh() {
    attachObserver();
    sendContextSnapshot();
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message && message.type === "SEND_CHAT_MESSAGE_ONCE") {
      void handleSendOnce(message.expectedChannel, message.text).then((res) => {
        sendResponse(res);
      });
      return true;
    }
    return false;
  });

  setInterval(() => {
    if (window.location.href !== lastUrl) {
      lastUrl = window.location.href;
      initOrRefresh();
      return;
    }
    if (!observer && findChatContainer()) {
      initOrRefresh();
    }
  }, 1500);

  initOrRefresh();
})();
