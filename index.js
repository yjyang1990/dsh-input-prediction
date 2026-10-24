import z from "@deepseek-ai/schemastery";

const PREDICTION_PATH = "/api/dsh-input-prediction";
const DEFAULT_MAX_TOKENS = 160;
const DEFAULT_TIMEOUT_MS = 30000;
const MAX_PREDICTION_CHARS = 1200;
const MAX_CONTEXT_MESSAGES = 80;
const MAX_CONTEXT_CHARS = 100000;
const RETAINED_PREDICTIONS = 128;
// Harness also logs rules, skills, time and runtime context as user/message; only
// real user input and compaction summaries describe what the user wants.
const USER_CONTEXT_SOURCES = new Set(["user", "compact-checkpoint"]);
const SUGGESTION_SCHEMA = {
  type: "object",
  properties: { suggestion: { type: ["string", "null"] } },
  required: ["suggestion"],
  additionalProperties: false,
};

export const inject = ["connection", "llm", "sessions", "sessionProjections"];

// Volatile fields are editable from the plugin page and apply without a restart.
export const Config = z.object({
  enabled: z.boolean().default(true).volatile(),
  predictionProvider: z.string().default("").volatile(),
  predictionModel: z.string().default("").volatile(),
  reasoningEffort: z.string().default("").volatile(),
  maxTokens: z.natural().min(1).default(DEFAULT_MAX_TOKENS).volatile(),
  timeoutMs: z.natural().min(1).default(DEFAULT_TIMEOUT_MS).volatile(),
});

// Read a config field whether it is a volatile reference or a plain value.
function read(config, key) {
  const value = config?.[key];
  return value && typeof value === "object" && typeof value.get === "function"
    ? value.get()
    : value;
}

function readText(config, key) {
  const value = read(config, key);
  return typeof value === "string" ? value.trim() : "";
}

