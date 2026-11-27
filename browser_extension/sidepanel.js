"use strict";

const ROLE_LABELS = {
  controller_human: "управляющий",
  own_ai: "свой ИИ",
  other: "участник"
};

let lastDraftIdRendered = "";
let currentAutoState = {};
let personaExpanded = false;
let autoUiError = "";

function formatRemaining(expiresAt) {
  if (!expiresAt) return "30:00";
  const sec = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
  const mm = String(Math.floor(sec / 60)).padStart(2, "0");
  const ss = String(sec % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}

function renderAutoSection(auto) {
  currentAutoState = auto || {};
  const enabled = Boolean(auto && auto.enabled);
  const autoBadge = document.getElementById("autoBadge");
  const sendBadge = document.getElementById("sendBadge");
  const autoCounters = document.getElementById("autoCounters");
  const toggleBtn = document.getElementById("toggleAutoBtn");
  const stopReasonEl = document.getElementById("autoStopReason");

  autoBadge.textContent = enabled ? "Активен" : "Выкл";
  autoBadge.className = `pill ${enabled ? "ok" : ""}`;

  sendBadge.textContent = enabled ? "Автоэксперимент" : "Предпросмотр";
  sendBadge.className = `pill ${enabled ? "ok" : "warn"}`;

  const sent = (auto && auto.sentCount) || 0;
  const maxMsg = (auto && auto.maxMessages) || 300;
  const rem = enabled ? formatRemaining(auto.expiresAt) : "30:00";
  autoCounters.textContent = `Отправлено: ${sent} / ${maxMsg} · Осталось: ${rem}`;

  toggleBtn.textContent = enabled ? "Остановить авторежим" : "Включить авторежим";
  toggleBtn.className = enabled ? "subtle-danger" : "primary";

  if (enabled) {
    autoUiError = "";
  }
  stopReasonEl.textContent = autoUiError || (auto && auto.stopReason) || "Ограничения учебного эксперимента (не лимиты Twitch).";
  stopReasonEl.style.color = autoUiError ? "var(--err)" : "";
}

function updateProviderVisibility(provider) {
  const endpointWrap = document.getElementById("endpointWrap");
  const apiKeySection = document.getElementById("apiKeySection");
  endpointWrap.style.display = (provider === "ollama" || provider === "openai_compat") ? "block" : "none";
  apiKeySection.style.display = (provider === "gemini" || provider === "openai_compat") ? "block" : "none";
}

function renderRunButtons(runState) {
  const startBtn = document.getElementById("startBtn");
  const pauseBtn = document.getElementById("pauseBtn");
  const stopBtn = document.getElementById("stopBtn");

  startBtn.className = runState === "running" ? "active" : "";
  pauseBtn.className = runState === "paused" ? "active" : "";
  stopBtn.className = runState === "stopped" ? "active-danger" : "";
}

function renderMemorySection(memoryList) {
  const facts = Array.isArray(memoryList) ? memoryList : [];
  const badge = document.getElementById("memoryCountBadge");
  const feed = document.getElementById("memoryFeed");
  badge.textContent = `${facts.length} / 15`;

  feed.textContent = "";
  if (facts.length === 0) {
    const empty = document.createElement("div");
    empty.className = "meta";
    empty.textContent = "Факты появятся после подтверждённых ответов.";
    feed.appendChild(empty);
    return;
  }

  for (const fact of facts) {
    const item = document.createElement("div");
    item.className = "msg";
    item.textContent = fact;
    feed.appendChild(item);
  }
}

function renderState(settings, state, draft, llmStats, delivery, auto, hasKey, characterMemory = [], experimentLog = []) {
  const runBadge = document.getElementById("runBadge");
  const channelBadge = document.getElementById("channelBadge");
  const statusText = document.getElementById("statusText");
  const statsBadge = document.getElementById("statsBadge");
  const feed = document.getElementById("contextFeed");

  const runState = (settings && settings.runState) || "running";
  runBadge.textContent = `Чтение: ${runState}`;
  runBadge.className = `pill ${runState === "running" ? "ok" : "warn"}`;
  renderRunButtons(runState);

  const ch = (state && state.channel) || "-";
  const allowed = Boolean(state && state.channelAllowed);
  channelBadge.textContent = `Канал: ${ch}`;
  channelBadge.className = `pill ${allowed ? "ok" : "err"}`;

  statusText.textContent = (state && state.statusText) || "Ожидание данных...";

  renderAutoSection(auto);
  renderMemorySection(characterMemory);
  document.getElementById("logCountText").textContent = `Записей в логе: ${(Array.isArray(experimentLog) ? experimentLog.length : 0)}`;

  const provider = (settings && settings.provider) || "ollama";
  updateProviderVisibility(provider);

  const keyStatusText = document.getElementById("keyStatusText");
  keyStatusText.textContent = hasKey ? "Ключ сохранён локально" : "Ключ не задан";

  const llmBadge = document.getElementById("llmBadge");
  const activeModel = (settings && settings.model) || "qwen3.5:9b";
  if (provider === "stub" || (provider === "gemini" && !hasKey)) {
    llmBadge.textContent = "Модель: заглушка";
    llmBadge.className = "pill warn";
  } else {
    llmBadge.textContent = `${provider}: ${activeModel}`;
    llmBadge.className = "pill ok";
  }

  const stats = llmStats || {};
  document.getElementById("llmStatsText").textContent =
    `Запросов: ${stats.requestCount || 0} · Токенов: ${stats.totalTokens || 0}`;

  // Draft preview & send confirmation
  const d = draft || {};
  const triggerEl = document.getElementById("draftTrigger");
  const statusBoxEl = document.getElementById("draftStatusText");
  const editWrap = document.getElementById("draftEditWrap");
  const editInput = document.getElementById("draftEditInput");
  const sendOnceBtn = document.getElementById("sendOnceBtn");
  const errEl = document.getElementById("draftError");

  if (d.triggerAuthor && d.triggerText) {
    triggerEl.textContent = `На сообщение ${d.triggerAuthor}: «${d.triggerText}»`;
  } else {
    triggerEl.textContent = "Ожидает нового сообщения управляющего...";
  }

  const canSendPreview = d.status === "preview" && Boolean(d.text);
  editWrap.style.display = canSendPreview ? "block" : "none";
  sendOnceBtn.style.display = canSendPreview ? "inline-block" : "none";
  sendOnceBtn.disabled = !allowed || runState === "stopped" || d.status === "sending";

  if (canSendPreview) {
    statusBoxEl.style.display = "none";
    if (d.draftId !== lastDraftIdRendered) {
      editInput.value = d.text;
      lastDraftIdRendered = d.draftId || "";
    }
  } else {
    statusBoxEl.style.display = "block";
    lastDraftIdRendered = "";
    if (d.status === "generating") {
      statusBoxEl.textContent = "Генерация ответа...";
    } else if (d.status === "sending") {
      statusBoxEl.textContent = "Отправка в чат Twitch и проверка появления в DOM...";
    } else if (d.status === "no_reply") {
      statusBoxEl.textContent = "Модель решила не отвечать (NO_REPLY).";
    } else if (d.status === "sent_confirmed") {
      statusBoxEl.textContent = `Отправлено и подтверждено в DOM: ${d.text}`;
    } else if (d.status === "sent_uncertain") {
      statusBoxEl.textContent = `Отправлено в форму, но не подтверждено в DOM: ${d.text}`;
    } else if (d.status === "error" || d.status === "send_failed") {
      statusBoxEl.textContent = "Операция остановлена из-за ошибки.";
    } else {
      statusBoxEl.textContent = "Черновик пока не создан.";
    }
  }

  if (d.error) {
    errEl.style.display = "block";
    errEl.textContent = d.error;
  } else {
    errEl.style.display = "none";
    errEl.textContent = "";
  }

  // Delivery badge
  const del = delivery || {};
  const delBadge = document.getElementById("deliveryBadge");
  const delDetail = document.getElementById("deliveryDetail");
  if (del.status === "confirmed") {
    delBadge.textContent = "Доставка: подтверждена в DOM";
    delBadge.className = "pill ok";
    delDetail.textContent = del.timestamp ? `Подтверждено в ${String(del.timestamp).slice(11, 19)} UTC` : "";
  } else if (del.status === "uncertain") {
    delBadge.textContent = "Доставка: не подтверждена";
    delBadge.className = "pill warn";
    delDetail.textContent = del.error || "";
  } else if (del.status === "blocked") {
    delBadge.textContent = "Доставка: остановлена";
    delBadge.className = "pill err";
    delDetail.textContent = del.error || "";
  } else if (del.status === "sending") {
    delBadge.textContent = "Доставка: отправка...";
    delBadge.className = "pill warn";
    delDetail.textContent = "";
  } else {
    delBadge.textContent = "Доставка: ожидание";
    delBadge.className = "pill";
    delDetail.textContent = "";
  }

  // Context feed
  const messages = (state && Array.isArray(state.messages)) ? state.messages : [];
  const dedupCount = (state && state.dedupCount) || 0;
  statsBadge.textContent = `${messages.length} сообщ. · дублей: ${dedupCount}`;

  feed.textContent = "";
  if (messages.length === 0) {
    const empty = document.createElement("div");
    empty.className = "meta";
    empty.textContent = "Сообщений в буфере пока нет.";
    feed.appendChild(empty);
    return;
  }

  for (const msg of messages) {
    const item = document.createElement("div");
    item.className = "msg";
    if (msg.role === "controller_human") item.classList.add("ctrl");
    if (msg.role === "own_ai") item.classList.add("ai");

    const meta = document.createElement("div");
    meta.className = "meta";
    const roleLabel = ROLE_LABELS[msg.role] || "участник";
    const timeShort = msg.timestamp ? String(msg.timestamp).slice(11, 19) : "";
    meta.textContent = `${msg.author} · ${roleLabel}${timeShort ? ` · ${timeShort}` : ""}`;

    const body = document.createElement("div");
    body.textContent = msg.text;

    item.appendChild(meta);
    item.appendChild(body);
    feed.appendChild(item);
  }
  feed.scrollTop = feed.scrollHeight;
}

function loadAndRender(populateInputs = false) {
  chrome.storage.local.get(
    ["settings", "contextState", "draftState", "llmStats", "deliveryState", "autoExperiment", "geminiApiKey", "characterMemory", "experimentLog"],
    (res) => {
      const settings = res.settings || {};
      const state = res.contextState || {};
      const draft = res.draftState || {};
      const llmStats = res.llmStats || {};
      const delivery = res.deliveryState || {};
      const auto = res.autoExperiment || {};
      const characterMemory = Array.isArray(res.characterMemory) ? res.characterMemory : [];
      const experimentLog = Array.isArray(res.experimentLog) ? res.experimentLog : [];
      const hasKey = Boolean(String(res.geminiApiKey || "").trim());

      if (populateInputs) {
        document.getElementById("allowedChannel").value = settings.allowedChannel || "";
        document.getElementById("controllerLogin").value = settings.controllerLogin || "";
        document.getElementById("botLogin").value = settings.botLogin || "";
        document.getElementById("contextWindow").value = settings.contextWindow || 12;
        document.getElementById("useAiPrefixCheck").checked = Boolean(settings.useAiPrefix);
        document.getElementById("deepThinkCheck").checked = settings.deepThink !== false;
        document.getElementById("proactiveQuestionsCheck").checked = settings.proactiveQuestions !== false;
        document.getElementById("providerSelect").value = settings.provider || "ollama";
        document.getElementById("endpointInput").value = settings.endpointUrl || "http://localhost:11434";
        document.getElementById("modelInput").value = settings.model || "qwen3.5:9b";
        document.getElementById("personaPrompt").value = settings.personaPrompt || "";
      }

      renderState(settings, state, draft, llmStats, delivery, auto, hasKey, characterMemory, experimentLog);
    }
  );
}

function updateSettings(partial, showSaved = false) {
  chrome.storage.local.get(["settings"], (res) => {
    const next = {
      allowedChannel: "",
      controllerLogin: "",
      contextWindow: 12,
      runState: "running",
      provider: "ollama",
      endpointUrl: "http://localhost:11434",
      model: "qwen3.5:9b",
      personaPrompt: "",
      useAiPrefix: false,
      deepThink: true,
      proactiveQuestions: true,
      ...(res.settings || {}),
      ...partial
    };
    chrome.storage.local.set({ settings: next }, () => {
      if (showSaved) {
        const hint = document.getElementById("savedHint");
        hint.textContent = "Сохранено";
        setTimeout(() => {
          hint.textContent = "";
        }, 1800);
      }
      loadAndRender(false);
    });
  });
}

document.getElementById("openWindowBtn").addEventListener("click", () => {
  window.open(
    chrome.runtime.getURL("sidepanel.html"),
    "shizofrenia_window",
    "width=960,height=860,resizable=yes,scrollbars=yes"
  );
});

document.getElementById("expandPersonaBtn").addEventListener("click", () => {
  const ta = document.getElementById("personaPrompt");
  const btn = document.getElementById("expandPersonaBtn");
  personaExpanded = !personaExpanded;
  ta.style.height = personaExpanded ? "340px" : "";
  btn.textContent = personaExpanded ? "Свернуть" : "Развернуть";
});

document.getElementById("providerSelect").addEventListener("change", (e) => {
  const provider = e.target.value;
  let endpointUrl = document.getElementById("endpointInput").value.trim();
  let model = document.getElementById("modelInput").value.trim();

  if (provider === "ollama") {
    endpointUrl = "http://localhost:11434";
    if (!model || model.startsWith("gemini-")) model = "qwen2.5:3b";
  } else if (provider === "openai_compat") {
    if (!endpointUrl || endpointUrl.includes("11434")) endpointUrl = "http://127.0.0.1:1234/v1";
  } else if (provider === "gemini") {
    if (!model || !model.startsWith("gemini-")) model = "gemini-3.8-flash";
  }

  document.getElementById("endpointInput").value = endpointUrl;
  document.getElementById("modelInput").value = model;
  updateSettings({ provider, endpointUrl, model });
});

document.getElementById("personaPresetSelect").addEventListener("change", (e) => {
  if (e.target.value) {
    document.getElementById("personaPrompt").value = e.target.value;
    updateSettings({ personaPrompt: e.target.value }, true);
  }
});

document.getElementById("useAiPrefixCheck").addEventListener("change", (e) => {
  updateSettings({ useAiPrefix: Boolean(e.target.checked) });
});

document.getElementById("deepThinkCheck").addEventListener("change", (e) => {
  updateSettings({ deepThink: Boolean(e.target.checked) });
});

document.getElementById("proactiveQuestionsCheck").addEventListener("change", (e) => {
  updateSettings({ proactiveQuestions: Boolean(e.target.checked) });
});

document.getElementById("saveSettingsBtn").addEventListener("click", () => {
  const allowedChannel = document.getElementById("allowedChannel").value.trim().replace(/^#/, "").toLowerCase();
  const controllerLogin = document
    .getElementById("controllerLogin")
    .value.split(/[,;\s]+/)
    .map((s) => s.trim().replace(/^#/, "").toLowerCase())
    .filter(Boolean)
    .join(", ");
  const botLogin = document.getElementById("botLogin").value.trim().replace(/^#/, "").toLowerCase();
  const contextWindow = Math.max(1, Math.min(30, Number(document.getElementById("contextWindow").value) || 12));
  const useAiPrefix = Boolean(document.getElementById("useAiPrefixCheck").checked);
  const deepThink = Boolean(document.getElementById("deepThinkCheck").checked);
  const proactiveQuestions = Boolean(document.getElementById("proactiveQuestionsCheck").checked);
  const provider = document.getElementById("providerSelect").value;
  const endpointUrl = document.getElementById("endpointInput").value.trim();
  const model = document.getElementById("modelInput").value.trim();
  const personaPrompt = document.getElementById("personaPrompt").value.trim();
  updateSettings(
    {
      allowedChannel,
      controllerLogin,
      botLogin,
      contextWindow,
      useAiPrefix,
      deepThink,
      proactiveQuestions,
      provider,
      endpointUrl,
      model,
      personaPrompt
    },
    true
  );
});

document.getElementById("saveKeyBtn").addEventListener("click", () => {
  const keyInput = document.getElementById("geminiKeyInput");
  const val = keyInput.value.trim();
  keyInput.value = "";
  if (!val) return;
  chrome.storage.local.set({ geminiApiKey: val }, () => {
    loadAndRender(false);
  });
});

document.getElementById("clearKeyBtn").addEventListener("click", () => {
  document.getElementById("geminiKeyInput").value = "";
  chrome.storage.local.remove(["geminiApiKey"], () => {
    loadAndRender(false);
  });
});

document.getElementById("toggleAutoBtn").addEventListener("click", () => {
  const enable = !Boolean(currentAutoState && currentAutoState.enabled);
  const [maxStr, intStr] = String(document.getElementById("autoPresetSelect").value || "300:6").split(":");
  const maxMessages = Number(maxStr) || 300;
  const minIntervalSec = Number(intStr) || 6;
  chrome.runtime.sendMessage(
    { type: "TOGGLE_AUTO_MODE", enabled: enable, maxMessages, minIntervalSec },
    (resp) => {
      const err = chrome.runtime.lastError;
      if (err) {
        autoUiError = "Ошибка связи с фоновым сервисом. Перезагрузите расширение.";
      } else if (resp && !resp.ok && resp.error) {
        autoUiError = resp.error;
      } else {
        autoUiError = "";
      }
      loadAndRender(false);
    }
  );
});

document.getElementById("sendOnceBtn").addEventListener("click", () => {
  const editedText = document.getElementById("draftEditInput").value;
  chrome.runtime.sendMessage({ type: "CONFIRM_SEND_ONCE", editedText }, () => {
    void chrome.runtime.lastError;
    loadAndRender(false);
  });
});

document.getElementById("genNowBtn").addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "GENERATE_PREVIEW_NOW" }, (resp) => {
    void chrome.runtime.lastError;
    if (resp && !resp.ok && resp.error) {
      document.getElementById("draftError").style.display = "block";
      document.getElementById("draftError").textContent = resp.error;
    }
    loadAndRender(false);
  });
});

document.getElementById("discardDraftBtn").addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "DISCARD_DRAFT" }, () => {
    void chrome.runtime.lastError;
    loadAndRender(false);
  });
});

