// Small HTTP helper with retries, timeouts and a hard rule: never log tokens.

import { withRetry } from './retry.js';

export class HttpError extends Error {
  constructor(message, status, bodyText) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.bodyText = typeof bodyText === 'string' ? bodyText.slice(0, 500) : undefined;
  }
}

/** Strip anything that looks like a credential before it reaches a log. */
export function redact(text) {
  if (typeof text !== 'string') return text;
  return text
    // An optional Bearer/Basic prefix has to be swallowed with the value.
    // Without it, `Authorization: Bearer abc` redacts the word Bearer and
    // leaves the credential sitting in the log.
    .replace(
      /(authorization|token|password|secret)(["']?\s*[:=]\s*["']?)(?:Bearer\s+|Basic\s+|token\s+)?[^"'\s,}]+/gi,
      '$1$2[REDACTED]',
    )
    // Three dot separated base64url segments, the last one long. A real JWT
    // header is often only about 20 characters, so requiring a long first
    // segment would miss most of them.
    .replace(/\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{16,}/g, '[REDACTED_JWT]');
}

/**
 * fetch with a timeout plus retries.
 *
 * @param {string} url
 * @param {object} [o]
 * @param {object} [o.headers]
 * @param {number} [o.timeoutMs]
 * @param {boolean} [o.asJson] default true when Accept is json-ish
 * @param {AbortSignal} [o.signal]
 * @param {number} [o.attempts]
 * @returns {Promise<any>} parsed body (or text when asJson is false)
 */
export async function fetchJson(url, o = {}) {
  const { headers = {}, timeoutMs = 15000, asJson = true, signal, attempts = 4, onRetry, method = 'GET', body } = o;

  return withRetry(
    async () => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs);
      // Forward an external abort into our own controller.
      const onOuterAbort = () => ctrl.abort(signal.reason);
      signal?.addEventListener('abort', onOuterAbort, { once: true });
      try {
        const res = await fetch(url, { method, headers, body, signal: ctrl.signal, redirect: 'follow' });
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          const err = new HttpError(
            `HTTP ${res.status} for ${url.replace(/([?&]token=)[^&]+/i, '$1[REDACTED]')}`,
            res.status,
            text,
          );
          // 4xx other than 429 is permanent - do not retry.
          if (res.status !== 429 && res.status >= 400 && res.status < 500) err.retryable = false;
          throw err;
        }
        if (!asJson) return await res.text();
        const text = await res.text();
        try {
          return JSON.parse(text);
        } catch {
          throw Object.assign(new Error(`Expected JSON from ${url}, got: ${text.slice(0, 120)}`), { retryable: false });
        }
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onOuterAbort);
      }
    },
    { attempts, signal, onRetry },
  );
}
