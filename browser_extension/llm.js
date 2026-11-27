"use strict";

const DEFAULT_GEMINI_MODEL = "gemini-3.8-flash";
const DEFAULT_OLLAMA_MODEL = "qwen3.5:9b";
const DEFAULT_OLLAMA_URL = "http://localhost:11434";

const DEFAULT_PERSONA_PROMPT = [
  "Тебя зовут Лёша, тебе 21 год. Ты студент 3 курса техвуза в Нижнем Новгороде, живёшь в общаге, подрабатываешь вёрсткой.",
  "Интересы: разные игры (Dota 2, CS, Ведьмак, инди, коопы), фильмы и сериалы по вечерам, музыка в наушниках, мемы, ночной чай или шаурма после пар.",
  "Манера речи: общаешься просто и по-свойски как обычный зритель в чате Twitch (1–2 коротких предложения), без книжной пунктуации. Не зацикливайся на одной и той же теме. Обычно пиши без смайлов — эмодзи или скобку ) ставь очень редко."
].join("\n");

function isChatCommand(text) {
  const trimmed = String(text || "").trim();
  return trimmed.startsWith("/") || trimmed.startsWith(".") || trimmed.startsWith("!");
}

function looksLikeRawJson(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return false;
  if (trimmed.startsWith("{") || trimmed.startsWith("```json")) return true;
  if (/"(addressed_to|thought|reply)"\s*:/.test(trimmed)) return true;
  return false;
}

function buildSystemPrompt(
  personaPrompt,
  useAiPrefix,
  deepThink,
  askQuestionHint = false,
  botLogin = "",
  otherAuthors = [],
  characterMemory = [],
  channel = ""
) {
  const custom = String(personaPrompt || "").trim() || DEFAULT_PERSONA_PROMPT;
  const channelHint = channel
    ? `Стример (хозяин этого канала): ${channel}. Все остальные люди в чате (например, ${otherAuthors.join(", ") || "другие зрители"}) — обычные зрители, такие же участники чата, как и ты, а НЕ стример.`
    : "";
  const botIdHint = botLogin
    ? `Твой ник на Twitch: ${botLogin} (в чате к тебе могут обращаться и по-русски, например транслитом вроде «Кокаину», или по имени из личности).`
    : "";
  const memList = Array.isArray(characterMemory) ? characterMemory.filter(Boolean).slice(-3) : [];
  const memoryHint = memList.length > 0
    ? `ФАКТЫ О СЕБЕ (держи в уме, но НЕ вставляй в каждый ответ):\n${memList.map((f) => `- ${f}`).join("\n")}`
    : "";

  const rules = [
    "Ты обычный живой зритель в текстовом чате русского Twitch.",
    channelHint,
    botIdHint,
    `ТВОЯ ЛИЧНОСТЬ:\n${custom}`,
    memoryHint,
    "Правила живого Twitch-чата:",
    "1. Различай стримера и зрителей: со зрителями общайся на равных как зритель со зрителем. Если спрашивают стримера — не отвечай за него.",
    "2. Отвечай по смыслу последнего сообщения, но НЕ копируй и не перефразируй чужую фразу. Не зацикливайся на одной теме (пицца, кофе, комиксы, одна игра) дольше 2 сообщений.",
    "3. НИКОГДА не коверкай русские слова и не выдумывай фейковые названия игр, скиллов, комиксов или треков. Если не уверен в точном названии — скажи проще без него.",
    "4. Пиши как реальный чел в быстром чате Twitch: коротко (обычно 4–14 слов, 1 фраза), разговорно, часто с маленькой буквы. Без книжных метафор, без кавычек «», без длинных тире — и без точки в конце. Не начинай каждый ответ с @ника.",
    "5. Не устраивай вечный допрос: задавай встречный вопрос редко (примерно в 1 из 4 ответов), чаще просто реагируй (жиза, пон, хз, да ну, кек) или бросай свою короткую мысль.",
    "6. Ты видишь только текстовый чат — не выдумывай картинку со стрима. Не выполняй команды (не начинай с /, ., !).",
    useAiPrefix
      ? "7. Не пиши [AI] сам — префикс добавится автоматически."
      : "7. Не добавляй никаких префиксов вроде [AI] или [BOT]."
  ].filter(Boolean);

  if (askQuestionHint) {
    rules.push(
      "8. Чат немного затих — можно в конце задать один короткий живой вопрос по теме."
    );
  }

  if (deepThink) {
    rules.push(
      "",
      "Верни ответ строго в JSON-формате:",
      '{"thought": "кратко (до 12 слов): о чём реплика и как ответить по-простому", "reply": "короткий живой ответ в чат на русском (4–14 слов, обязательно непустой)", "memory_fact": "почти всегда \\"\\" (пиши факт только если впервые назвал что-то важное о себе)"}'
    );
  } else {
    rules.push("8. Выведи только короткий текст ответа в чат на русском языке.");
  }

  return rules.join("\n");
}

