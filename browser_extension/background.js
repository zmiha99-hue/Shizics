"use strict";

importScripts("llm.js");

// Auto-send re-enabled after Group 1-3 review fixes & Chrome V8 verification.
const AUTO_SEND_DISABLED_FOR_REVIEW = false;

const DEFAULT_SETTINGS = {
  allowedChannel: "",
  controllerLogin: "",
  botLogin: "",
  contextWindow: 12,
  runState: "running",
  provider: "ollama",
  endpointUrl: "http://localhost:11434",
  model: "qwen2.5:3b",
  personaPrompt: "",
  useAiPrefix: false,
  deepThink: true,
  proactiveQuestions: true
};

const DEFAULT_STATE = {
  channel: "",
  channelAllowed: false,
  chatDetected: false,
  tabId: null,
  dedupCount: 0,
  messages: [],
  recentSentTexts: [],
  ignoredIds: [],
  processedTriggerIds: [],
  lastQuestionAt: null,
  lastActivityAt: null,
  lastUpdated: null,
  statusText: "Ожидание вкладки Twitch"
};

const DEFAULT_DRAFT = {
  draftId: "",
  status: "idle",
  text: "",
  pendingMemoryFact: "",
  triggerMessageId: "",
  triggerAuthor: "",
  triggerText: "",
  model: "",
  isStub: true,
  usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  error: "",
  updatedAt: null
};

const DEFAULT_LLM_STATS = {
  requestCount: 0,
  totalTokens: 0,
  lastModel: "stub-local",
  lastIsStub: true,
  lastError: ""
};

const DEFAULT_DELIVERY = {
  status: "idle",
  text: "",
  error: "",
  timestamp: null
};

const DEFAULT_AUTO = {
  enabled: false,
  startedAt: null,
  expiresAt: null,
  sentCount: 0,
  maxMessages: 100,
  minIntervalSec: 20,
  durationMin: 15,
  lastSentAt: null,
  nextAllowedAt: null,
  recentAutoTimestamps: [],
  pendingAutoReply: false,
  stopReason: ""
};

let isGenerating = false;
let isSending = false;
let runEpoch = 0;
let autoStopTimer = null;
let stateQueue = Promise.resolve();

function withStateLock(fn) {
  const next = stateQueue.then(() => fn());
  stateQueue = next.catch(() => {});
  return next;
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((err) => console.error("sidePanel.setPanelBehavior failed:", err));

  void withStateLock(async () => {
    const res = await chrome.storage.local.get([
      "settings",
      "contextState",
      "draftState",
      "llmStats",
      "deliveryState",
      "autoExperiment"
    ]);
    const init = {};
    if (!res.settings) {
      init.settings = DEFAULT_SETTINGS;
    } else {
      const migrated = { ...DEFAULT_SETTINGS, ...res.settings };
      if (migrated.model === "gemini-2.5-flash" || migrated.model === "gemini-2.5-flash-lite") {
        migrated.model = "gemini-3.8-flash";
      }
      init.settings = migrated;
    }
    if (!res.contextState) init.contextState = DEFAULT_STATE;
    if (!res.draftState) init.draftState = DEFAULT_DRAFT;
    if (!res.llmStats) init.llmStats = DEFAULT_LLM_STATS;
    if (!res.deliveryState) init.deliveryState = DEFAULT_DELIVERY;
    init.autoExperiment = {
      ...DEFAULT_AUTO,
      ...(res.autoExperiment || {}),
      enabled: false,
      stopReason: AUTO_SEND_DISABLED_FOR_REVIEW
        ? DEFAULT_AUTO.stopReason
        : ((res.autoExperiment && res.autoExperiment.stopReason) || "")
    };
    await chrome.storage.local.set(init);
  });
});

