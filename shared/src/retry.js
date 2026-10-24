// Retry with exponential backoff.
//
// One implementation for the whole project so every network call behaves the
// same way: wait longer each time, add jitter so a whole server room does not
// retry in lockstep, and give up after a bounded number of tries.

/** Sleep helper that can be cancelled. */
export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error('aborted'));
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal.reason ?? new Error('aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Decide whether an error is worth retrying.
 * Network level failures and 5xx / 429 are retryable. A 404 or a validation
 * error is not - repeating it just wastes time.
 */
export function isRetryable(err) {
  if (!err) return false;
  if (err.retryable === false) return false;
  if (err.retryable === true) return true;
  const code = err.code || err.cause?.code;
  if (['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EPIPE', 'EAI_AGAIN', 'ENOTFOUND', 'EHOSTUNREACH', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT'].includes(code)) {
    return true;
  }
  const status = err.status ?? err.statusCode;
  if (typeof status === 'number') return status === 429 || status >= 500;
  return true; // unknown errors: assume transient, the attempt cap keeps it safe
}

/**
 * Run fn until it succeeds or the attempts run out.
 *
 * @param {() => Promise<any>} fn
 * @param {object} [o]
 * @param {number} [o.attempts]      total tries, including the first
 * @param {number} [o.baseMs]        first backoff length
 * @param {number} [o.maxMs]         cap on a single wait
 * @param {number} [o.factor]        multiplier per attempt
 * @param {AbortSignal} [o.signal]
 * @param {(info:{attempt:number, error:Error, waitMs:number}) => void} [o.onRetry]
 */
export async function withRetry(fn, o = {}) {
  const attempts = Math.max(1, o.attempts ?? 4);
  const baseMs = o.baseMs ?? 400;
  const maxMs = o.maxMs ?? 8000;
  const factor = o.factor ?? 2;

  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastError = err;
      if (attempt === attempts || !isRetryable(err)) break;
      // Exponential backoff with up to 25% jitter.
      const exp = Math.min(maxMs, baseMs * Math.pow(factor, attempt - 1));
      const waitMs = Math.round(exp * (0.75 + Math.random() * 0.25));
      o.onRetry?.({ attempt, error: err, waitMs });
      await sleep(waitMs, o.signal);
    }
  }
  throw lastError;
}