function buildAlternatingTurns(messages, triggerMessage) {
  const list = Array.isArray(messages) ? messages : [];
  const triggerId = triggerMessage && triggerMessage.id ? String(triggerMessage.id) : "";

  const seen = new Set();
  const historyItems = [];
  for (const m of list) {
    const id = String((m && m.id) || "");
    if (triggerId && id === triggerId) continue;
    if (id && seen.has(id)) continue;
    if (id) seen.add(id);
    historyItems.push(m);
  }

  // Merge consecutive history turns so all providers get clean alternating user/assistant turns.
  const turns = [];
  for (const m of historyItems) {
    const role = m.role === "own_ai" ? "assistant" : "user";
    const line = role === "assistant" ? String(m.text || "").trim() : `${m.author}: ${m.text}`;
    if (!line) continue;

    if (turns.length > 0 && turns[turns.length - 1].role === role) {
      turns[turns.length - 1].content += `\n${line}`;
    } else {
      turns.push({ role, content: line });
    }
  }

  while (turns.length > 0 && turns[0].role === "assistant") {
    turns.shift();
  }

  // Always end with a separate, explicit final user turn for the trigger message.
  if (triggerMessage) {
    const tAuthor = String(triggerMessage.author || "").trim();
    const tText = String(triggerMessage.text || "").trim();
    turns.push({
      role: "user",
      content: (tAuthor || tText)
        ? `Ответь на это сообщение — ${tAuthor}: ${tText}`
        : "Чат немного затих — коротко и естественно поддержи беседу по контексту выше, не повторяя старые ответы."
    });
  }
  return turns;
}

function sanitizeMemoryFact(fact, personaPrompt = "") {
  const cleaned = String(fact || "").replace(/\s+/g, " ").trim();
  if (!cleaned || isChatCommand(cleaned) || looksLikeRawJson(cleaned)) return "";
  if (cleaned.includes("}") || cleaned.includes("**") || /\b(PM|AM|uptime)\b/i.test(cleaned)) return "";
  const basePersona = (String(personaPrompt || "").trim() || DEFAULT_PERSONA_PROMPT).toLowerCase();
  if (basePersona.includes(cleaned.toLowerCase())) return "";
  return cleaned.slice(0, 120);
}

function extractStructuredOutput(rawText, deepThink) {
  const raw = String(rawText || "").trim();
  if (!raw) return { reply: "", memoryFact: "" };

  if (deepThink) {
    const cleanedJson = raw.replace(/^```json\s*/i, "").replace(/```\s*$/, "").trim();
    const tryParse = (str) => {
      const parsed = JSON.parse(str);
      if (!parsed || typeof parsed !== "object") return null;
      if (parsed.for_another_person === true || String(parsed.addressed_to || "").trim().toLowerCase() === "other") {
        return { reply: "", memoryFact: "" };
      }
      if (typeof parsed.reply === "string") {
        return {
          reply: parsed.reply.trim(),
          memoryFact: sanitizeMemoryFact(parsed.memory_fact, "")
        };
      }
      return null;
    };

    try {
      const res = tryParse(cleanedJson);
      if (res !== null) return res;
    } catch (_err) {
      const jsonMatch = cleanedJson.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try {
          const res = tryParse(jsonMatch[0]);
          if (res !== null) return res;
        } catch (_e2) {
          return { reply: "", memoryFact: "" };
        }
      }
    }
    if (looksLikeRawJson(raw)) {
      return { reply: "", memoryFact: "" };
    }
  }

  if (looksLikeRawJson(raw)) {
    return { reply: "", memoryFact: "" };
  }

  return {
    reply: raw
      .replace(/^["«]|["»]$/g, "")
      .replace(/\bNO_REPLY\b/gi, "")
      .trim(),
    memoryFact: ""
  };
}

function extractReplyFromOutput(rawText, deepThink) {
  return extractStructuredOutput(rawText, deepThink).reply;
}

