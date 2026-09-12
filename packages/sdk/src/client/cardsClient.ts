/**
 * HTTP client for the Cards V2 REST API.
 *
 *
 * @summary HTTP client for the Cards V2 REST API
 * @module sdk/CardsClient
 */

import type {
  AddBranchResponse,
  Card,
  CompareRequest,
  CompareState,
  EnvironmentsResponse,
  HttpClient,
  RemoveBranchResponse,
  StreamMeta,
  TimelineItem,
  VariableGroupsResponse
} from '../protocol/index.js';
import type {
  AddBranchRequest,
  AttachmentResponse,
  BranchesResponse,
  CardCreateData,
  CardsClientOptions,
  CardUpdateData,
  GateApprovalResponse,
  ListCardsOptions,
  TimelineOptions
} from './types/client.js';
import { ApiError, NetworkError, RequestCancelledError, RetryExhaustedError } from './types/errors.js';

/** Default initial fetch timeout in milliseconds for each individual request attempt. */
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

/**
 * Resolves the initial per-request fetch timeout, honoring the
 * `CARDS_REQUEST_TIMEOUT_MS` env override when it is a positive finite number.
 *
 * The 10 s default is correct for real users hitting a warm, already-running
 * extension server. It can be too short, however, for a *cold* server whose
 * first `createCard` POST must spawn the git-plumbing compare-and-swap path
 * (`commitWithCas` / index reconcile) — on a slow host (notably Windows, where
 * `git` subprocess spawning is expensive) that one-time cost can approach or
 * exceed the bound and abort the request. The QA harness (and slow CI)
 * therefore raise it via `CARDS_REQUEST_TIMEOUT_MS` so the raw `card` CLI
 * subprocess tolerates the cold start, while end users keep the tight 10 s
 * bound. Invalid values (non-numeric, zero, negative, infinite) fall back to
 * the default — fail-closed to the safe bound.
 *
 * @returns The resolved initial request timeout in milliseconds.
 */
function resolveRequestTimeoutMs(): number {
  // `cardsClient` is bundled into the browser webviews (via `@cards.management/web`), where
  // there is no Node `process` global. Reading bare `process.env` there throws a
  // `ReferenceError` at module load and blanks the entire webview. The
  // `CARDS_REQUEST_TIMEOUT_MS` override is only meaningful in Node (CLI / QA
  // harness); in the browser fall back to the safe default — fail closed.
  const raw = typeof process !== 'undefined' ? process.env['CARDS_REQUEST_TIMEOUT_MS'] : undefined;
  if (raw === undefined) return DEFAULT_REQUEST_TIMEOUT_MS;
  const parsed = Number(raw);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  return DEFAULT_REQUEST_TIMEOUT_MS;
}

/** Initial fetch timeout in milliseconds for each individual request attempt. */
const REQUEST_TIMEOUT_MS = resolveRequestTimeoutMs();

/**
 * Maximum per-request fetch timeout in milliseconds. The per-attempt timeout
 * starts at {@link REQUEST_TIMEOUT_MS} and doubles on each consecutive network
 * failure, capped at this value. The cap tracks the resolved initial timeout so
 * a `CARDS_REQUEST_TIMEOUT_MS` override larger than the 10 s baseline is never
 * clamped *downward* on the first backoff step.
 */
const MAX_REQUEST_TIMEOUT_MS = Math.max(10_000, REQUEST_TIMEOUT_MS);

/** Initial delay before retrying a failed network request (3 seconds). */
const INITIAL_RETRY_DELAY_MS = 3_000;

/** Maximum delay between retries (30 seconds). Once reached, retries continue at this interval. */
const MAX_RETRY_DELAY_MS = 30_000;

/** Default maximum number of attempts for a retried request (initial attempt included). */
const DEFAULT_MAX_ATTEMPTS = 10;

/**
 * Resolves the maximum number of attempts for a retried request, counting the
 * initial attempt.
 *
 * Unset values fall back to {@link DEFAULT_MAX_ATTEMPTS}. Invalid values
 * (non-finite, less than 1) also fall back to the default — fail closed to the
 * safe bound rather than allowing an unbounded or zero-attempt loop.
 *
 * @param raw - Caller-provided attempt bound from `CardsClientOptions`.
 * @returns The resolved attempt count, at least 1.
 */
function resolveMaxAttempts(raw: number | undefined): number {
  if (raw === undefined) return DEFAULT_MAX_ATTEMPTS;
  if (!Number.isFinite(raw) || raw < 1) return DEFAULT_MAX_ATTEMPTS;
  return Math.floor(raw);
}