function normalizeLogin(value) {
  return String(value || "").trim().replace(/^#/, "").toLowerCase();
}

function normalizeTextForMatch(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function isExplicitlyAddressedToOther(text, botLogin) {
  const match = String(text || "").trim().match(/^@([A-Za-z0-9_]{2,30})\b/);
  if (!match) return false;
  const mentioned = match[1].toLowerCase();
  const botNorm = normalizeLogin(botLogin);
  if (botNorm && mentioned === botNorm) return false;
  return true;
}

function parseControllerLogins(value) {
  return new Set(
    String(value || "")
      .split(/[,;\s]+/)
      .map(normalizeLogin)
      .filter(Boolean)
  );
}

function classifyRole(author, text, controllerLogin, recentSentTexts = [], botLogin = "") {
  const normText = normalizeTextForMatch(text);
  const normAuthor = normalizeLogin(author);
  const normBot = normalizeLogin(botLogin);
  if (normBot && normAuthor === normBot) {
    return "own_ai";
  }
  if (normText.startsWith("[AI]")) {
    return "own_ai";
  }
  if (Array.isArray(recentSentTexts) && recentSentTexts.includes(normText)) {
    return "own_ai";
  }
  const controllers = parseControllerLogins(controllerLogin);
  if (controllers.size > 0 && controllers.has(normAuthor)) {
    return "controller_human";
  }
  return "other";
}

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local" || !changes.settings) return;
  const oldVal = changes.settings.oldValue || {};
  const newVal = changes.settings.newValue || {};

  if (oldVal.runState !== newVal.runState && (newVal.runState === "paused" || newVal.runState === "stopped")) {
    runEpoch += 1;
  }

  if (oldVal.controllerLogin === newVal.controllerLogin && oldVal.botLogin === newVal.botLogin) return;

  void withStateLock(async () => {
    const res = await chrome.storage.local.get(["contextState"]);
    const state = res.contextState;
    if (!state || !Array.isArray(state.messages) || state.messages.length === 0) return;
    const recentSent = state.recentSentTexts || [];
    const updatedMessages = state.messages.map((m) => ({
      ...m,
      role: classifyRole(m.author, m.text, newVal.controllerLogin || "", recentSent, newVal.botLogin || "")
    }));
    await chrome.storage.local.set({ contextState: { ...state, messages: updatedMessages } });
  });
});

async function appendExperimentLog(entry) {
  const latest = await chrome.storage.local.get(["experimentLog"]);
  const prevLog = Array.isArray(latest.experimentLog) ? latest.experimentLog : [];
  const record = {
    timestamp: new Date().toISOString(),
    ...entry
  };
  await chrome.storage.local.set({
    experimentLog: [...prevLog, record].slice(-200)
  });
}

async function stopAutoExperiment(reason, pauseRunState = false) {
  if (autoStopTimer !== null) {
    clearTimeout(autoStopTimer);
    autoStopTimer = null;
  }
  await withStateLock(async () => {
    const stored = await chrome.storage.local.get(["autoExperiment", "settings"]);
    const prevAuto = { ...DEFAULT_AUTO, ...(stored.autoExperiment || {}) };
    const nextAuto = {
      ...prevAuto,
      enabled: false,
      stopReason: reason || prevAuto.stopReason
    };
    const updates = { autoExperiment: nextAuto };
    if (pauseRunState) {
      runEpoch += 1;
      const prevSettings = { ...DEFAULT_SETTINGS, ...(stored.settings || {}) };
      updates.settings = { ...prevSettings, runState: "paused" };
    }
    await chrome.storage.local.set(updates);
  });
}

function computeNextAllowedAt() {
  // Natural human-like reading/typing delay between replies: 4..11 seconds.
  const jitterMs = 4000 + Math.floor(Math.random() * 7000);
  return Date.now() + jitterMs;
}

async function enforceAutoLimits() {
  if (AUTO_SEND_DISABLED_FOR_REVIEW) {
    return { active: false, canSendNow: false, auto: { ...DEFAULT_AUTO, enabled: false } };
  }
  const stored = await chrome.storage.local.get(["autoExperiment"]);
  const auto = { ...DEFAULT_AUTO, ...(stored.autoExperiment || {}) };
  if (!auto.enabled) {
    return { active: false, canSendNow: false, auto };
  }

  const now = Date.now();
  if (auto.expiresAt && now >= auto.expiresAt) {
    await stopAutoExperiment("Авторежим остановлен по таймеру (15 минут).");
    return { active: false, canSendNow: false, auto: { ...auto, enabled: false } };
  }
  if (auto.sentCount >= auto.maxMessages) {
    await stopAutoExperiment(`Авторежим завершён: достигнут лимит ${auto.maxMessages} сообщений.`);
    return { active: false, canSendNow: false, auto: { ...auto, enabled: false } };
  }

  const perMinuteCap = Math.max(1, Math.ceil(auto.maxMessages / (auto.durationMin || 15)));
  const recentInMinute = (Array.isArray(auto.recentAutoTimestamps) ? auto.recentAutoTimestamps : [])
    .filter((ts) => now - ts < 60000);

  if (recentInMinute.length >= perMinuteCap) {
    const oldestInWindow = recentInMinute[0];
    const windowFreeAt = oldestInWindow + 60000;
    return {
      active: true,
      canSendNow: false,
      waitSec: Math.max(1, Math.ceil((windowFreeAt - now) / 1000)),
      auto
    };
  }

  const targetTs = auto.nextAllowedAt || 0;
  return {
    active: true,
    canSendNow: now >= targetTs,
    waitSec: Math.max(0, Math.ceil((targetTs - now) / 1000)),
    auto
  };
}