function formatReplyText(text, useAiPrefix) {
  let cleaned = String(text || "")
    .replace(/\bNO_REPLY\b/gi, "")
    .replace(/[\u4e00-\u9fff]+.*$/g, "")
    .replace(/[«»„“”]/g, "")
    .replace(/\s*[—–]\s*/g, ", ")
    .replace(/\u2011/g, "-")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.endsWith(".") && !cleaned.endsWith("...") && cleaned.length < 180) {
    cleaned = cleaned.slice(0, -1).trim();
  }
  if (!cleaned || looksLikeRawJson(cleaned) || isChatCommand(cleaned)) {
    return "NO_REPLY";
  }
  if (useAiPrefix) {
    cleaned = cleaned.startsWith("[AI]") ? cleaned : `[AI] ${cleaned}`;
  } else {
    cleaned = cleaned.replace(/^\[AI\]\s*/i, "");
  }
  if (isChatCommand(cleaned)) {
    return "NO_REPLY";
  }
  return cleaned.slice(0, 240);
}

function collectOtherAuthors(messages, botLogin) {
  const botNorm = String(botLogin || "").trim().toLowerCase();
  const seen = new Set();
  for (const m of (Array.isArray(messages) ? messages : [])) {
    if (!m || m.role === "own_ai") continue;
    const a = String(m.author || "").trim();
    if (!a || (botNorm && a.toLowerCase() === botNorm)) continue;
    seen.add(a);
  }
  return Array.from(seen).slice(0, 10);
}

async function generateWithStub(messages, triggerMessage, useAiPrefix) {
  const txt = String((triggerMessage && triggerMessage.text) || "").trim();
  if (!txt) {
    return {
      text: "NO_REPLY",
      model: "stub-local",
      isStub: true,
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }
    };
  }
  const raw = txt.includes("?")
    ? `(заглушка) Вижу вопрос от ${triggerMessage.author}, в контексте ${messages.length} сообщ.`
    : `(заглушка) Принял сообщение от ${triggerMessage.author} (${messages.length} сообщ. в окне).`;

  const formatted = formatReplyText(raw, useAiPrefix);
  const promptTokens = messages.reduce((acc, m) => acc + String(m.text || "").split(/\s+/).length, 10);
  const completionTokens = formatted.split(/\s+/).length;
  return {
    text: formatted,
    model: "stub-local",
    isStub: true,
    usage: {
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens
    }
  };
}

async function generateWithOllama(endpointUrl, model, personaPrompt, messages, triggerMessage, useAiPrefix, deepThink, askQuestionHint = false, botLogin = "", characterMemory = [], channel = "") {
  const base = String(endpointUrl || DEFAULT_OLLAMA_URL).trim().replace(/\/+$/, "");
  const chosenModel = String(model || DEFAULT_OLLAMA_MODEL).trim() || DEFAULT_OLLAMA_MODEL;
  const url = `${base}/api/chat`;

  const otherAuthors = collectOtherAuthors(messages, botLogin);
  const chatTurns = buildAlternatingTurns(messages, triggerMessage);
  const ollamaMessages = [
    { role: "system", content: buildSystemPrompt(personaPrompt, useAiPrefix, deepThink, askQuestionHint, botLogin, otherAuthors, characterMemory, channel) },
    ...chatTurns
  ];

  const isThinkingModel = /qwen3|deepseek-r1|qwq|gpt-oss/i.test(chosenModel);
  const buildPayload = (thinkValue) => {
    const p = {
      model: chosenModel,
      stream: false,
      messages: ollamaMessages,
      options: {
        temperature: 0.65,
        top_p: 0.88,
        repeat_penalty: 1.05,
        num_ctx: 4096,
        num_predict: deepThink ? 420 : 180
      }
    };
    if (thinkValue !== undefined) {
      p.think = thinkValue;
    }
    if (deepThink) {
      p.format = {
        type: "object",
        properties: {
          thought: { type: "string" },
          reply: { type: "string" },
          memory_fact: { type: "string" }
        },
        required: ["thought", "reply", "memory_fact"]
      };
    }
    return p;
  };

  const fetchWithTimeout = async (payloadObj) => {
    const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), 90000) : null;
    try {
      return await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payloadObj),
        signal: controller ? controller.signal : undefined
      });
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  let response;
  try {
    response = await fetchWithTimeout(buildPayload(isThinkingModel ? false : undefined));
  } catch (err) {
    if (err && err.name === "AbortError") {
      throw new Error(
        `Ollama (${chosenModel}) не ответила за 90 сек. Попробуйте модель полегче (например qwen3.5:9b или qwen2.5:7b).`
      );
    }
    throw new Error(
      `Не удалось подключиться к локальной Ollama (${base}). Убедитесь, что Ollama запущена и модель '${chosenModel}' скачана.`
    );
  }

  let data = {};
  try {
    data = await response.json();
  } catch (_err) {
    data = {};
  }

  if (!response.ok && isThinkingModel && response.status === 400) {
    const fallbackThink = /gpt-oss/i.test(chosenModel) ? "low" : undefined;
    try {
      response = await fetchWithTimeout(buildPayload(fallbackThink));
      data = await response.json().catch(() => ({}));
    } catch (_err) {
      // fall through to standard error handling below
    }
  }

  if (!response.ok) {
    if (response.status === 403) {
      throw new Error(
        "Ollama отклонила запрос от расширения (403). Разрешите CORS для расширений: выполните в PowerShell setx OLLAMA_ORIGINS \"*\" и перезапустите Ollama."
      );
    }
    const errText = (data && data.error) || `HTTP ${response.status}`;
    if (deepThink && response.status === 500 && errText.includes("repeat limit")) {
      return generateWithOllama(endpointUrl, model, personaPrompt, messages, triggerMessage, useAiPrefix, false, askQuestionHint, botLogin, characterMemory, channel);
    }
    throw new Error(`Ошибка Ollama (${response.status}): ${errText}`);
  }

  const rawText = (data && data.message && data.message.content) || "";
  const structured = extractStructuredOutput(rawText, deepThink);
  const formatted = formatReplyText(structured.reply, useAiPrefix);
  if (deepThink && formatted === "NO_REPLY") {
    return generateWithOllama(endpointUrl, model, personaPrompt, messages, triggerMessage, useAiPrefix, false, askQuestionHint, botLogin, characterMemory, channel);
  }
  const cleanFact = formatted === "NO_REPLY" ? "" : sanitizeMemoryFact(structured.memoryFact, personaPrompt);
  const promptTokens = Number(data.prompt_eval_count || 0);
  const completionTokens = Number(data.eval_count || 0);
  return {
    text: formatted,
    memoryFact: cleanFact,
    model: `ollama:${chosenModel}`,
    isStub: false,
    usage: {
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens
    }
  };
}