/**
 * Returns true when an error is a programming bug rather than a recoverable
 * transport failure — retrying would produce the identical failure forever.
 *
 * `fetch` surfaces network failures as `TypeError` with messages like
 * "fetch failed" / "Failed to fetch" / "NetworkError when attempting to fetch
 * resource" (and Node sets `cause` to the underlying syscall error). Other
 * `TypeError` shapes — "Cannot read properties of undefined", "x is not a
 * function" — come from logic bugs in the caller's request function.
 *
 * @param error - Caught value from the request function.
 * @returns True when the error class indicates a non-recoverable programming bug.
 */
function isNonRecoverableError(error: unknown): boolean {
  if (error instanceof ReferenceError) return true;
  if (error instanceof RangeError) return true;
  if (error instanceof SyntaxError) return true;
  if (error instanceof TypeError) {
    const message = error.message;
    const looksLikeFetchFailure =
      /fetch|NetworkError|network request failed/i.test(message) || (error as { cause?: unknown }).cause !== undefined;
    return !looksLikeFetchFailure;
  }
  return false;
}

/**
 * Type-safe HTTP client for the Cards V2 REST API.
 *
 * Uses the Fetch API by default and supports dependency injection of an
 * alternate {@link HttpClient} for tests or custom transports. All public
 * methods surface server failures as {@link ApiError} and transport failures
 * as {@link NetworkError}.
 *
 * All network errors (timeouts, connection refused, DNS failures) are retried
 * with exponential backoff: 3s → 6s → 12s → 24s → 30s cap, then every 30s
 * until the attempt budget ({@link CardsClientOptions.maxAttempts}, default
 * 10) is exhausted, surfacing {@link RetryExhaustedError}. A configured
 * {@link CardsClientOptions.signal} stops further retries immediately with
 * {@link RequestCancelledError}. HTTP error responses (4xx, 5xx) are not
 * retried — they surface immediately as {@link ApiError}.
 *
 * @example
 * ```typescript
 * const client = new CardsClient({ baseUrl: 'http://localhost:3000', accessToken: 'token' });
 *
 * const cards = await client.listCards({ status: 'active' });
 * await client.updateCard(cardId, { status: 'done' });
 * ```
 */
export class CardsClient {
  private readonly _httpClient?: HttpClient;

  /**
   * The caller-configured per-request timeout. {@link _currentTimeoutMs} starts
   * at this value and doubles on each consecutive network failure (capped at
   * {@link MAX_REQUEST_TIMEOUT_MS}), resetting to this value on each successful
   * response.
   */
  private readonly _initialTimeoutMs: number;

  /**
   * Current per-request fetch timeout in milliseconds. Doubles on each
   * consecutive network failure (capped at {@link MAX_REQUEST_TIMEOUT_MS}) and
   * resets to {@link _initialTimeoutMs} on each successful response.
   */
  private _currentTimeoutMs: number;

  /**
   * Maximum number of attempts for retried requests (initial attempt
   * included). Resolved once from {@link CardsClientOptions.maxAttempts};
   * invalid values fail closed to the default bound.
   */
  private readonly _maxAttempts: number;

  /**
   * Optional client-level signal that cancels requests and stops retries.
   * Captured once from {@link CardsClientOptions.signal} at construction.
   */
  private readonly _signal: AbortSignal | undefined;

  /**
   * Creates a new CardsClient instance.
   *
   * @param options - Configuration options including base URL and auth token.
   * @param httpClient - Optional HTTP client for dependency injection.
   */
  constructor(
    private options: CardsClientOptions,
    httpClient?: HttpClient
  ) {
    this._httpClient = httpClient;
    this._initialTimeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
    this._currentTimeoutMs = this._initialTimeoutMs;
    this._maxAttempts = resolveMaxAttempts(options.maxAttempts);
    this._signal = options.signal;
  }

  /**
   * Replaces the access token used for subsequent API requests.
   *
   * @param token - The new access token to use for authentication.
   */
  updateAccessToken(token: string): void {
    this.options = { ...this.options, accessToken: token };
  }

  /**
   * Returns the base URL used to build API requests.
   *
   * @returns The base URL string as provided in {@link CardsClientOptions}.
   */
  getBaseUrl(): string {
    return this.options.baseUrl;
  }