async function handleConfirmSendOnce(editedText, isAutoSend = false) {
  if (isAutoSend && AUTO_SEND_DISABLED_FOR_REVIEW) {
    return { ok: false, error: "Автоотправка отключена на время проверки." };
  }
  if (isSending) {
    return { ok: false, error: "Отправка уже выполняется. Подождите завершения." };
  }
  isSending = true;

  try {
    let prepError = null;
    let tabIdToSend = null;
    let expectedChannel = "";
    let finalText = "";
    let draftSnapshot = null;

    await withStateLock(async () => {
      const stored = await chrome.storage.local.get(["settings", "contextState", "draftState"]);
      const settings = { ...DEFAULT_SETTINGS, ...(stored.settings || {}) };
      const state = { ...DEFAULT_STATE, ...(stored.contextState || {}) };
      const draft = { ...DEFAULT_DRAFT, ...(stored.draftState || {}) };

      if (settings.runState === "stopped" || (isAutoSend && settings.runState !== "running")) {
        prepError = "Отправка запрещена в текущем состоянии (Пауза/Стоп).";
        return;
      }
      if (draft.status === "sending" || draft.status === "sent_confirmed") {
        prepError = "Этот черновик уже отправлен или отправляется.";
        return;
      }
      if (!state.channelAllowed || !state.tabId) {
        prepError = "Нет активной разрешённой вкладки Twitch для отправки.";
        return;
      }

      const rawText = normalizeTextForMatch(editedText || draft.text || "");
      if (!rawText) {
        prepError = "Текст сообщения пуст.";
        return;
      }
      if (looksLikeRawJson(rawText)) {
        prepError = "Заблокирована попытка отправки сырого или повреждённого JSON.";
        return;
      }
      if (isChatCommand(rawText)) {
        prepError = "Запрещена отправка Twitch-команд (/ или .).";
        return;
      }

      finalText = settings.useAiPrefix
        ? (rawText.startsWith("[AI]") ? rawText : `[AI] ${rawText}`)
        : rawText.replace(/^\[AI\]\s*/i, "");

      if (isChatCommand(finalText) || looksLikeRawJson(finalText)) {
        prepError = "Небезопасный текст ответа заблокирован перед отправкой.";
        return;
      }

      tabIdToSend = state.tabId;
      expectedChannel = normalizeLogin(settings.allowedChannel);
      draftSnapshot = draft;

      await chrome.storage.local.set({
        draftState: { ...draft, status: "sending", text: finalText, updatedAt: new Date().toISOString() },
        deliveryState: { status: "sending", text: finalText, error: "", timestamp: new Date().toISOString() }
      });
    });

    if (prepError) {
      return { ok: false, error: prepError };
    }

    if (isAutoSend) {
      const typingDelayMs = 3000 + Math.min(4500, finalText.length * 45);
      const sendEpoch = runEpoch;
      await new Promise((r) => setTimeout(r, typingDelayMs));
      const recheck = await chrome.storage.local.get(["settings"]);
      const curSettings = { ...DEFAULT_SETTINGS, ...(recheck.settings || {}) };
      if (sendEpoch !== runEpoch || curSettings.runState !== "running") {
        await withStateLock(async () => {
          await chrome.storage.local.set({
            draftState: { ...draftSnapshot, status: "idle", updatedAt: new Date().toISOString() },
            deliveryState: { status: "idle", text: "", error: "", timestamp: null }
          });
        });
        return { ok: false, error: "Автоотправка отменена (Пауза/Стоп во время набора)." };
      }
    }

    let sendResp;
    try {
      sendResp = await chrome.tabs.sendMessage(tabIdToSend, {
        type: "SEND_CHAT_MESSAGE_ONCE",
        expectedChannel,
        text: finalText
      });
    } catch (err) {
      const errMsg = `Не удалось связаться со страницей Twitch: ${err && err.message ? err.message : String(err)}`;
      await withStateLock(async () => {
        await chrome.storage.local.set({
          draftState: { ...draftSnapshot, status: "send_failed", error: errMsg, updatedAt: new Date().toISOString() },
          deliveryState: { status: "blocked", text: finalText, error: errMsg, timestamp: new Date().toISOString() }
        });
      });
      if (isAutoSend) {
        await stopAutoExperiment(`Авторежим остановлен: ${errMsg}`, true);
      }
      return { ok: false, error: errMsg };
    }

    const deliveryStatus = (sendResp && sendResp.status) || "blocked";
    const deliveryError = (sendResp && sendResp.error) || "";
    const draftStatus =
      deliveryStatus === "confirmed"
        ? "sent_confirmed"
        : deliveryStatus === "uncertain"
          ? "sent_uncertain"
          : "send_failed";

    await withStateLock(async () => {
      const latest = await chrome.storage.local.get(["contextState", "autoExperiment", "characterMemory"]);
      const latestState = { ...DEFAULT_STATE, ...(latest.contextState || {}) };
      const updates = {
        draftState: {
          ...draftSnapshot,
          status: draftStatus,
          text: finalText,
          error: deliveryError,
          updatedAt: new Date().toISOString()
        },
        deliveryState: {
          status: deliveryStatus,
          text: finalText,
          error: deliveryError,
          timestamp: new Date().toISOString()
        }
      };

      if (deliveryStatus === "confirmed" || deliveryStatus === "uncertain") {
        const prevSent = Array.isArray(latestState.recentSentTexts) ? latestState.recentSentTexts : [];
        updates.contextState = {
          ...latestState,
          recentSentTexts: [...prevSent, normalizeTextForMatch(finalText)].slice(-25)
        };
      }

      if (deliveryStatus === "confirmed" && draftSnapshot && draftSnapshot.pendingMemoryFact) {
        const prevMem = Array.isArray(latest.characterMemory) ? latest.characterMemory : [];
        const fact = sanitizeMemoryFact(draftSnapshot.pendingMemoryFact);
        if (fact && !prevMem.some((f) => f.toLowerCase() === fact.toLowerCase())) {
          updates.characterMemory = [...prevMem, fact].slice(-15);
        }
      }

      await chrome.storage.local.set(updates);
      await appendExperimentLog({
        event: isAutoSend ? "auto_send" : "manual_send",
        channel: latestState.channel,
        triggerAuthor: draftSnapshot ? draftSnapshot.triggerAuthor : "",
        triggerText: draftSnapshot ? draftSnapshot.triggerText : "",
        reply: finalText,
        memoryFact: (draftSnapshot && draftSnapshot.pendingMemoryFact) || "",
        model: (draftSnapshot && draftSnapshot.model) || "",
        deliveryStatus,
        error: deliveryError
      });
    });

    if (isAutoSend) {
      if (deliveryStatus === "confirmed") {
        let reachedMax = false;
        await withStateLock(async () => {
          const latest = await chrome.storage.local.get(["autoExperiment"]);
          const auto = { ...DEFAULT_AUTO, ...(latest.autoExperiment || {}) };
          const nextCount = auto.sentCount + 1;
          reachedMax = nextCount >= auto.maxMessages;
          const nowSent = Date.now();
          const prevRecent = (Array.isArray(auto.recentAutoTimestamps) ? auto.recentAutoTimestamps : [])
            .filter((ts) => nowSent - ts < 60000);
          await chrome.storage.local.set({
            autoExperiment: {
              ...auto,
              sentCount: nextCount,
              lastSentAt: nowSent,
              nextAllowedAt: computeNextAllowedAt(),
              recentAutoTimestamps: [...prevRecent, nowSent],
              pendingAutoReply: false
            }
          });
        });
        if (reachedMax) {
          await stopAutoExperiment("Авторежим завершён: достигнут лимит сообщений.");
        }
      } else {
        await stopAutoExperiment(
          `Авторежим остановлен (${deliveryStatus}): ${deliveryError || "неопределённый результат доставки"}`,
          true
        );
      }
    }

    return { ok: deliveryStatus === "confirmed", status: deliveryStatus, error: deliveryError };
  } finally {
    isSending = false;
  }
}

