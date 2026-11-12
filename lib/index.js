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
let nextRequestId = 0;
let nextFlowId = 0;

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
  const kept = list.filter((message) => message?.role === "assistant"
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
    .filter((message) => message.role && message.content.length > 0)
    .slice(-MAX_CONTEXT_MESSAGES);

  let total = 0;
  const result = [];
  for (let i = kept.length - 1; i >= 0; i -= 1) {
    const message = kept[i];
    const text = textOfContent(message.content);
    const size = text.length;
    if (total + size > MAX_CONTEXT_CHARS) {
      if (result.length === 0) {
        result.unshift({ ...message, content: [{ type: "text", text: text.slice(-MAX_CONTEXT_CHARS) }] });
      }
      break;
    }
    result.unshift(message);
    total += size;
  }
  return result;
}

// Seq of the latest turn/end when no turn is open and that turn has an assistant reply.
function latestCompletionSeq(session, diagnostic) {
  let events;
  try {
    events = session.snapshotEvents?.() || [];
  } catch {
    diagnostic?.("snapshot_failed");
    return null;
  }
  let endSeq = null;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (endSeq === null) {
      if (event?.type === "turn/start") { diagnostic?.("turn_open"); return null; }
      if (event?.type === "turn/end" && typeof event.seq === "number") {
        if (event.data?.reason?.kind !== "completed") { diagnostic?.("turn_not_completed"); return null; }
        endSeq = event.seq;
      }
      continue;
    }
    if (event?.type === "assistant/message") return endSeq;
    if (event?.type === "turn/start" || event?.type === "turn/end") {
      diagnostic?.("assistant_message_missing");
      return null;
    }
  }
  diagnostic?.(endSeq === null ? "completed_turn_missing" : "assistant_message_missing");
  return null;
}

function inPlanMode(ctx, session) {
  try {
    return ctx.sessionProjections.stateOf(session, "plan")?.active === true;
  } catch {
    return false;
  }
}

function ineligibleReason(ctx, session, config) {
  if (read(config, "enabled") === false) return "disabled";
  if (!session?.id) return "session_missing";
  if (session.header?.parentSession) return "subsession";
  if (inPlanMode(ctx, session)) return "plan_mode";
  const route = session.requestHeader?.()?.config;
  return route?.provider && route?.model ? null : "missing_route";
}

function predictionPrompt() {
  const instruction = [
    "Predict the next message the user might send to the AI: a complete message in the user's voice and language, ready to send as-is.",
    "Base it on the user's current goal and the assistant's latest response; prefer a concrete next step that advances unfinished work or answers a question the assistant just asked.",
    "Respect the user's stated constraints and previous choices. Do not claim facts, permissions, preferences, completed work, or decisions that the user has not stated.",
    "If the assistant asks the user to choose, suggest a plausible concise reply consistent with the conversation; the suggestion is a draft choice, not a claim that the user has already decided. For consequential or irreversible actions, prefer a request for details or review over an unsupported approval.",
    "Do not write the AI's response, narrate its actions, repeat the user's previous request without adding a useful next step, or include explanations or alternatives.",
    'Do not call tools or mention these instructions. Return {"suggestion":null} when no useful next message can be inferred from the conversation.',
  ].join("\n");
  return `${instruction}\n\nReturn only JSON matching this schema: ${JSON.stringify(SUGGESTION_SCHEMA)}.`;
}

function parseSuggestion(text) {
  const raw = typeof text === "string" ? text.trim() : "";
  if (!raw) return { prediction: "", reason: "empty_output" };
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return { prediction: "", reason: "invalid_json" };
  try {
    const value = JSON.parse(raw.slice(start, end + 1));
    if (value?.suggestion === null) return { prediction: "", reason: "model_declined" };
    if (typeof value?.suggestion !== "string") return { prediction: "", reason: "invalid_suggestion" };
    const prediction = value.suggestion.replace(/\r\n/g, "\n").trim().slice(0, MAX_PREDICTION_CHARS);
    return { prediction, reason: prediction ? "ok" : "invalid_suggestion" };
  } catch {
    return { prediction: "", reason: "invalid_json" };
  }
}