async function generateWithOpenAICompat(endpointUrl, apiKey, model, personaPrompt, messages, triggerMessage, useAiPrefix, deepThink = true, askQuestionHint = false, botLogin = "", characterMemory = [], channel = "") {
  const base = String(endpointUrl || "http://127.0.0.1:1234/v1").trim().replace(/\/+$/, "");
  const chosenModel = String(model || "local-model").trim() || "local-model";
  const url = base.endsWith("/chat/completions") ? base : `${base}/chat/completions`;

  const headers = { "Content-Type": "application/json" };
  if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }

  const otherAuthors = collectOtherAuthors(messages, botLogin);
  const chatTurns = buildAlternatingTurns(messages, triggerMessage);
  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: chosenModel,
        temperature: 0.75,
        max_tokens: deepThink ? 420 : 140,
        messages: [
          { role: "system", content: buildSystemPrompt(personaPrompt, useAiPrefix, deepThink, askQuestionHint, botLogin, otherAuthors, characterMemory, channel) },
          ...chatTurns
        ]
      })
    });
  } catch (err) {
    throw new Error(`Ошибка подключения к OpenAI-совместимому API (${base}): ${err && err.message ? err.message : String(err)}`);
  }

  let data = {};
  try {
    data = await response.json();
  } catch (_err) {
    data = {};
  }

  if (!response.ok) {
    const errText = (data && data.error && data.error.message) || `HTTP ${response.status}`;
    throw new Error(`Ошибка API (${response.status}): ${errText}`);
  }

  const choice = data && Array.isArray(data.choices) ? data.choices[0] : null;
  const rawText = (choice && choice.message && choice.message.content) || "";
  const structured = extractStructuredOutput(rawText, deepThink);
  const formatted = formatReplyText(structured.reply, useAiPrefix);
  const usage = data.usage || {};
  return {
    text: formatted,
    memoryFact: formatted === "NO_REPLY" ? "" : structured.memoryFact,
    model: chosenModel,
    isStub: false,
    usage: {
      promptTokens: Number(usage.prompt_tokens || 0),
      completionTokens: Number(usage.completion_tokens || 0),
      totalTokens: Number(usage.total_tokens || 0)
    }
  };
}

