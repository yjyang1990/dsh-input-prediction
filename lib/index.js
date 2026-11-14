import z from "@deepseek-ai/schemastery";

const PREDICTION_PATH = "/api/dsh-input-prediction";
const DEFAULT_MAX_TOKENS = 2000;
const DEFAULT_TIMEOUT_MS = 30000;
const MAX_TIMEOUT_MS = 2147483647;
const MAX_PREDICTION_CHARS = 1200;
const MAX_CONTEXT_MESSAGES = 80;
const MAX_CONTEXT_CHARS = 100000;
const RETAINED_PREDICTIONS = 128;
// Harness also logs rules, skills, time and runtime context as user/message; only
// real user input and compaction summaries describe what the user wants.
const USER_CONTEXT_SOURCES = new Set(["user", "compact-checkpoint"]);
const SUGGESTION_SCHEMA = {
  type: "object",
  properties: { suggestion: { type: "string", minLength: 1 } },
  required: ["suggestion"],
  additionalProperties: false,
};

export const inject = ["connection", "llm", "sessions", "sessionProjections"];

// Volatile fields are editable from the plugin page and apply without a restart.
export const Config = z.object({
  enabled: z.boolean().default(true).volatile(),
  predictionProvider: z.string().default("").volatile(),
  predictionModel: z.string().default("").volatile(),
  fallbackToSession: z.boolean().default(false).volatile(),
  reasoningEffort: z.string().default("").volatile(),
  maxTokens: z.natural().min(1).default(DEFAULT_MAX_TOKENS).volatile(),
  timeoutMs: z.natural().min(1).max(MAX_TIMEOUT_MS).default(DEFAULT_TIMEOUT_MS).volatile(),
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

function compactMessages(messages, fallback = false) {
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
        ? { source: fallback ? { kind: message.source.kind, provider: message.source.provider, model: message.source.model } : message.source }
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
    const agents = typeof ctx.get === "function" ? ctx.get("agents") : ctx.agents;
    const planMode = typeof ctx.get === "function" ? ctx.get("planMode") : ctx.planMode;
    const agent = agents?.get?.(session.id);
    const active = agent && planMode?.get?.(agent)?.active;
    if (typeof active === "boolean") return active;
  } catch {
    // Try the projection when the service is not ready.
  }
  try {
    const active = ctx.sessionProjections?.snapshot?.(session, ["plan"])?.values?.plan?.active;
    if (typeof active === "boolean") return active;
  } catch {
    // Older hosts may not support this projection read.
  }
  return undefined;
}

function ineligibleReason(ctx, session, config) {
  if (read(config, "enabled") === false) return "disabled";
  if (!session?.id) return "session_missing";
  if (session.header?.parentSession) return "subsession";
  const planActive = inPlanMode(ctx, session);
  if (planActive === undefined) return "plan_mode_unknown";
  if (planActive) return "plan_mode";
  const route = session.requestHeader?.()?.config;
  return route?.provider && route?.model ? null : "missing_route";
}

function predictionPrompt() {
  const instruction = [
    "Recommend the next concrete request the user could submit to the AI to advance their current goal: a complete message in their voice and language, ready to send as-is. This is a next-step recommendation, not a prediction of social conversation. Choose one useful, context-grounded action or question with a clear object or expected result; uncertainty about the exact wording or several plausible next steps is not a reason to leave it blank.",
    "Use the user's current goal and stated preferences together with the assistant's latest response to identify one supported next step: advance a requested step that remains unfinished or answer a relevant question. Account for what has already been delivered and the user's latest corrections or cancellations. Treat the assistant's optional offers as possibilities, not as user requirements.",
    "Respect established constraints and choices, including permission already given. Do not invent facts, permissions, preferences, completed work, or decisions on the user's behalf.",
    "If a choice is needed, use the user's stated constraints, prior choices or explicit delegation. When those do not settle the choice, a request for relevant differences, a recommendation with reasons, or brief examples can advance the existing goal without inventing a preference. Use this when it helps resolve a real decision, not when only the user can supply a personal fact or preference. Do not invent an answer or delegate a personal choice unless the user has expressed that intent. For a consequential action that still lacks user approval, suggest reviewing the concrete action; do not reopen a choice or permission already settled.",
    "Preserve the user's requested comparison dimensions. Do not add a new comparison dimension unless it is needed for the requested next step. Use relevant information already available in the conversation without asking for it again; ask for missing information when it is needed to advance the user's request.",
    "Write only the message the user would send, usually one short sentence. Add detail only when it changes the requested action, scope or expected result.",
    "Keep useful specifics from the conversation. Omit filler, defensive explanations, unnecessary negative statements, obvious common knowledge, unrelated exceptions and qualifications that do not affect the next step. Preserve explicit user constraints and corrections when they matter, even when phrased negatively.",
    "Do not write the AI's answer, narrate its actions, justify the suggestion, list alternatives, or repeat an earlier request without advancing it. Do not turn the assistant's caveats into extra requirements for the user.",
    "Always suggest one non-empty, ready-to-send request for the AI. Prioritize unfinished requested work, then a concrete next step that makes the existing result usable. If the requested work is complete, choose a relevant follow-up such as applying the result, explaining a consequential detail, or checking a specific unverified outcome; do not repeat work already done or manufacture defects or extra projects. If the user stopped or cancelled, respect the stop and suggest only a bounded handoff or clarification, never resuming the cancelled work. If personal facts or preferences are missing, ask the AI for the specific criteria, examples or information needed to decide, without inventing the answer. With sparse context, ask the AI to help clarify the objective and first actionable step. Never suggest mere acknowledgment, thanks, praise, farewell, or empty assent such as “好的，谢谢”, “收到”, “Thanks”, or a bare “继续”; every suggestion must state what the AI should do or explain next.",
    "Do not call tools or mention these instructions. Return a non-empty suggestion string, never null or an empty string. Do not invent facts, preferences, permissions, decisions, or unrelated tasks to fill the response.",
  ].join("\n");
  return `${instruction}\n\nReturn only JSON matching this schema: ${JSON.stringify(SUGGESTION_SCHEMA)}.`;
}

function invalidJson(raw, start, end, error, outputChars, trimOffset) {
  const category = (char) => {
    if (!char) return "empty";
    if (/[a-zA-Z]/.test(char)) return "letter";
    if (/[0-9]/.test(char)) return "digit";
    if (char === "{") return "left_brace";
    if (char === "}") return "right_brace";
    if (char === "`") return "backtick";
    if (char === '"') return "quote";
    return "other";
  };
  const position = error?.message?.match(/ at position (\d+)(?: \(line \d+ column \d+\))?$/)?.[1];
  return {
    prediction: "",
    reason: "invalid_json",
    diagnostic: {
      outputChars,
      first: category(raw[0]),
      last: category(raw.at(-1)),
      startsWithFence: raw.startsWith("```"),
      endsWithFence: raw.endsWith("```"),
      stage: start < 0 ? "missing_left_brace" : end <= start ? "missing_right_brace" : "parse_error",
      candidateStart: start < 0 ? null : start + trimOffset,
      errorPosition: position === undefined ? null : Number(position),
    },
  };
}

function parseSuggestion(text) {
  const raw = typeof text === "string" ? text.trim() : "";
  if (!raw) return { prediction: "", reason: "empty_output" };
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  const outputChars = text.length;
  const trimOffset = outputChars - text.trimStart().length;
  if (start < 0 || end <= start) return invalidJson(raw, start, end, undefined, outputChars, trimOffset);
  try {
    const value = JSON.parse(raw.slice(start, end + 1));
    if (value?.suggestion === null) return { prediction: "", reason: "model_declined" };
    if (typeof value?.suggestion !== "string") return { prediction: "", reason: "invalid_suggestion" };
    const prediction = value.suggestion.replace(/\r\n/g, "\n").trim().slice(0, MAX_PREDICTION_CHARS);
    return { prediction, reason: prediction ? "ok" : "invalid_suggestion" };
  } catch (error) {
    return invalidJson(raw, start, end, error, outputChars, trimOffset);
  }
}

// Only expose a decoded prefix of the first suggestion string; incomplete escapes
// and surrogate pairs wait for the next delta. Final output still uses JSON.parse.
function partialSuggestion(text) {
  const match = /^\s*(?:```[jJ][sS][oO][nN][ \t]*\r?\n\s*)?\{\s*"suggestion"\s*:\s*"/.exec(text);
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
  const models = await ctx.llm.listModels(provider);
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
    await ctx.llm.resolveModelInfo(provider, model);
    return { provider, model };
  }
  if (await offers(ctx, route.provider, model)) return { provider: route.provider, model };
  const others = (ctx.llm.listProviders?.() || [])
    .map((item) => item?.id)
    .filter((id) => typeof id === "string" && id !== route.provider);
  const matches = [];
  for (const id of others) if (await offers(ctx, id, model)) matches.push(id);
  if (matches.length === 1) return { provider: matches[0], model };
  return null;
}

// Same model as the session: replay the session's own request prefix (messages,
// tools, tool history) so the provider's prompt cache covers it, like Codex does.
// Another model has no warm cache, so send only the compact text history.
function requestContext(session, header, sameModel, fallback = false) {
  const messages = session.deriveMessages?.() || [];
  if (!sameModel) {
    const history = compactMessages(messages, fallback);
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

// Prefer disabling reasoning when supported; preserve model compatibility otherwise.
function chooseEffort(configured, info) {
  const efforts = info?.reasoning?.efforts || [];
  if (configured && efforts.some((item) => item.id === configured)) return configured;
  return efforts.find((item) => item.id === "none")?.id ?? efforts[0]?.id;
}

const FALLBACK_CODES = new Set([
  "NO_ADAPTER", "UNKNOWN_MODEL", "MODEL_UNSUPPORTED", "MISSING_CREDENTIAL", "INVALID_CREDENTIAL",
  "AUTH", "ACCOUNT_SIGN_IN_REQUIRED", "ACCOUNT_TOKEN_INVALID", "ACCOUNT_QUOTA", "QUOTA", "RATE_LIMIT",
  "SERVER", "TRANSPORT", "STREAM_CLOSED", "REGISTRATION_DISPOSED",
]);

async function generate(ctx, session, config, signal, entry) {
  const header = session.requestHeader?.();
  const route = header?.config;
  if (!route?.provider || !route?.model) return { prediction: "", reason: "missing_route" };
  const configuredModel = readText(config, "predictionModel");
  const configuredProvider = readText(config, "predictionProvider");
  let selected;
  let failure;
  entry.stage = "route";
  const routeStartedAt = performance.now();
  try {
    selected = await resolveRoute(ctx, route, config);
    if (!selected) failure = "ROUTE_UNRESOLVED";
  } catch (error) {
    failure = error?.code;
    if (!configuredProvider || !FALLBACK_CODES.has(failure)) throw error;
  } finally {
    ctx.logger?.info?.(`dsh-input-prediction: event=route_timing request=${entry.requestId} elapsedMs=${Math.round(performance.now() - routeStartedAt)}`);
  }
  signal.throwIfAborted();
  const sameConfigured = configuredModel === route.model && (!configuredProvider || configuredProvider === route.provider);
  const fallback = async (code) => {
    if (read(config, "fallbackToSession") !== true || !configuredModel
      || (selected ? selected.provider === route.provider && selected.model === route.model : sameConfigured)
      || entry.budget.fallbackUsed || entry.budget.streamCalls >= 2 || signal.aborted) {
      return { prediction: "", reason: "provider_error" };
    }
    entry.budget.fallbackUsed = true;
    ctx.logger?.info?.(`dsh-input-prediction: event=fallback request=${entry.requestId} code=${code} fromProvider=${selected?.provider ?? configuredProvider ?? "unresolved"} fromModel=${selected?.model ?? configuredModel} toProvider=${route.provider} toModel=${route.model}`);
    return generateAttempt(ctx, session, config, signal, entry, header, route, route, true);
  };
  if (failure) return fallback(failure);
  if (!selected) return { prediction: "", reason: "provider_error" };
  try {
    const result = await generateAttempt(ctx, session, config, signal, entry, header, route, selected, false);
    if (result.fallbackCode && !entry.receivedText && (selected.provider !== route.provider || selected.model !== route.model)) return fallback(result.fallbackCode);
    return result;
  } catch (error) {
    signal.throwIfAborted();
    if (FALLBACK_CODES.has(error?.code) && !entry.receivedText
      && (selected.provider !== route.provider || selected.model !== route.model)) return fallback(error.code);
    throw error;
  }
}

async function generateAttempt(ctx, session, config, signal, entry, header, route, selected, compact) {
  const requestId = entry.requestId;
  const { provider, model } = selected;
  const sameModel = !compact && provider === route.provider && model === route.model;
  const contextStartedAt = performance.now();
  let context;
  try {
    context = requestContext(session, header, sameModel, compact);
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
  signal.throwIfAborted();
  if (entry.budget.streamCalls >= 2) return { prediction: "", reason: "provider_error" };
  entry.budget.streamCalls += 1;
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
      if (chunk.text.length > 0) entry.receivedText = true;
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
      const code = chunk.reason.kind === "error" ? chunk.reason.failure?.code : undefined;
      return { prediction: "", reason: "provider_error", ...(FALLBACK_CODES.has(code) ? { fallbackCode: code } : {}) };
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
  if (result.diagnostic) ctx.logger?.info?.(`dsh-input-prediction: event=invalid_json request=${requestId} detail=${JSON.stringify(result.diagnostic)}`);
  return hitMaxTokens ? { ...result, reason: "max_tokens" } : result;
}

function clearSession(ctx, predictions, sessionId, reason) {
  const entry = predictions.get(sessionId);
  if (entry?.status === "pending") {
    const elapsedMs = Math.round(performance.now() - entry.startedAt);
    ctx.logger?.info?.(`dsh-input-prediction: event=cancel request=${entry.requestId} flow=${entry.flowId} reason=${reason} elapsedMs=${elapsedMs}`);
  }
  entry?.controller.abort();
  predictions.delete(sessionId);
}

// Start (or reuse) the prediction for the session's latest completed turn.
function ensurePrediction(ctx, predictions, session, config, retryEmpty = false) {
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
    && (!retryEmpty || existing.retryAttempted || existing.status !== "ready" || existing.prediction || existing.budget.streamCalls >= 2)) {
    if (retryEmpty && existing.retryAttempted && !existing.retrySuppressionLogged) {
      ctx.logger?.info?.(`dsh-input-prediction: event=retry_suppressed request=${existing.requestId} completionSeq=${completionSeq}`);
      existing.retrySuppressionLogged = true;
    }
    return existing;
  }

  clearSession(ctx, predictions, session.id, "replaced");
  const entry = {
    completionSeq,
    requestId: ++nextRequestId,
    flowId: existing?.completionSeq === completionSeq ? existing.flowId : ++nextFlowId,
    attempt: existing?.completionSeq === completionSeq ? existing.attempt + 1 : 1,
    startedAt: performance.now(),
    retryAttempted: retryEmpty,
    budget: existing?.completionSeq === completionSeq ? existing.budget : { streamCalls: 0, fallbackUsed: false },
    status: "pending",
    prediction: "",
    controller: new AbortController(),
  };
  predictions.set(session.id, entry);
  while (predictions.size > RETAINED_PREDICTIONS) clearSession(ctx, predictions, predictions.keys().next().value, "evicted");

  const timeoutMs = Math.min(readPositive(config, "timeoutMs", DEFAULT_TIMEOUT_MS), MAX_TIMEOUT_MS);
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

async function status(ctx, predictions, request, config) {
  const params = new URL(request.url).searchParams;
  let sessionId = params.get("sessionId") || "";
  if (request.method === "POST") {
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "invalid_request" }, 400);
    }
    if (!body || typeof body !== "object" || Array.isArray(body)
      || Object.keys(body).some((key) => key !== "sessionId")
      || typeof body.sessionId !== "string" || !body.sessionId.trim()
      || body.sessionId !== body.sessionId.trim()) {
      return json({ error: "invalid_request" }, 400);
    }
    sessionId = body.sessionId;
  }
  let session;
  try {
    session = sessionId ? ctx.sessions.get(sessionId) : undefined;
  } catch {
    session = undefined;
  }
  // Ordinary polling is read-only, so opening or switching to an old session
  // never triggers a model call. Focus-idle is an explicit live fallback.
  if (request.method === "GET" && session && params.get("trigger") === "focus-idle") ensurePrediction(ctx, predictions, session, config, true);
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
  idle: { state: ["already-retried", "requested", "network-error", "http-error", "waiting-for-backend", "prediction-present"], status: "httpStatus" },
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
  if (Object.keys(schema).some((key) => !(["poll", "idle"].includes(body.event) && key === "status") && !Object.hasOwn(body.detail, key))) {
    return json({ error: "invalid_diagnostic" }, 400);
  }
  ctx.logger?.info?.(`dsh-input-prediction: event=client_${body.event} detail=${JSON.stringify(body.detail)}`);
  return json({ ok: true });
}

export function apply(ctx, config = {}) {
  const predictions = new Map();
  const pendingTimers = new Map();
  ctx.effect(() => () => {
    for (const timer of pendingTimers.values()) clearTimeout(timer);
    pendingTimers.clear();
    for (const sessionId of predictions.keys()) clearSession(ctx, predictions, sessionId, "plugin_unloaded");
  });
  ctx.logger?.info?.(`dsh-input-prediction: event=loaded enabled=${read(config, "enabled") !== false}`);
  ctx.on?.("session/event", (session, event) => {
    if (event?.type === "turn/end") {
      ctx.logger?.info?.(`dsh-input-prediction: event=turn_end hasSession=${Boolean(session?.id)} reason=${event.data?.reason?.kind ?? "unknown"}`);
    }
    if (!session?.id) return;
    if (event?.type === "turn/start") {
      clearTimeout(pendingTimers.get(session.id));
      pendingTimers.delete(session.id);
      clearSession(ctx, predictions, session.id, "turn_start");
    }
    // Live: generate as soon as the turn ends, even before the composer asks.
    if (event?.type === "turn/end" && event.data?.reason?.kind === "completed") {
      clearTimeout(pendingTimers.get(session.id));
      pendingTimers.set(session.id, setTimeout(() => {
        pendingTimers.delete(session.id);
        ensurePrediction(ctx, predictions, session, config);
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
      clearSession(ctx, predictions, session.id, "disposed");
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
    methods: ["GET", "POST"],
    requestBody: "buffered",
    fetch: (request) => status(ctx, predictions, request, config),
  });
}