async function runDraftGeneration(triggerMessage, contextMessages) {
  if (isGenerating) {
    return;
  }
  isGenerating = true;
  const startEpoch = runEpoch;

  try {
    const stored = await chrome.storage.local.get(["settings", "geminiApiKey", "contextState", "characterMemory"]);
    const settings = { ...DEFAULT_SETTINGS, ...(stored.settings || {}) };
    if (settings.runState !== "running") {
      return;
    }

    const apiKey = String(stored.geminiApiKey || "").trim();
    const prevState = { ...DEFAULT_STATE, ...(stored.contextState || {}) };
    const characterMemory = Array.isArray(stored.characterMemory) ? stored.characterMemory : [];
    const nowMs = Date.now();
    const lastQ = prevState.lastQuestionAt || 0;
    const askQuestionHint =
      settings.proactiveQuestions !== false &&
      contextMessages.length >= 2 &&
      nowMs - lastQ >= 270000;

    await withStateLock(async () => {
      await chrome.storage.local.set({
        draftState: {
          ...DEFAULT_DRAFT,
          status: "generating",
          triggerMessageId: triggerMessage.id,
          triggerAuthor: triggerMessage.author,
          triggerText: triggerMessage.text,
          updatedAt: new Date().toISOString()
        }
      });
    });

    try {
      const result = await generatePreviewReply({
        provider: settings.provider,
        apiKey,
        endpointUrl: settings.endpointUrl,
        model: settings.model,
        personaPrompt: settings.personaPrompt,
        messages: contextMessages,
        triggerMessage,
        useAiPrefix: Boolean(settings.useAiPrefix),
        deepThink: settings.deepThink !== false,
        askQuestionHint,
        botLogin: settings.botLogin || "",
        characterMemory,
        channel: prevState.channel || settings.allowedChannel || ""
      });

      let shouldAutoSendText = null;
      await withStateLock(async () => {
        const latest = await chrome.storage.local.get(["settings", "llmStats", "contextState"]);
        const latestSettings = { ...DEFAULT_SETTINGS, ...(latest.settings || {}) };
        if (startEpoch !== runEpoch || latestSettings.runState !== "running") {
          return;
        }

        const prevStats = { ...DEFAULT_LLM_STATS, ...(latest.llmStats || {}) };
        const latestState = { ...DEFAULT_STATE, ...(latest.contextState || {}) };
        const isNoReply = result.text === "NO_REPLY";

        const nextDraft = {
          draftId: `draft_${Date.now()}`,
          status: isNoReply ? "no_reply" : "preview",
          text: isNoReply ? "" : result.text,
          pendingMemoryFact: isNoReply ? "" : (result.memoryFact || ""),
          triggerMessageId: triggerMessage.id,
          triggerAuthor: triggerMessage.author,
          triggerText: triggerMessage.text,
          model: result.model,
          isStub: result.isStub,
          usage: result.usage,
          error: "",
          updatedAt: new Date().toISOString()
        };

        const nextStats = {
          requestCount: prevStats.requestCount + 1,
          totalTokens: prevStats.totalTokens + Number((result.usage && result.usage.totalTokens) || 0),
          lastModel: result.model,
          lastIsStub: result.isStub,
          lastError: ""
        };

        const updates = { draftState: nextDraft, llmStats: nextStats };
        if (!isNoReply && result.text.includes("?")) {
          updates.contextState = { ...latestState, lastQuestionAt: Date.now() };
        }
        await chrome.storage.local.set(updates);
        if (isNoReply) {
          await appendExperimentLog({
            event: "no_reply",
            channel: latestState.channel,
            triggerAuthor: triggerMessage.author,
            triggerText: triggerMessage.text,
            reply: "",
            model: result.model,
            deliveryStatus: "skipped",
            error: ""
          });
        }

        if (!isNoReply && !AUTO_SEND_DISABLED_FOR_REVIEW) {
          shouldAutoSendText = nextDraft.text;
        }
      });

      if (shouldAutoSendText) {
        const autoCheck = await enforceAutoLimits();
        if (autoCheck.active && autoCheck.canSendNow) {
          await handleConfirmSendOnce(shouldAutoSendText, true);
        }
      }
    } catch (err) {
      const errMsg = err && err.message ? err.message : String(err);
      await withStateLock(async () => {
        const latest = await chrome.storage.local.get(["settings", "llmStats"]);
        const latestSettings = { ...DEFAULT_SETTINGS, ...(latest.settings || {}) };
        if (startEpoch !== runEpoch || latestSettings.runState !== "running") {
          return;
        }
        const prevStats = { ...DEFAULT_LLM_STATS, ...(latest.llmStats || {}) };
        await chrome.storage.local.set({
          draftState: {
            ...DEFAULT_DRAFT,
            status: "error",
            triggerMessageId: triggerMessage.id,
            triggerAuthor: triggerMessage.author,
            triggerText: triggerMessage.text,
            error: errMsg,
            updatedAt: new Date().toISOString()
          },
          llmStats: {
            ...prevStats,
            requestCount: prevStats.requestCount + 1,
            lastError: errMsg
          }
        });
      });
    }
  } finally {
    isGenerating = false;
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== "object") {
    return false;
  }

  if (message.type === "TWITCH_PAGE_CONTEXT_UPDATE") {
    const tabUrl = sender && sender.tab && sender.tab.url ? sender.tab.url : "";
    if (!tabUrl.startsWith("https://www.twitch.tv/")) {
      return false;
    }
    const tabId = sender && sender.tab ? sender.tab.id : null;

    void withStateLock(async () => {
      const res = await chrome.storage.local.get(["settings", "contextState"]);
      const settings = { ...DEFAULT_SETTINGS, ...(res.settings || {}) };
      const prev = { ...DEFAULT_STATE, ...(res.contextState || {}) };

      if (settings.runState !== "running") {
        sendResponse({ ok: true, skipped: settings.runState });
        return;
      }

      const pageChannel = normalizeLogin(message.channel);
      const allowedChannel = normalizeLogin(settings.allowedChannel);
      const channelAllowed = Boolean(allowedChannel && pageChannel && pageChannel === allowedChannel);

      if (!channelAllowed) {
        const mismatchState = {
          ...prev,
          channel: pageChannel,
          channelAllowed: false,
          chatDetected: Boolean(message.chatDetected),
          tabId,
          lastUpdated: new Date().toISOString(),
          statusText: allowedChannel
            ? `Канал '${pageChannel || "не определён"}' не совпадает с разрешённым '${allowedChannel}'`
            : "Укажите разрешённый канал в настройках панели"
        };
        await chrome.storage.local.set({ contextState: mismatchState });
        sendResponse({ ok: true, channelAllowed: false });
        return;
      }

      const incoming = Array.isArray(message.messages) ? message.messages : [];
      const existing = Array.isArray(prev.messages) && prev.channel === pageChannel ? prev.messages : [];
      const recentSent = Array.isArray(prev.recentSentTexts) ? prev.recentSentTexts : [];
      const ignoredList = Array.isArray(prev.ignoredIds) && prev.channel === pageChannel ? prev.ignoredIds : [];
      const processedList = Array.isArray(prev.processedTriggerIds) && prev.channel === pageChannel ? prev.processedTriggerIds : [];
      const ignoredSet = new Set(ignoredList);
      const seen = new Set(existing.map((m) => m.id));
      const processedSet = new Set(processedList);
      let dedupAdded = 0;
      const newlyAdded = [];

      const merged = [...existing];
      for (const item of incoming) {
        const id = String(item.id || "");
        if (!id || ignoredSet.has(id)) continue;
        if (seen.has(id)) {
          dedupAdded += 1;
          continue;
        }
        seen.add(id);
        const normalized = {
          id,
          author: String(item.author || "unknown"),
          text: String(item.text || ""),
          timestamp: String(item.timestamp || new Date().toISOString()),
          role: classifyRole(item.author, item.text, settings.controllerLogin, recentSent, settings.botLogin)
        };
        merged.push(normalized);
        newlyAdded.push(normalized);
      }

      const windowSize = Math.max(1, Math.min(30, Number(settings.contextWindow) || 12));
      const trimmed = merged.slice(-windowSize);

      let triggerCandidate = null;
      if (existing.length > 0 && newlyAdded.length > 0) {
        const controllerMsgs = newlyAdded.filter((m) => m.role === "controller_human");
        const latestCtrl = controllerMsgs[controllerMsgs.length - 1];
        if (
          latestCtrl &&
          !processedSet.has(latestCtrl.id) &&
          !isExplicitlyAddressedToOther(latestCtrl.text, settings.botLogin)
        ) {
          triggerCandidate = latestCtrl;
          processedList.push(latestCtrl.id);
        }
      }

      const nextState = {
        channel: pageChannel,
        channelAllowed: true,
        chatDetected: Boolean(message.chatDetected),
        tabId,
        recentSentTexts: recentSent,
        ignoredIds: ignoredList,
        processedTriggerIds: processedList.slice(-200),
        lastQuestionAt: prev.lastQuestionAt || null,
        lastActivityAt: newlyAdded.length > 0 ? Date.now() : (prev.lastActivityAt || Date.now()),
        dedupCount: (prev.channel === pageChannel ? prev.dedupCount : 0) + dedupAdded,
        messages: trimmed,
        lastUpdated: new Date().toISOString(),
        statusText: message.chatDetected
          ? `Чтение чата #${pageChannel} активно`
          : `Канал #${pageChannel} открыт, контейнер чата не найден`
      };

      await chrome.storage.local.set({ contextState: nextState });
      sendResponse({ ok: true, channelAllowed: true, count: trimmed.length });

      if (triggerCandidate) {
        const autoCheck = await enforceAutoLimits();
        if (autoCheck.active && !autoCheck.canSendNow) {
          // Still in >20s cooldown: keep reading context and reply once cooldown + jitter elapses.
          const latestAuto = await chrome.storage.local.get(["autoExperiment"]);
          const curAuto = { ...DEFAULT_AUTO, ...(latestAuto.autoExperiment || {}) };
          if (curAuto.enabled && !curAuto.pendingAutoReply) {
            await chrome.storage.local.set({
              autoExperiment: { ...curAuto, pendingAutoReply: true }
            });
          }
        } else {
          void runDraftGeneration(triggerCandidate, trimmed);
        }
      }
    });
    return true;
  }

  if (message.type === "GENERATE_PREVIEW_NOW") {
    void withStateLock(async () => {
      const res = await chrome.storage.local.get(["contextState", "settings"]);
      const state = { ...DEFAULT_STATE, ...(res.contextState || {}) };
      const settings = { ...DEFAULT_SETTINGS, ...(res.settings || {}) };
      if (settings.runState !== "running") {
        sendResponse({ ok: false, error: "Нажмите 'Старт' перед генерацией." });
        return;
      }
      const msgs = Array.isArray(state.messages) ? state.messages : [];
      if (!state.channelAllowed || msgs.length === 0) {
        sendResponse({ ok: false, error: "Нет доступного контекста разрешённого канала." });
        return;
      }
      const ctrlMsgs = msgs.filter((m) => m.role === "controller_human");
      const target = ctrlMsgs[ctrlMsgs.length - 1] || msgs[msgs.length - 1];
      sendResponse({ ok: true });
      void runDraftGeneration(target, msgs);
    });
    return true;
  }

  if (message.type === "CONFIRM_SEND_ONCE") {
    void handleConfirmSendOnce(message.editedText, false).then((res) => sendResponse(res));
    return true;
  }

  if (message.type === "TOGGLE_AUTO_MODE") {
    if (AUTO_SEND_DISABLED_FOR_REVIEW) {
      sendResponse({
        ok: false,
        error: "Автоотправка временно отключена на время исправлений и проверки."
      });
      return false;
    }
    const enable = Boolean(message.enabled);
    if (!enable) {
      void stopAutoExperiment("Авторежим остановлен пользователем.").then(() => sendResponse({ ok: true }));
      return true;
    }

    void withStateLock(async () => {
      const res = await chrome.storage.local.get(["contextState", "settings"]);
      const state = { ...DEFAULT_STATE, ...(res.contextState || {}) };
      const settings = { ...DEFAULT_SETTINGS, ...(res.settings || {}) };
      if (!state.channelAllowed || settings.runState !== "running") {
        sendResponse({
          ok: false,
          error: "Для авторежима нужен разрешённый канал и состояние 'Старт'."
        });
        return;
      }
      const now = Date.now();
      const durationMs = DEFAULT_AUTO.durationMin * 60 * 1000;
      const reqMax = Number(message.maxMessages);
      const maxMessages = [10, 30, 45, 60, 100].includes(reqMax) ? reqMax : DEFAULT_AUTO.maxMessages;
      const reqInterval = Number(message.minIntervalSec);
      const minIntervalSec = [20, 30, 60].includes(reqInterval) ? reqInterval : DEFAULT_AUTO.minIntervalSec;

      const nextAuto = {
        ...DEFAULT_AUTO,
        enabled: true,
        startedAt: now,
        expiresAt: now + durationMs,
        sentCount: 0,
        maxMessages,
        minIntervalSec,
        lastSentAt: null,
        stopReason: ""
      };
      if (autoStopTimer !== null) {
        clearTimeout(autoStopTimer);
      }
      autoStopTimer = setTimeout(() => {
        void stopAutoExperiment("Авторежим остановлен по таймеру (15 минут).");
      }, durationMs);

      await chrome.storage.local.set({ autoExperiment: nextAuto });
      sendResponse({ ok: true });
    });
    return true;
  }

  if (message.type === "CLEAR_EXPERIMENT_LOG") {
    void withStateLock(async () => {
      await chrome.storage.local.set({ experimentLog: [] });
      sendResponse({ ok: true });
    });
    return true;
  }

  if (message.type === "DISCARD_DRAFT") {
    void withStateLock(async () => {
      await chrome.storage.local.set({ draftState: DEFAULT_DRAFT });
      sendResponse({ ok: true });
    });
    return true;
  }

  if (message.type === "CLEAR_CHARACTER_MEMORY") {
    void withStateLock(async () => {
      await chrome.storage.local.set({ characterMemory: [] });
      sendResponse({ ok: true });
    });
    return true;
  }

  if (message.type === "CLEAR_CONTEXT_ONLY") {
    runEpoch += 1;
    void withStateLock(async () => {
      const res = await chrome.storage.local.get(["contextState"]);
      const prev = { ...DEFAULT_STATE, ...(res.contextState || {}) };
      const oldIds = (Array.isArray(prev.messages) ? prev.messages : []).map((m) => m.id).filter(Boolean);
      const prevIgnored = Array.isArray(prev.ignoredIds) ? prev.ignoredIds : [];
      const mergedIgnored = Array.from(new Set([...prevIgnored, ...oldIds])).slice(-400);

      await chrome.storage.local.set({
        contextState: {
          ...prev,
          messages: [],
          recentSentTexts: [],
          ignoredIds: mergedIgnored,
          processedTriggerIds: [],
          dedupCount: 0,
          lastUpdated: new Date().toISOString(),
          statusText: "Контекст очищен; ожидание новых сообщений"
        },
        draftState: DEFAULT_DRAFT
      });
      sendResponse({ ok: true });
    });
    return true;
  }

  if (message.type === "CLEAR_CONTEXT_BUFFER") {
    runEpoch += 1;
    void stopAutoExperiment("Остановлено пользователем.").then(async () => {
      await withStateLock(async () => {
        const res = await chrome.storage.local.get(["contextState"]);
        const prev = { ...DEFAULT_STATE, ...(res.contextState || {}) };
        const oldIds = (Array.isArray(prev.messages) ? prev.messages : []).map((m) => m.id).filter(Boolean);
        const prevIgnored = Array.isArray(prev.ignoredIds) ? prev.ignoredIds : [];
        const mergedIgnored = Array.from(new Set([...prevIgnored, ...oldIds])).slice(-400);
        await chrome.storage.local.set({
          contextState: { ...DEFAULT_STATE, ignoredIds: mergedIgnored, channel: prev.channel, tabId: prev.tabId },
          draftState: DEFAULT_DRAFT
        });
        sendResponse({ ok: true });
      });
    });
    return true;
  }

  return false;
});