async function generateWithGemini(apiKey, model, personaPrompt, messages, triggerMessage, useAiPrefix, deepThink = true, askQuestionHint = false, botLogin = "", characterMemory = [], channel = "") {
  const chosenModel = String(model || DEFAULT_GEMINI_MODEL).trim() || DEFAULT_GEMINI_MODEL;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(chosenModel)}:generateContent`;

  const otherAuthors = collectOtherAuthors(messages, botLogin);
  const turns = buildAlternatingTurns(messages, triggerMessage);
  const contents = turns.map((t) => ({
    role: t.role === "assistant" ? "model" : "user",
    parts: [{ text: t.content }]
  }));

  const body = {
    systemInstruction: {
      parts: [{ text: buildSystemPrompt(personaPrompt, useAiPrefix, deepThink, askQuestionHint, botLogin, otherAuthors, characterMemory, channel) }]
    },
    contents,
    generationConfig: {
      temperature: 0.75,
      maxOutputTokens: deepThink ? 420 : 140
    }
  };
  if (deepThink) {
    body.generationConfig.responseMimeType = "application/json";
  }

  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey
      },
      body: JSON.stringify(body)
    });
  } catch (err) {
    throw new Error(`Сетевая ошибка Gemini API: ${err && err.message ? err.message : String(err)}`);
  }

  let data = {};
  try {
    data = await response.json();
  } catch (_err) {
    data = {};
  }

  if (!response.ok) {
    const apiMsg = (data && data.error && data.error.message) || `HTTP ${response.status}`;
    if (response.status === 401 || response.status === 403) {
      throw new Error(`Ошибка авторизации Gemini (${response.status}): проверьте API-ключ.`);
    }
    if (response.status === 429) {
      throw new Error(`Превышен лимит бесплатного тарифа Gemini (429). Переключитесь на Ollama (локально без лимитов).`);
    }
    if (response.status === 503) {
      throw new Error(`Модель '${chosenModel}' временно перегружена (503).`);
    }
    if (response.status === 404) {
      throw new Error(`Модель '${chosenModel}' недоступна (404): ${apiMsg}`);
    }
    throw new Error(`Ошибка Gemini API (${response.status}): ${apiMsg}`);
  }

  const candidate = data && Array.isArray(data.candidates) ? data.candidates[0] : null;
  const parts = candidate && candidate.content && Array.isArray(candidate.content.parts)
    ? candidate.content.parts
    : [];
  const rawText = parts.map((p) => p.text || "").join(" ").trim();
  const structured = extractStructuredOutput(rawText, deepThink);
  const formatted = formatReplyText(structured.reply, useAiPrefix);

  const meta = data.usageMetadata || {};
  return {
    text: formatted,
    memoryFact: formatted === "NO_REPLY" ? "" : structured.memoryFact,
    model: chosenModel,
    isStub: false,
    usage: {
      promptTokens: Number(meta.promptTokenCount || 0),
      completionTokens: Number(meta.candidatesTokenCount || 0),
      totalTokens: Number(meta.totalTokenCount || 0)
    }
  };
}

async function generatePreviewReply({
  provider,
  apiKey,
  endpointUrl,
  model,
  personaPrompt,
  messages,
  triggerMessage,
  useAiPrefix,
  deepThink = true,
  askQuestionHint = false,
  botLogin = "",
  characterMemory = [],
  channel = ""
}) {
  const chosenProvider = String(provider || "ollama").trim();

  if (chosenProvider === "stub") {
    return generateWithStub(messages, triggerMessage, useAiPrefix);
  }
  if (chosenProvider === "ollama") {
    return generateWithOllama(endpointUrl, model, personaPrompt, messages, triggerMessage, useAiPrefix, deepThink, askQuestionHint, botLogin, characterMemory, channel);
  }
  if (chosenProvider === "openai_compat") {
    return generateWithOpenAICompat(endpointUrl, apiKey, model, personaPrompt, messages, triggerMessage, useAiPrefix, deepThink, askQuestionHint, botLogin, characterMemory, channel);
  }

  const cleanKey = String(apiKey || "").trim();
  if (!cleanKey) {
    return generateWithStub(messages, triggerMessage, useAiPrefix);
  }
  try {
    return await generateWithGemini(cleanKey, model, personaPrompt, messages, triggerMessage, useAiPrefix, deepThink, askQuestionHint, botLogin, characterMemory, channel);
  } catch (err) {
    const msg = err && err.message ? err.message : "";
    const chosen = String(model || DEFAULT_GEMINI_MODEL).trim();
    if ((msg.includes("(503)") || msg.includes("(404)")) && chosen !== "gemini-3.5-flash-lite") {
      return generateWithGemini(cleanKey, "gemini-3.5-flash-lite", personaPrompt, messages, triggerMessage, useAiPrefix, deepThink, askQuestionHint, botLogin, characterMemory, channel);
    }
    throw err;
  }
}