document.getElementById("clearContextBtn").addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "CLEAR_CONTEXT_ONLY" }, () => {
    void chrome.runtime.lastError;
    loadAndRender(false);
  });
});

document.getElementById("clearMemoryBtn").addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "CLEAR_CHARACTER_MEMORY" }, () => {
    void chrome.runtime.lastError;
    loadAndRender(false);
  });
});

document.getElementById("exportLogBtn").addEventListener("click", () => {
  chrome.storage.local.get(["experimentLog"], (res) => {
    const entries = Array.isArray(res.experimentLog) ? res.experimentLog : [];
    const jsonl = entries.map((e) => JSON.stringify(e)).join("\n") + (entries.length ? "\n" : "");
    const blob = new Blob([jsonl], { type: "application/x-ndjson;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `shizofrenia_log_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.jsonl`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  });
});

document.getElementById("clearLogBtn").addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "CLEAR_EXPERIMENT_LOG" }, () => {
    void chrome.runtime.lastError;
    loadAndRender(false);
  });
});

document.getElementById("startBtn").addEventListener("click", () => {
  updateSettings({ runState: "running" });
});

document.getElementById("pauseBtn").addEventListener("click", () => {
  updateSettings({ runState: "paused" });
});

document.getElementById("stopBtn").addEventListener("click", () => {
  updateSettings({ runState: "stopped" });
  chrome.runtime.sendMessage({ type: "CLEAR_CONTEXT_BUFFER" }, () => {
    void chrome.runtime.lastError;
    loadAndRender(false);
  });
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (
    areaName === "local" &&
    (changes.settings || changes.contextState || changes.draftState || changes.llmStats || changes.deliveryState || changes.autoExperiment || changes.geminiApiKey || changes.characterMemory || changes.experimentLog)
  ) {
    loadAndRender(false);
  }
});

setInterval(() => {
  if (currentAutoState && currentAutoState.enabled) {
    renderAutoSection(currentAutoState);
  }
}, 1000);

loadAndRender(true);