  /**
   * Returns whether an HTTP client was injected.
   *
   * @returns True if an HTTP client was provided during construction.
   * @internal Used for testing dependency injection.
   */
  hasHttpClient(): boolean {
    return this._httpClient !== undefined;
  }
  /**
   * Returns an AbortSignal that fires after the current backoff timeout.
   * Uses caller's signal if provided (for DI/testing), otherwise applies the backoff timeout.
   * A client-level {@link CardsClientOptions.signal} is combined into the
   * result so cancelling it also aborts in-flight fetch attempts.
   *
   * @param existingSignal - Optional caller-provided signal to reuse instead of creating a timeout signal.
   * @returns AbortSignal that controls request cancellation for the current operation.
   */
  private getTimeoutSignal(existingSignal?: AbortSignal | null): AbortSignal {
    const timeoutSignal = existingSignal ?? AbortSignal.timeout(this._currentTimeoutMs);
    if (!this._signal) return timeoutSignal;
    return AbortSignal.any([timeoutSignal, this._signal]);
  }

  /**
   * Records a successful request and resets the timeout backoff to the
   * caller-configured initial value.
   */
  private onRequestSuccess(): void {
    this._currentTimeoutMs = this._initialTimeoutMs;
  }

  /**
   * Waits out a backoff delay, resolving early when the client-level signal
   * aborts so cancellation is not delayed by the remaining sleep.
   *
   * @param ms - Delay duration in milliseconds.
   * @returns True when the delay elapsed fully; false when cancelled.
   */
  private backoffSleep(ms: number): Promise<boolean> {
    const signal = this._signal;
    return new Promise((resolve) => {
      if (signal?.aborted) {
        resolve(false);
        return;
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const onAbort = () => {
        if (timer !== undefined) clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        resolve(false);
      };
      timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve(true);
      }, ms);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  /**
   * Wraps `fetch` so a connection failure (refused, DNS, TLS, timeout) names
   * the URL it was trying to reach. Native `fetch` rejections carry that
   * detail only in an opaque `cause` (e.g. `ECONNREFUSED`) with a message of
   * just `"fetch failed"` — useless on its own once it reaches a CLI's
   * top-level error print. A non-ok HTTP response is returned normally (not
   * thrown) so the existing `response.ok` handling in each call site is
   * unaffected; only the fetch-level rejection is annotated.
   *
   * @param url - The request URL, included in the error message on failure.
   * @param init - Standard `fetch` request options.
   * @returns The `fetch` response, on success.
   */
  private async fetchWithUrlContext(url: string, init: RequestInit): Promise<Response> {
    try {
      return await fetch(url, init);
    } catch (error) {
      throw new Error(`request to ${url} failed: ${error instanceof Error ? error.message : String(error)}`, {
        cause: error
      });
    }
  }

  /**
   * Default HTTP client implementation using fetch + JSON payloads.
   *
   * Each fetch call includes an AbortSignal.timeout of 10 seconds.
   */
  private defaultHttpClient: HttpClient = {
    get: async <T>(url: string, options?: RequestInit): Promise<T> => {
      const response = await this.fetchWithUrlContext(url, {
        ...options,
        headers: { ...this.getHeaders(), ...options?.headers },
        signal: this.getTimeoutSignal(options?.signal)
      });
      if (!response.ok) throw response;
      return response.json() as Promise<T>;
    },
    post: async <T>(url: string, body: unknown, options?: RequestInit): Promise<T> => {
      const response = await this.fetchWithUrlContext(url, {
        ...options,
        method: 'POST',
        headers: { ...this.getHeaders(), ...options?.headers },
        body: body ? JSON.stringify(body) : undefined,
        signal: this.getTimeoutSignal(options?.signal)
      });
      if (!response.ok) throw response;
      return response.json() as Promise<T>;
    },
    put: async <T>(url: string, body: unknown, options?: RequestInit): Promise<T> => {
      const response = await this.fetchWithUrlContext(url, {
        ...options,
        method: 'PUT',
        headers: { ...this.getHeaders(), ...options?.headers },
        body: body ? JSON.stringify(body) : undefined,
        signal: this.getTimeoutSignal(options?.signal)
      });
      if (!response.ok) throw response;
      return response.json() as Promise<T>;
    },
    patch: async <T>(url: string, body: unknown, options?: RequestInit): Promise<T> => {
      const response = await this.fetchWithUrlContext(url, {
        ...options,
        method: 'PATCH',
        headers: { ...this.getHeaders(), ...options?.headers },
        body: body ? JSON.stringify(body) : undefined,
        signal: this.getTimeoutSignal(options?.signal)
      });
      if (!response.ok) throw response;
      return response.json() as Promise<T>;
    },
    delete: async <T = void>(url: string, options?: RequestInit): Promise<T> => {
      const response = await this.fetchWithUrlContext(url, {
        ...options,
        method: 'DELETE',
        headers: { ...this.getHeaders(), ...options?.headers },
        signal: this.getTimeoutSignal(options?.signal)
      });
      if (!response.ok) throw response;
      const text = await response.text();
      return (text === '' ? undefined : JSON.parse(text)) as T;
    }
  };

  /**
   * Gets HTTP headers for JSON API requests.
   *
   * @returns Headers with JSON content type and optional bearer token.
   */
  private getHeaders(): HeadersInit {
    const headers: HeadersInit = { 'Content-Type': 'application/json' };
    if (this.options.accessToken) {
      headers['Authorization'] = `Bearer ${this.options.accessToken}`;
    }
    return headers;
  }

  /**
   * Gets the HTTP client to use for requests.
   *
   * @returns Injected HTTP client when provided, otherwise the default fetch-based client.
   */
  private getHttpClient(): HttpClient {
    return this._httpClient ?? this.defaultHttpClient;
  }

  /**
   * Builds a URL relative to the configured base URL.
   *
   * Undefined and null query params are omitted. Values are stringified.
   *
   * @param path - Relative API path to append to the configured base URL.
   * @param params - Optional query parameters to encode onto the URL.
   * @returns Fully-qualified request URL string.
   */
  private buildUrl(path: string, params?: Record<string, unknown>): string {
    const url = new URL(path, this.options.baseUrl);
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== null) {
          url.searchParams.set(key, String(value));
        }
      }
    }
    return url.toString();
  }

  /**
   * Wraps a request with consistent error handling and automatic retry.
   *
   * HTTP error responses (4xx, 5xx) surface immediately as {@link ApiError}
   * since the server is reachable and the request was rejected on its merits.
   *
   * Network errors are retried with exponential backoff (starting at 3s,
   * doubling each attempt up to a 30s cap, then every 30s) only when the
   * operation is idempotent — re-running it cannot change server state beyond
   * what a single successful run would. GETs and replace-style writes
   * (PUT/DELETE) are idempotent and retried.
   *
   * Retrying stops when the attempt budget ({@link CardsClientOptions.maxAttempts},
   * default 10) is exhausted — surfacing {@link RetryExhaustedError} — or when
   * {@link CardsClientOptions.signal} aborts, which stops further retries
   * immediately with {@link RequestCancelledError}.
   *
   * Non-idempotent operations (e.g. `POST /cards`, which mints a new card on
   * each run) are NOT retried on an ambiguous-outcome network error such as a
   * request timeout: the request may already have committed server-side, and a
   * blind retry would duplicate the effect (main-186). Such failures surface
   * immediately as {@link NetworkError} so the caller can decide how to recover.
   *
   * @param fn - Async request function to execute.
   * @param idempotent - When false, ambiguous network failures surface as
   *   {@link NetworkError} instead of being retried. Defaults to true.
   * @returns The resolved value from the request function.
   * @throws ApiError when the server responds with a non-2xx status.
   * @throws NetworkError when a non-idempotent request fails to reach the server.
   * @throws RetryExhaustedError when an idempotent request exhausts its attempt budget.
   * @throws RequestCancelledError when the configured abort signal fires.
   */
  private async request<T>(fn: () => Promise<T>, idempotent = true): Promise<T> {
    let retryDelayMs = INITIAL_RETRY_DELAY_MS;
    let attempts = 0;

    while (true) {
      if (this._signal?.aborted) {
        throw new RequestCancelledError('Request cancelled');
      }
      try {
        const result = await fn();
        this.onRequestSuccess();
        return result;
      } catch (error) {
        attempts++;
        const httpLike =
          error instanceof Response ||
          (error !== null &&
            typeof error === 'object' &&
            'status' in error &&
            'ok' in error &&
            typeof (error as Record<string, unknown>)['json'] === 'function')
            ? (error as { ok: boolean; status: number; statusText?: string; json(): Promise<unknown> })
            : null;
        if (httpLike) {
          this.onRequestSuccess();
          let body: Record<string, unknown> = {};
          try {
            body = (await httpLike.json()) as Record<string, unknown>;
          } catch (parseError) {
            if (!(parseError instanceof SyntaxError)) {
              console.warn('[CardsClient] Unexpected error parsing error response:', parseError);
            }
          }
          const message =
            (body['error'] as string | undefined) ||
            (body['message'] as string | undefined) ||
            httpLike.statusText ||
            '';
          const code = (body['code'] as string | undefined) || String(httpLike.status);
          const fields = body['fields'] as Array<{ field: string; message: string }> | undefined;
          throw new ApiError(message, code, fields);
        }

        // Programming bug (ReferenceError, RangeError, SyntaxError, non-fetch TypeError)
        // — surface immediately because retry produces the same failure forever.
        if (isNonRecoverableError(error)) {
          this.onRequestSuccess();
          throw error;
        }

        // Cancellation wins over retry bookkeeping: an aborted signal must not
        // spend more attempts or wait out a backoff sleep.
        if (this._signal?.aborted) {
          throw new RequestCancelledError('Request cancelled', error instanceof Error ? error : undefined);
        }

        // Network error. A non-idempotent operation has an ambiguous outcome —
        // the request may already have committed server-side — so retrying it
        // would duplicate the effect (main-186). Surface it instead of retrying.
        // The same applies when the caller has opted out of network retries.
        if (!idempotent || this.options.retryOnNetworkError === false) {
          throw new NetworkError(
            error instanceof Error ? error.message : String(error),
            error instanceof Error ? error : undefined
          );
        }

        if (attempts >= this._maxAttempts) {
          throw new RetryExhaustedError(
            `Request failed after ${attempts} attempts`,
            attempts,
            error instanceof Error ? error : undefined
          );
        }

        const completed = await this.backoffSleep(retryDelayMs);
        if (!completed) {
          throw new RequestCancelledError('Request cancelled', error instanceof Error ? error : undefined);
        }
        retryDelayMs = Math.min(retryDelayMs * 2, MAX_RETRY_DELAY_MS);
        // Double the per-request fetch timeout on each consecutive network
        // failure (capped at MAX_REQUEST_TIMEOUT_MS) so a congested server gets
        // progressively more time to respond. Do NOT reset here — only an
        // actual success resets the backoff.
        this._currentTimeoutMs = Math.min(this._currentTimeoutMs * 2, MAX_REQUEST_TIMEOUT_MS);
      }
    }
  }

  // --- Card Operations ---

  /**
   * Lists cards with optional filtering.
   *
   * @param options - Optional filter and pagination options.
   * @returns Promise resolving to matching cards.
   * @throws ApiError when the server responds with an error.
   * @throws NetworkError when the request fails to reach the server.
   */
  async listCards(options?: ListCardsOptions): Promise<Card[]> {
    const urlStr = this.buildUrl('/cards', {
      workspacePath: this.options.workspacePath,
      status: options?.status,
      search: options?.search,
      limit: options?.limit,
      offset: options?.offset
    });
    const url = new URL(urlStr);
    for (const t of options?.tags ?? []) {
      url.searchParams.append('tag', t);
    }
    return this.request(() => this.getHttpClient().get<Card[]>(url.toString()));
  }

  /**
   * Lists cards as lightweight summaries for list views.
   *
   * Returns pre-flattened fields suitable for direct use in list rendering,
   * omitting heavyweight fields like `planContent` and `repositoryPath`.
   *
   * @template T - The expected summary shape (default `Record<string, unknown>`).
   * @returns Promise resolving to card summaries.
   * @throws ApiError when the server responds with an error.
   * @throws NetworkError when the request fails to reach the server.
   */
  async listCardSummaries<T = Record<string, unknown>>(): Promise<T[]> {
    const url = this.buildUrl('/cards/list', {
      workspacePath: this.options.workspacePath
    });
    return this.request(() => this.getHttpClient().get<T[]>(url));
  }

  /**
   * Gets a single card by id.
   *
   * @param cardId - The id of the card to retrieve.
   * @returns Promise resolving to the card.
   * @throws ApiError when the server responds with an error.
   * @throws NetworkError when the request fails to reach the server.
   */
  async getCard(cardId: string): Promise<Card> {
    const url = this.buildUrl(`/cards/${encodeURIComponent(cardId)}`, {
      workspacePath: this.options.workspacePath
    });
    return this.request(() => this.getHttpClient().get<Card>(url));
  }

  /**
   * Creates a new card.
   *
   * @param data - Card creation payload.
   * @returns Promise resolving to the created card.
   * @throws ApiError when the server rejects the payload.
   * @throws NetworkError when the request fails to reach the server.
   */
  async createCard(data: CardCreateData): Promise<Card> {
    const url = this.buildUrl('/cards');
    const body = {
      ...data,
      workspacePath: this.options.workspacePath
    };
    return this.request(() => this.getHttpClient().post<Card>(url, body), false);
  }

  /**
   * Updates an existing card.
   *
   * @param cardId - The id of the card to update.
   * @param data - The fields to update.
   * @returns Promise resolving to the updated card.
   * @throws ApiError when the server rejects the update.
   * @throws NetworkError when the request fails to reach the server.
   * @deprecated Use direct git operations instead. This endpoint will be removed.
   */
  async updateCard(cardId: string, data: CardUpdateData): Promise<Card> {
    const url = this.buildUrl(`/cards/${encodeURIComponent(cardId)}`);
    return this.request(() => this.getHttpClient().patch<Card>(url, data));
  }

  /**
   * Deletes a card.
   *
   * @param cardId - The id of the card to delete.
   * @returns Promise resolving when deletion is complete.
   * @throws ApiError when the server rejects the delete.
   * @throws NetworkError when the request fails to reach the server.
   * @deprecated Use direct git operations instead. This endpoint will be removed.
   */
  async deleteCard(cardId: string): Promise<void> {
    const url = this.buildUrl(`/cards/${encodeURIComponent(cardId)}`);
    return this.request(() => this.getHttpClient().delete(url));
  }

  // --- Attachment Operations ---

  /**
   * Uploads an attachment to a card using binary PUT.
   *
   * This is the preferred method - sends raw binary data directly without
   * base64 encoding, resulting in 33% smaller payloads.
   *
   * @param cardId - Identifier of the card that will receive the attachment.
   * @param name - File name including extension.
   * @param data - Binary data as Blob, ArrayBuffer, or base64 string.
   * @returns Promise resolving to attachment metadata.
   * @throws ApiError when the server rejects the upload.
   * @throws NetworkError when the request fails to reach the server.
   */
  async uploadAttachment(cardId: string, name: string, data: Blob | ArrayBuffer | string): Promise<AttachmentResponse> {
    const url = this.buildUrl(`/cards/${encodeURIComponent(cardId)}/attachments/${encodeURIComponent(name)}`);

    // Convert data to Blob for fetch body
    let body: Blob;
    if (data instanceof Blob) {
      body = data;
    } else if (data instanceof ArrayBuffer) {
      body = new Blob([data]);
    } else {
      // base64 string - decode to binary
      const binaryString = atob(data);
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }
      body = new Blob([bytes]);
    }

    return this.request(async () => {
      const response = await this.fetchWithUrlContext(url, {
        method: 'PUT',
        headers: {
          ...this.getHeaders(),
          'Content-Type': 'application/octet-stream'
        },
        body,
        signal: this.getTimeoutSignal()
      });
      if (!response.ok) throw response;
      return response.json() as Promise<AttachmentResponse>;
    });
  }

  /**
   * Downloads an attachment as a Blob.
   *
   * This method uses `fetch` directly so binary data is preserved.
   *
   * @param cardId - Identifier of the card that owns the attachment.
   * @param attachmentId - Identifier of the attachment blob to download (will be URL-encoded).
   * @returns Promise resolving to an attachment Blob.
   * @throws ApiError when the server responds with an error.
   * @throws NetworkError when the request fails to reach the server.
   */
  async getAttachment(cardId: string, attachmentId: string): Promise<Blob> {
    const url = this.buildUrl(`/cards/${encodeURIComponent(cardId)}/attachments/${encodeURIComponent(attachmentId)}`);
    return this.request(async () => {
      const response = await this.fetchWithUrlContext(url, {
        headers: this.getHeaders(),
        signal: this.getTimeoutSignal()
      });
      if (!response.ok) throw response;
      return response.blob();
    });
  }

  /**
   * Lists attachments for a card.
   *
   * @param cardId - Identifier of the card whose attachments should be listed.
   * @returns Promise resolving to attachment metadata.
   * @throws ApiError when the server responds with an error.
   * @throws NetworkError when the request fails to reach the server.
   */
  async listAttachments(cardId: string): Promise<AttachmentResponse[]> {
    const url = this.buildUrl(`/cards/${encodeURIComponent(cardId)}/attachments`);
    return this.request(() => this.getHttpClient().get<AttachmentResponse[]>(url));
  }

  // --- Timeline Operations ---

  /**
   * Gets timeline entries for a card with optional pagination.
   *
   * @param cardId - Identifier of the card whose timeline entries should be returned.
   * @param options - Optional pagination controls.
   * @returns Promise resolving to timeline entries.
   * @throws ApiError when the server responds with an error.
   * @throws NetworkError when the request fails to reach the server.
   */
  async getTimeline(cardId: string, options?: TimelineOptions): Promise<TimelineItem[]> {
    const url = this.buildUrl(`/cards/${encodeURIComponent(cardId)}/timeline`, {
      before: options?.before,
      limit: options?.limit
    });
    return this.request(() => this.getHttpClient().get<TimelineItem[]>(url));
  }

  // --- Plan Operations ---

  /**
   * Gets the plan document for a card as markdown.
   *
   * @param cardId - Identifier of the card whose plan markdown should be returned.
   * @returns Promise resolving to plan markdown.
   * @throws ApiError when the server responds with an error.
   * @throws NetworkError when the request fails to reach the server.
   */
  /**
   * Writes a file to a card repository.
   *
   * @param cardId - Identifier of the card whose repository should receive the file.
   * @param filePath - Relative path within the card repo (e.g. `PLAN.md`, `foo/BAR.md`; will be URL-encoded).
   * @param content - File content to write.
   * @returns Promise resolving when the file is saved.
   * @throws ApiError when the server rejects the write.
   * @throws NetworkError when the request fails to reach the server.
   */
  async putFile(cardId: string, filePath: string, content: string): Promise<void> {
    const url = this.buildUrl(`/cards/${encodeURIComponent(cardId)}/fs/${encodeURIComponent(filePath)}`);
    return this.request(() => this.getHttpClient().put<void>(url, content));
  }

  // --- Gate Operations ---

  /**
   * Approves a gate for a card.
   *
   * @param cardId - Identifier of the card whose gate state should be updated.
   * @param gateName - Gate name to approve.
   * @returns Promise resolving to gate approval metadata.
   * @throws ApiError when the server rejects the approval.
   * @throws NetworkError when the request fails to reach the server.
   * @deprecated Use direct git operations instead. This endpoint will be removed.
   */
  async approveGate(cardId: string, gateName: 'plan' | 'mergeRequest'): Promise<GateApprovalResponse> {
    const url = this.buildUrl(`/cards/${encodeURIComponent(cardId)}/gates/${encodeURIComponent(gateName)}/approve`);
    return this.request(() => this.getHttpClient().post<GateApprovalResponse>(url, undefined));
  }

  // --- Branch Operations ---

  /**
   * Gets all branches tracked on a card.
   *
   * @param cardId - Unique identifier of the card whose branches to retrieve.
   * @param options - Optional query parameters.
   * @param options.workspacePath - Workspace path for computing isMerged and commit containment.
   * @returns Promise resolving to branches response.
   */
  async getBranches(cardId: string, options?: { workspacePath?: string }): Promise<BranchesResponse> {
    const url = this.buildUrl(`/cards/${encodeURIComponent(cardId)}/branches`, {
      workspacePath: options?.workspacePath
    });
    return this.request(() => this.getHttpClient().get<BranchesResponse>(url));
  }

  /**
   * Adds a branch to a card.
   *
   * @param cardId - Unique identifier of the card to add the branch to.
   * @param data - Branch data including name and optional worktree path.
   * @param options - Optional parameters.
   * @param options.sessionId - Claude Code session ID forwarded as `X-Cards-Session-Id` header so the card repo post-commit hook can attribute the commit.
   * @returns Promise resolving when the branch is added.
   */
  async addBranch(
    cardId: string,
    data: AddBranchRequest,
    options?: { sessionId?: string }
  ): Promise<AddBranchResponse> {
    const url = this.buildUrl(`/cards/${encodeURIComponent(cardId)}/branches`);
    const headers: Record<string, string> = {};
    if (options?.sessionId) {
      headers['X-Cards-Session-Id'] = options.sessionId;
    }
    return this.request(() => this.getHttpClient().post<AddBranchResponse>(url, data, { headers }), false);
  }

  /**
   * Removes a branch from a card.
   *
   * @param cardId - Unique identifier of the card to remove the branch from.
   * @param name - Branch name to remove (will be URL-encoded).
   * @param options - Optional parameters.
   * @param options.sessionId - Claude Code session ID forwarded as `X-Cards-Session-Id` header so the card repo post-commit hook can attribute the commit.
   * @param options.expectedRevision - Delete only the registration with this opaque revision; preserve a newer registration.
   * @returns Promise resolving when the branch is removed.
   */
  async removeBranch(
    cardId: string,
    name: string,
    options?: { sessionId?: string; expectedRevision?: string }
  ): Promise<RemoveBranchResponse> {
    const url = this.buildUrl(`/cards/${encodeURIComponent(cardId)}/branches/${encodeURIComponent(name)}`, {
      expectedRevision: options?.expectedRevision
    });
    const headers: Record<string, string> = {};
    if (options?.sessionId) {
      headers['X-Cards-Session-Id'] = options.sessionId;
    }
    return this.request(() => this.getHttpClient().delete<RemoveBranchResponse>(url, { headers }));
  }

  // --- Tag Operations ---

  /**
   * Gets all available tags.
   *
   * @returns Promise resolving to tag strings.
   * @throws ApiError when the server responds with an error.
   * @throws NetworkError when the request fails to reach the server.
   */
  async getTags(): Promise<string[]> {
    const url = this.buildUrl('/tags', {
      workspacePath: this.options.workspacePath
    });
    return this.request(() => this.getHttpClient().get<string[]>(url));
  }

  // --- Environment Operations ---

  /**
   * Fetches available agent environments.
   *
   * @returns Promise resolving to environment metadata.
   * @throws ApiError when the server responds with an error.
   * @throws NetworkError when the request fails to reach the server.
   */
  async getEnvironments(): Promise<EnvironmentsResponse> {
    const url = this.buildUrl('/environments', {
      workspacePath: this.options.workspacePath
    });
    return this.request(() => this.getHttpClient().get<EnvironmentsResponse>(url));
  }

  /**
   * Lists safe summaries of variable groups configured for this workspace.
   *
   * @returns Promise resolving to variable-group summaries.
   */
  async listVariableGroups(): Promise<VariableGroupsResponse> {
    const url = this.buildUrl('/variable-groups', {
      workspacePath: this.options.workspacePath
    });
    return this.request(() => this.getHttpClient().get<VariableGroupsResponse>(url));
  }

  // --- Stream Operations ---

  /**
   * Lists all streams attached to a card, sorted by creation time.
   *
   * @param cardId - Card ID to query.
   * @returns Stream metadata array (may be empty).
   * @throws ApiError when the server responds with an error (e.g., 404 for unknown card).
   * @throws NetworkError when the request fails to reach the server.
   */
  async listStreams(cardId: string): Promise<StreamMeta[]> {
    const url = this.buildUrl(`/cards/${encodeURIComponent(cardId)}/streams`);
    return this.request(() => this.getHttpClient().get<StreamMeta[]>(url));
  }

  /**
   * Retrieves a stream's metadata and raw lines.
   *
   * The `streamType` and each segment of `relPath` are URI-encoded
   * automatically; forward slashes in `relPath` remain literal path
   * separators. For completed streams the returned `lines` array is the full
   * content; for active streams it is a snapshot that may grow while the
   * caller processes it.
   *
   * When `tail` is provided, only the last `tail` lines are returned; the
   * `meta.lineCount` still reflects the full stream length so the caller can tell
   * whether earlier content exists. Use this for compact previews that render
   * only a handful of trailing lines, and omit it (or call again without it) to
   * fetch the full transcript on expand.
   *
   * @param cardId - Identifier of the card that owns the requested stream.
   * @param streamType - Stream type key (e.g., `"claude-code-session"`).
   * @param relPath - Stream's source-relative path (forward slashes, may contain
   *   multiple segments, e.g. `"session-abc/subagents/foo.jsonl"`).
   * @param tail - When set to a positive integer, return only the last `tail` lines.
   * @returns Metadata and content lines.
   * @throws ApiError on 404 (unknown card or stream) or other server errors.
   * @throws NetworkError when the request fails to reach the server.
   */
  async getStream(
    cardId: string,
    streamType: string,
    relPath: string,
    tail?: number
  ): Promise<{ meta: StreamMeta; lines: string[] }> {
    const encodedRelPath = relPath.split('/').map(encodeURIComponent).join('/');
    const url = this.buildUrl(
      `/cards/${encodeURIComponent(cardId)}/streams/${encodeURIComponent(streamType)}/${encodedRelPath}`,
      tail !== undefined ? { tail } : undefined
    );
    return this.request(() => this.getHttpClient().get<{ meta: StreamMeta; lines: string[] }>(url));
  }

  // --- Compare Operations ---

  /**
   * Sets or replaces the active comparison on the server.
   *
   * @param request - Compare request specifying the comparison mode.
   * @returns Promise resolving to the resulting compare state.
   */
  async setCompare(request: CompareRequest): Promise<CompareState> {
    const url = this.buildUrl('/compare');
    return this.request(() => this.getHttpClient().post<CompareState>(url, request));
  }

  /**
   * Returns the current compare state, or null if no comparison is active.
   *
   * The server returns 204 when no comparison is active, which this method
   * maps to null rather than throwing.
   *
   * @returns Promise resolving to the current compare state, or null if none active.
   */
  async getCompare(): Promise<CompareState | null> {
    const url = this.buildUrl('/compare');
    return this.request(async () => {
      const response = await this.fetchWithUrlContext(url, {
        headers: this.getHeaders() as Record<string, string>,
        signal: this.getTimeoutSignal()
      });
      if (response.status === 204) {
        return null;
      }
      if (!response.ok) throw response;
      return response.json() as Promise<CompareState>;
    });
  }

  /**
   * Clears the active comparison on the server.
   *
   * @returns Promise resolving when the comparison is cleared.
   */
  async clearCompare(): Promise<void> {
    const url = this.buildUrl('/compare');
    return this.request(() => this.getHttpClient().delete(url));
  }
}