// Natural cooldown flush + ~5-minute proactive question check when auto-experiment is active.
setInterval(() => {
  void (async () => {
    if (isGenerating || isSending) return;
    const stored = await chrome.storage.local.get(["settings", "contextState", "autoExperiment"]);
    const settings = { ...DEFAULT_SETTINGS, ...(stored.settings || {}) };
    const state = { ...DEFAULT_STATE, ...(stored.contextState || {}) };
    const auto = { ...DEFAULT_AUTO, ...(stored.autoExperiment || {}) };

    if (!auto.enabled || settings.runState !== "running") return;
    if (!state.channelAllowed || !Array.isArray(state.messages) || state.messages.length === 0) return;

    const autoCheck = await enforceAutoLimits();
    if (!autoCheck.active || !autoCheck.canSendNow) return;

    const ctrlMsgs = state.messages.filter((m) => m.role === "controller_human");
    const target = ctrlMsgs[ctrlMsgs.length - 1] || state.messages[state.messages.length - 1];
    if (!target) return;

    if (auto.pendingAutoReply) {
      await withStateLock(async () => {
        const latest = await chrome.storage.local.get(["autoExperiment"]);
        const cur = { ...DEFAULT_AUTO, ...(latest.autoExperiment || {}) };
        await chrome.storage.local.set({
          autoExperiment: { ...cur, pendingAutoReply: false }
        });
      });
      await runDraftGeneration(target, state.messages);
      return;
    }

    if (settings.proactiveQuestions === false || state.messages.length < 2) return;
    const now = Date.now();
    const quietMs = now - (state.lastActivityAt || now);
    const sinceQuestionMs = now - (state.lastQuestionAt || 0);
    if (quietMs < 270000 || sinceQuestionMs < 270000) return;

    await withStateLock(async () => {
      const latest = await chrome.storage.local.get(["contextState"]);
      const curState = { ...DEFAULT_STATE, ...(latest.contextState || {}) };
      await chrome.storage.local.set({
        contextState: { ...curState, lastQuestionAt: now, lastActivityAt: now }
      });
    });

    await runDraftGeneration(target, state.messages);
  })();
}, 3000);
