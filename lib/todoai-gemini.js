const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const MAX_PRIMARY_ATTEMPTS = 2;
const TOTAL_BUDGET_MS = 6_500;
const ATTEMPT_TIMEOUT_MS = 3_000;

/**
 * Call the primary model with one short retry, then use one fallback model
 * attempt if the failure is transient. Deterministic errors (400/401/403/404)
 * never trigger fallback. Logs contain metadata only, never prompt or key data.
 */
export async function fetchGemini({ model, fallbackModel, apiKey, body, route }) {
  const startedAt = Date.now();
  const primary = model || 'gemini-2.5-flash-lite';
  const fallback = fallbackModel && fallbackModel !== primary ? fallbackModel : null;
  let lastTransientReason = 'unknown';

  for (let attempt = 1; attempt <= MAX_PRIMARY_ATTEMPTS; attempt += 1) {
    const result = await attemptModel({ model: primary, apiKey, body, route, attempt, startedAt, budgetRemaining: TOTAL_BUDGET_MS - (Date.now() - startedAt) });
    if (result.response) {
      if (result.response.ok || !result.retryable) return result.response;
      lastTransientReason = `status_${result.response.status}`;
      result.response.body?.cancel?.();
    } else {
      lastTransientReason = result.reason || 'network_error';
    }
    if (attempt < MAX_PRIMARY_ATTEMPTS && Date.now() - startedAt + 250 < TOTAL_BUDGET_MS) await wait(250);
  }

  if (fallback && Date.now() - startedAt < TOTAL_BUDGET_MS) {
    console.info(`[todoai/${route}] fallback_triggered primary=${primary} fallback=${fallback} reason=${lastTransientReason} retries=${MAX_PRIMARY_ATTEMPTS - 1}`);
    const result = await attemptModel({ model: fallback, apiKey, body, route, attempt: 1, startedAt, budgetRemaining: TOTAL_BUDGET_MS - (Date.now() - startedAt), isFallback: true });
    if (result.response) return result.response;
    throw new Error(result.reason || 'Gemini fallback request failed');
  }

  throw new Error(`Gemini primary request failed: ${lastTransientReason}`);
}

async function attemptModel({ model, apiKey, body, route, attempt, startedAt, budgetRemaining, isFallback = false }) {
  const attemptStartedAt = Date.now();
  const timeoutMs = Math.max(250, Math.min(ATTEMPT_TIMEOUT_MS, budgetRemaining));
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-goog-api-key': apiKey },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const retryable = RETRYABLE_STATUS.has(response.status);
    console.info(`[todoai/${route}] model=${model} fallback=${isFallback} status=${response.status} attempt=${attempt} retryable=${retryable} latencyMs=${Date.now() - attemptStartedAt} totalMs=${Date.now() - startedAt}`);
    return { response, retryable };
  } catch (error) {
    const reason = error?.name === 'AbortError' ? 'timeout' : 'network_error';
    console.warn(`[todoai/${route}] model=${model} fallback=${isFallback} reason=${reason} attempt=${attempt} latencyMs=${Date.now() - attemptStartedAt} totalMs=${Date.now() - startedAt}`);
    return { reason, retryable: true };
  } finally {
    clearTimeout(timeout);
  }
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