function readPositive(config, key, fallback) {
  const value = read(config, key);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

// One entry per session: the prediction for its latest completed turn.
const predictions = new Map();

function json(value, status = 200) {
  return Response.json(value, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

function textOfContent(content) {
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
}

function compactMessages(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const kept = list.slice(-MAX_CONTEXT_MESSAGES)
    .filter((message) => message?.role === "assistant"
      || (message?.role === "user" && USER_CONTEXT_SOURCES.has(message.source?.kind ?? "user")))
    .map((message) => ({
      role: message?.role,
      content: Array.isArray(message?.content)
        ? message.content
            .filter((block) => block?.type === "text" && typeof block.text === "string")
            .map((block) => ({ type: "text", text: block.text }))
        : [],
      ...(message?.role === "assistant" && message?.source
        ? { source: message.source }
        : {}),
    }))
    .filter((message) => message.role && message.content.length > 0);

  let total = 0;
  const result = [];
  for (let i = kept.length - 1; i >= 0; i -= 1) {
    const message = kept[i];
    const size = textOfContent(message.content).length;
    if (result.length > 0 && total + size > MAX_CONTEXT_CHARS) break;
    result.unshift(message);
    total += size;
  }
  return result;
}

// Seq of the latest turn/end when no turn is open and that turn has an assistant reply.
function latestCompletionSeq(session) {
  let events;
  try {
    events = session.snapshotEvents?.() || [];
  } catch {
    return null;
  }
  let endSeq = null;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (endSeq === null) {
      if (event?.type === "turn/start") return null;
      if (event?.type === "turn/end" && typeof event.seq === "number") {
        // Interrupted or failed turns have no settled reply to follow up on.
        if (event.data?.reason?.kind !== "completed") return null;
        endSeq = event.seq;
      }
      continue;
    }
    if (event?.type === "assistant/message") return endSeq;
    if (event?.type === "turn/start" || event?.type === "turn/end") return null;
  }
  return null;
}

function inPlanMode(ctx, session) {
  try {
    return ctx.sessionProjections.stateOf(session, "plan")?.active === true;
  } catch {
    return false;
  }
}

function eligible(ctx, session, config) {
  if (read(config, "enabled") === false || !session?.id) return false;
  // Codex skips side conversations; subagent sessions are the DSH equivalent.
  if (session.header?.parentSession) return false;
  if (inPlanMode(ctx, session)) return false;
  const route = session.requestHeader?.()?.config;
  return Boolean(route?.provider && route?.model);
}

function predictionPrompt() {
  const instruction = [
    "Predict the next message the user is most likely to send in this conversation.",
    "Write it as the complete message, in the user's voice and language, ready to send as-is.",
    "Prefer a concrete follow-up, correction, confirmation, or request that naturally continues the conversation.",
    "Do not answer for the assistant, explain the prediction, or mention these instructions.",
    "Use null when there is no clear, useful next message.",
  ].join("\n");
  return `${instruction}\n\nReturn only JSON matching this schema: ${JSON.stringify(SUGGESTION_SCHEMA)}.`;
}

function parseSuggestion(text) {
  const raw = typeof text === "string" ? text.trim() : "";
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return "";
  try {
    const suggestion = JSON.parse(raw.slice(start, end + 1))?.suggestion;
    if (typeof suggestion !== "string") return "";
    return suggestion.replace(/\r\n/g, "\n").trim().slice(0, MAX_PREDICTION_CHARS);
  } catch {
    return "";
  }
}

async function offers(ctx, provider, model) {
  const models = await ctx.llm.listModels(provider).catch(() => []);
  return models.some((item) => item?.id === model);
}

// Explicit provider+model wins when routable. A model without a provider (older
// configs) prefers the session provider, then the only other provider offering it.
// Anything unresolvable falls back to the session's own route.
async function resolveRoute(ctx, route, config) {
  const sessionRoute = { provider: route.provider, model: route.model };
  const model = readText(config, "predictionModel");
  if (!model) return sessionRoute;
  const provider = readText(config, "predictionProvider");
  if (provider) {
    if (await offers(ctx, provider, model)) return { provider, model };
    ctx.logger?.warn?.(`dsh-input-prediction: ${provider}/${model} is unavailable; using the session model`);
    return sessionRoute;
  }
  if (await offers(ctx, route.provider, model)) return { provider: route.provider, model };
  const others = (ctx.llm.listProviders?.() || [])
    .map((item) => item?.id)
    .filter((id) => typeof id === "string" && id !== route.provider);
  const matches = [];
  for (const id of others) if (await offers(ctx, id, model)) matches.push(id);
  if (matches.length === 1) return { provider: matches[0], model };
  return sessionRoute;
}

async function generate(ctx, session, config, signal) {
  const route = session.requestHeader?.()?.config;
  if (!route?.provider || !route?.model) return "";
  const history = compactMessages(session.deriveMessages?.() || []);
  if (history.length === 0) return "";

  const { provider, model } = await resolveRoute(ctx, route, config);
  signal.throwIfAborted();
  const configuredEffort = readText(config, "reasoningEffort");
  const sameModel = provider === route.provider && model === route.model;
  // Like Codex: configured prediction effort first, otherwise the thread's own effort.
  const effort = configuredEffort || (sameModel ? route.reasoningEffort : undefined);
  const maxTokens = readPositive(config, "maxTokens", DEFAULT_MAX_TOKENS);

  const call = await ctx.llm.prepareCall(
    { provider, model, maxTokens },
    signal,
    (controls, info) => effort && info?.reasoning?.efforts?.some((item) => item.id === effort)
      ? { ...controls, reasoningEffort: effort }
      : controls,
  );
  signal.throwIfAborted();

  let text = "";
  for await (const chunk of call.stream({
    ...call.config,
    messages: [
      ...history,
      { role: "user", content: [{ type: "text", text: predictionPrompt() }] },
    ],
    sessionId: session.id,
    signal,
  })) {
    signal.throwIfAborted();
    if (chunk?.type === "text-delta" && typeof chunk.text === "string") text += chunk.text;
    if (chunk?.type === "finish" && chunk.reason?.kind === "error") {
      ctx.logger?.warn?.("dsh-input-prediction: provider request failed", chunk.reason.failure);
      return "";
    }
  }
  return parseSuggestion(text);
}

function clearSession(sessionId) {
  predictions.get(sessionId)?.controller.abort();
  predictions.delete(sessionId);
}

// Start (or reuse) the prediction for the session's latest completed turn.
function ensurePrediction(ctx, session, config) {
  const completionSeq = latestCompletionSeq(session);
  if (completionSeq === null || !eligible(ctx, session, config)) return null;
  const existing = predictions.get(session.id);
  if (existing?.completionSeq === completionSeq) return existing;

  clearSession(session.id);
  const entry = {
    completionSeq,
    status: "pending",
    prediction: "",
    controller: new AbortController(),
  };
  predictions.set(session.id, entry);
  while (predictions.size > RETAINED_PREDICTIONS) clearSession(predictions.keys().next().value);

  const timeoutMs = readPositive(config, "timeoutMs", DEFAULT_TIMEOUT_MS);
  const signal = AbortSignal.any([entry.controller.signal, AbortSignal.timeout(timeoutMs)]);
  // Race the abort as well, so a provider that ignores the signal cannot leave
  // the entry pending (and the composer polling) forever.
  const aborted = new Promise((_, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
  Promise.race([generate(ctx, session, config, signal), aborted])
    .then((prediction) => {
      entry.prediction = prediction;
    })
    .catch((error) => {
      if (entry.controller.signal.aborted) return;
      if (error?.name === "TimeoutError") {
        ctx.logger?.warn?.(`dsh-input-prediction: prediction timed out after ${timeoutMs}ms`);
      } else {
        ctx.logger?.warn?.("dsh-input-prediction: prediction failed", error);
      }
    })
    .finally(() => {
      entry.status = "ready";
    });
  return entry;
}

function status(ctx, request, config) {
  const sessionId = new URL(request.url).searchParams.get("sessionId") || "";
  let session;
  try {
    session = sessionId ? ctx.sessions.get(sessionId) : undefined;
  } catch {
    session = undefined;
  }
  // Catch-up: a composer opened on a session whose latest turn already finished.
  const entry = session ? ensurePrediction(ctx, session, config) : null;
  if (!entry) return json({ status: "none" });
  return json({
    status: entry.status,
    completionSeq: entry.completionSeq,
    prediction: entry.status === "ready" ? entry.prediction : "",
  });
}

export function apply(ctx, config = {}) {
  ctx.on?.("session/event", (session, event) => {
    if (!session?.id) return;
    if (event?.type === "turn/start") clearSession(session.id);
    // Live: generate as soon as the turn ends, even before the composer asks.
    if (event?.type === "turn/end" && event.data?.reason?.kind === "completed") {
      setTimeout(() => ensurePrediction(ctx, session, config), 0);
    }
  });
  ctx.on?.("session/removed", (session) => {
    if (session?.id) clearSession(session.id);
  });

  ctx.connection.fetch.register({
    path: PREDICTION_PATH,
    methods: ["GET"],
    requestBody: "buffered",
    fetch: (request) => status(ctx, request, config),
  });
}