// Only expose a decoded prefix of the first suggestion string; incomplete escapes
// and surrogate pairs wait for the next delta. Final output still uses JSON.parse.
function partialSuggestion(text) {
  const match = /^\s*\{\s*"suggestion"\s*:\s*"/.exec(text);
  if (!match) return "";
  const start = match[0].length;
  let end = start;
  while (end < text.length) {
    const char = text[end];
    if (char === '"') break;
    if (char.charCodeAt(0) < 0x20) return "";
    if (char === "\\") {
      if (end + 1 >= text.length) break;
      const escape = text[end + 1];
      if (escape === "u") {
        const digits = text.slice(end + 2, end + 6);
        if (!/^[0-9a-fA-F]*$/.test(digits)) return "";
        if (digits.length < 4) break;
        end += 6;
        continue;
      }
      if (!'"\\/bfnrt'.includes(escape)) return "";
      end += 2;
      continue;
    }
    end += 1;
  }
  const decoded = JSON.parse(`"${text.slice(start, end)}"`);
  const prefix = decoded.replace(/\r\n/g, "\n").trim().slice(0, MAX_PREDICTION_CHARS);
  return /[\uD800-\uDBFF]$/.test(prefix) ? prefix.slice(0, -1) : prefix;
}

async function offers(ctx, provider, model) {
  const models = await ctx.llm.listModels(provider).catch(() => []);
  return models.some((item) => item?.id === model);
}

// Explicit routes are resolved directly: model catalogs are advisory. A model
// without a provider (older configs) prefers the session provider, then the only other provider offering it.
// Anything unresolvable falls back to the session's own route.
async function resolveRoute(ctx, route, config) {
  const sessionRoute = { provider: route.provider, model: route.model };
  const model = readText(config, "predictionModel");
  if (!model) return sessionRoute;
  const provider = readText(config, "predictionProvider");
  if (provider) {
    try {
      await ctx.llm.resolveModelInfo(provider, model);
      return { provider, model };
    } catch {
      ctx.logger?.warn?.("dsh-input-prediction: configured route unavailable; using the session model");
      return sessionRoute;
    }
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

// Same model as the session: replay the session's own request prefix (messages,
// tools, tool history) so the provider's prompt cache covers it, like Codex does.
// Another model has no warm cache, so send only the compact text history.
function requestContext(session, header, sameModel) {
  const messages = session.deriveMessages?.() || [];
  if (!sameModel) {
    const history = compactMessages(messages);
    return history.length > 0 ? { messages: history } : null;
  }
  if (!Array.isArray(messages) || messages.length === 0) return null;
  const toolHistory = session.toolHistory?.();
  return {
    messages,
    ...(Array.isArray(header?.tools) && header.tools.length > 0 ? { tools: header.tools } : {}),
    ...(toolHistory ? { toolHistory } : {}),
  };
}

// Configured effort when the model supports it, otherwise the model's lowest
// advertised effort: a one-line prediction should not spend its budget reasoning.
function chooseEffort(configured, info) {
  const efforts = info?.reasoning?.efforts || [];
  if (configured && efforts.some((item) => item.id === configured)) return configured;
  return efforts[0]?.id;
}

async function generate(ctx, session, config, signal, entry) {
  const requestId = entry.requestId;
  entry.stage = "context";
  const header = session.requestHeader?.();
  const route = header?.config;
  if (!route?.provider || !route?.model) return { prediction: "", reason: "missing_route" };

  entry.stage = "route";
  const routeStartedAt = performance.now();
  let provider, model;
  try {
    ({ provider, model } = await resolveRoute(ctx, route, config));
  } finally {
    ctx.logger?.info?.(`dsh-input-prediction: event=route_timing request=${requestId} elapsedMs=${Math.round(performance.now() - routeStartedAt)}`);
  }
  signal.throwIfAborted();
  const sameModel = provider === route.provider && model === route.model;
  const contextStartedAt = performance.now();
  let context;
  try {
    context = requestContext(session, header, sameModel);
  } finally {
    ctx.logger?.info?.(`dsh-input-prediction: event=context_timing request=${requestId} elapsedMs=${Math.round(performance.now() - contextStartedAt)}`);
  }
  if (!context) return { prediction: "", reason: "no_context" };
  const configuredEffort = readText(config, "reasoningEffort");
  const maxTokens = readPositive(config, "maxTokens", DEFAULT_MAX_TOKENS);
  ctx.logger?.info?.(`dsh-input-prediction: event=request_prepare request=${requestId} provider=${provider} model=${model} sameModel=${sameModel} messages=${context.messages.length} maxTokens=${maxTokens}`);

  entry.stage = "prepare";
  const prepareStartedAt = performance.now();
  let call;
  try {
    call = await ctx.llm.prepareCall(
      { provider, model, maxTokens },
      signal,
      (controls, info) => {
        const effort = chooseEffort(configuredEffort, info);
        return effort ? { ...controls, reasoningEffort: effort } : controls;
      },
    );
  } finally {
    ctx.logger?.info?.(`dsh-input-prediction: event=prepare_timing request=${requestId} elapsedMs=${Math.round(performance.now() - prepareStartedAt)}`);
  }
  signal.throwIfAborted();
  ctx.logger?.info?.(`dsh-input-prediction: event=request_stream request=${requestId} reasoningEffort=${call.config.reasoningEffort ?? "default"}`);

  entry.stage = "stream";
  let text = "";
  let hitMaxTokens = false;
  let reasoningDeltas = 0;
  let reasoningChars = 0;
  let textDeltas = 0;
  let textChars = 0;
  let finishReason = "missing";
  let firstReasoningMs = null;
  let firstTextMs = null;
  let finishMs = null;
  const streamStartedAt = performance.now();
  try {
  for await (const chunk of call.stream({
    ...call.config,
    ...context,
    messages: [
      ...context.messages,
      { role: "user", content: [{ type: "text", text: predictionPrompt() }] },
    ],
    sessionId: session.id,
    signal,
  })) {
    signal.throwIfAborted();
    if (chunk?.type === "text-delta" && typeof chunk.text === "string") {
      if (firstTextMs === null && chunk.text.length > 0) firstTextMs = Math.round(performance.now() - streamStartedAt);
      textDeltas += 1;
      textChars += chunk.text.length;
      text += chunk.text;
      entry.prediction = partialSuggestion(text);
    }
    if (chunk?.type === "reasoning-delta" && typeof chunk.text === "string") {
      if (firstReasoningMs === null && chunk.text.length > 0) firstReasoningMs = Math.round(performance.now() - streamStartedAt);
      reasoningDeltas += 1;
      reasoningChars += chunk.text.length;
    }
    if (chunk?.type === "finish") {
      if (finishMs === null) finishMs = Math.round(performance.now() - streamStartedAt);
      finishReason = ["stop", "tool-calls", "max-tokens", "error", "aborted"].includes(chunk.reason?.kind)
        ? chunk.reason.kind : "other";
    }
    if (chunk?.type === "finish" && (chunk.reason?.kind === "error" || chunk.reason?.kind === "aborted")) {
      ctx.logger?.warn?.("dsh-input-prediction: provider request failed");
      return { prediction: "", reason: "provider_error" };
    }
    if (chunk?.type === "finish" && chunk.reason?.kind === "max-tokens") {
      hitMaxTokens = true;
      ctx.logger?.warn?.(`dsh-input-prediction: reply hit maxTokens (${call.config.maxTokens ?? maxTokens}); raise maxTokens or lower reasoningEffort`);
    }
  }
  } finally {
    ctx.logger?.info?.(`dsh-input-prediction: event=stream_summary request=${requestId} reasoningDeltas=${reasoningDeltas} reasoningChars=${reasoningChars} textDeltas=${textDeltas} textChars=${textChars} finishReason=${finishReason} firstReasoningMs=${firstReasoningMs} firstTextMs=${firstTextMs} finishMs=${finishMs} streamElapsedMs=${Math.round(performance.now() - streamStartedAt)}`);
  }
  const result = parseSuggestion(text);
  ctx.logger?.info?.(`dsh-input-prediction: event=response_parsed request=${requestId} outputChars=${text.length} predictionChars=${result.prediction.length} reason=${result.reason}`);
  return hitMaxTokens ? { ...result, reason: "max_tokens" } : result;
}

function clearSession(ctx, sessionId, reason) {
  const entry = predictions.get(sessionId);
  if (entry?.status === "pending") {
    const elapsedMs = Math.round(performance.now() - entry.startedAt);
    ctx.logger?.info?.(`dsh-input-prediction: event=cancel request=${entry.requestId} flow=${entry.flowId} reason=${reason} elapsedMs=${elapsedMs}`);
  }
  entry?.controller.abort();
  predictions.delete(sessionId);
}

// Start (or reuse) the prediction for the session's latest completed turn.
function ensurePrediction(ctx, session, config, retryEmpty = false) {
  const trigger = retryEmpty ? "focus-idle" : "turn-end";
  let skipReason;
  const completionSeq = latestCompletionSeq(session, (reason) => { skipReason = reason; });
  if (completionSeq === null) {
    ctx.logger?.info?.(`dsh-input-prediction: event=skip trigger=${trigger} reason=${skipReason}`);
    return null;
  }
  skipReason = ineligibleReason(ctx, session, config);
  if (skipReason) {
    ctx.logger?.info?.(`dsh-input-prediction: event=skip trigger=${trigger} completionSeq=${completionSeq} reason=${skipReason}`);
    return null;
  }
  const existing = predictions.get(session.id);
  if (existing?.completionSeq === completionSeq
    && (!retryEmpty || existing.retryAttempted || existing.status !== "ready" || existing.prediction)) {
    if (retryEmpty && existing.retryAttempted && !existing.retrySuppressionLogged) {
      ctx.logger?.info?.(`dsh-input-prediction: event=retry_suppressed request=${existing.requestId} completionSeq=${completionSeq}`);
      existing.retrySuppressionLogged = true;
    }
    return existing;
  }

  clearSession(ctx, session.id, "replaced");
  const entry = {
    completionSeq,
    requestId: ++nextRequestId,
    flowId: existing?.completionSeq === completionSeq ? existing.flowId : ++nextFlowId,
    attempt: existing?.completionSeq === completionSeq ? existing.attempt + 1 : 1,
    startedAt: performance.now(),
    retryAttempted: retryEmpty,
    status: "pending",
    prediction: "",
    controller: new AbortController(),
  };
  predictions.set(session.id, entry);
  while (predictions.size > RETAINED_PREDICTIONS) clearSession(ctx, predictions.keys().next().value, "evicted");

  const timeoutMs = readPositive(config, "timeoutMs", DEFAULT_TIMEOUT_MS);
  ctx.logger?.info?.(`dsh-input-prediction: event=start request=${entry.requestId} flow=${entry.flowId} attempt=${entry.attempt} trigger=${retryEmpty ? "focus-idle" : "turn-end"} completionSeq=${completionSeq} timeoutMs=${timeoutMs}`);
  const signal = AbortSignal.any([entry.controller.signal, AbortSignal.timeout(timeoutMs)]);
  // Race the abort as well, so a provider that ignores the signal cannot leave
  // the entry pending (and the composer polling) forever.
  const aborted = new Promise((_, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
  Promise.race([generate(ctx, session, config, signal, entry), aborted])
    .then((result) => {
      entry.prediction = result.prediction;
      entry.reason = result.reason;
    })
    .catch(() => {
      entry.prediction = "";
      if (entry.controller.signal.aborted) return;
      if (signal.aborted && signal.reason?.name === "TimeoutError") {
        entry.reason = "timeout";
        ctx.logger?.warn?.(`dsh-input-prediction: prediction timed out after ${timeoutMs}ms`);
      } else {
        entry.reason = "provider_error";
        ctx.logger?.warn?.(`dsh-input-prediction: prediction failed request=${entry.requestId} stage=${entry.stage ?? "unknown"}`);
      }
    })
    .finally(() => {
      entry.status = "ready";
      if (!entry.controller.signal.aborted && entry.reason) {
        const elapsedMs = Math.round(performance.now() - entry.startedAt);
        const message = `dsh-input-prediction: result=${entry.reason} trigger=${retryEmpty ? "focus-idle" : "turn-end"} completionSeq=${completionSeq} request=${entry.requestId} flow=${entry.flowId} attempt=${entry.attempt} elapsedMs=${elapsedMs}`;
        if (entry.reason === "ok") ctx.logger?.info?.(message);
        else ctx.logger?.warn?.(message);
      }
    });
  return entry;
}

function status(ctx, request, config) {
  const params = new URL(request.url).searchParams;
  const sessionId = params.get("sessionId") || "";
  let session;
  try {
    session = sessionId ? ctx.sessions.get(sessionId) : undefined;
  } catch {
    session = undefined;
  }
  // Ordinary polling is read-only, so opening or switching to an old session
  // never triggers a model call. Focus-idle is an explicit live fallback.
  if (session && params.get("trigger") === "focus-idle") ensurePrediction(ctx, session, config, true);
  const entry = session && read(config, "enabled") !== false
    ? predictions.get(session.id)
    : undefined;
  if (!entry || entry.completionSeq !== latestCompletionSeq(session)) return json({ status: "none" });
  return json({
    status: entry.status,
    completionSeq: entry.completionSeq,
    prediction: entry.prediction,
    ...(entry.status === "ready" ? { reason: entry.reason } : {}),
  });
}

const diagnosticSchemas = {
  loaded: {},
  poll: { state: ["ok", "http-error", "network-or-response-error"], status: "httpStatus" },
  backend: {
    status: ["none", "pending", "ready", "unknown"],
    reason: [null, "ok", "empty_output", "invalid_json", "model_declined", "invalid_suggestion", "missing_route", "no_context", "provider_error", "max_tokens", "timeout", "other"],
    hasPrediction: "boolean",
  },
  display: Object.fromEntries(["visible", "hasCurrent", "currentSession", "dismissed", "locked", "busy", "empty", "composing", "focused"].map((field) => [field, "boolean"])),
  idle: { state: ["already-retried", "requested", "network-error", "waiting-for-backend", "prediction-present"] },
};

async function diagnostics(ctx, request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid_diagnostic" }, 400);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)
    || Object.keys(body).some((key) => key !== "event" && key !== "detail")
    || typeof body.event !== "string" || !Object.hasOwn(diagnosticSchemas, body.event)
    || !body.detail || typeof body.detail !== "object" || Array.isArray(body.detail)) {
    return json({ error: "invalid_diagnostic" }, 400);
  }
  const schema = diagnosticSchemas[body.event];
  for (const [key, value] of Object.entries(body.detail)) {
    if (!Object.hasOwn(schema, key)) return json({ error: "invalid_diagnostic" }, 400);
    const expected = schema[key];
    if (Array.isArray(expected) ? !expected.includes(value)
      : expected === "boolean" ? typeof value !== "boolean"
        : !Number.isInteger(value) || value < 100 || value > 599) {
      return json({ error: "invalid_diagnostic" }, 400);
    }
  }
  if (Object.keys(schema).some((key) => !(body.event === "poll" && key === "status") && !Object.hasOwn(body.detail, key))) {
    return json({ error: "invalid_diagnostic" }, 400);
  }
  ctx.logger?.info?.(`dsh-input-prediction: event=client_${body.event} detail=${JSON.stringify(body.detail)}`);
  return json({ ok: true });
}

export function apply(ctx, config = {}) {
  const pendingTimers = new Map();
  ctx.logger?.info?.(`dsh-input-prediction: event=loaded enabled=${read(config, "enabled") !== false}`);
  ctx.on?.("session/event", (session, event) => {
    if (event?.type === "turn/end") {
      ctx.logger?.info?.(`dsh-input-prediction: event=turn_end hasSession=${Boolean(session?.id)} reason=${event.data?.reason?.kind ?? "unknown"}`);
    }
    if (!session?.id) return;
    if (event?.type === "turn/start") {
      clearTimeout(pendingTimers.get(session.id));
      pendingTimers.delete(session.id);
      clearSession(ctx, session.id, "turn_start");
    }
    // Live: generate as soon as the turn ends, even before the composer asks.
    if (event?.type === "turn/end" && event.data?.reason?.kind === "completed") {
      clearTimeout(pendingTimers.get(session.id));
      pendingTimers.set(session.id, setTimeout(() => {
        pendingTimers.delete(session.id);
        ensurePrediction(ctx, session, config);
      }, 0));
    }
  });
  ctx.on?.("session/disposed", (session) => {
    if (session?.id) {
      const scheduled = pendingTimers.has(session.id);
      const entry = predictions.get(session.id);
      if (scheduled || entry) {
        ctx.logger?.info?.(`dsh-input-prediction: event=disposed scheduled=${scheduled} state=${entry?.status ?? "none"}${entry ? ` request=${entry.requestId} flow=${entry.flowId}` : ""}`);
      }
      clearTimeout(pendingTimers.get(session.id));
      pendingTimers.delete(session.id);
      clearSession(ctx, session.id, "disposed");
    }
  });

  ctx.connection.fetch.register({
    path: `${PREDICTION_PATH}/diagnostics`,
    methods: ["POST"],
    requestBody: "buffered",
    fetch: (request) => diagnostics(ctx, request),
  });
  ctx.connection.fetch.register({
    path: PREDICTION_PATH,
    methods: ["GET"],
    requestBody: "buffered",
    fetch: (request) => status(ctx, request, config),
  });
}
