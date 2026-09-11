/**
 * Test utility for HTTP client mocking.
 *
 * Why: unit tests can exercise HttpClient consumers without issuing real
 * network requests.
 *
 * Behavior: records requests in order and returns preconfigured responses
 * by URL.
 *
 * Constraint: this client does not model headers, status codes, or latency;
 * it is a lightweight stub for behavioral tests only.
 *
 *
 * @summary Test utility for HTTP client mocking
 * @module test-utils/http/TestHttpClient
 */
import type { HttpClient } from '@cards.management/sdk/protocol';

/**
 * Recorded HTTP request information.
 *
 * Constraint: only captures method, URL, and body; headers and query parsing
 * are intentionally omitted.
 */
export interface RecordedRequest {
  /** HTTP method (GET, POST, PUT, PATCH, DELETE) */
  method: string;
  /** Request URL */
  url: string;
  /** Request body (for POST, PUT, PATCH) */
  body?: unknown;
}

/**
 * Test HTTP client implementation for dependency injection testing.
 *
 * Why: decouple HTTP-dependent components from real IO in tests.
 *
 * Behavior:
 * - Stores requests in order for later inspection.
 * - Returns the same object instance stored in `responses` for a URL.
 * - Returns `{}` when no response is configured.
 *
 * Constraint: responses are not deep-cloned; mutating the returned object will
 * affect subsequent reads.
 *
 * @example
 * ```typescript
 * const client = new TestHttpClient();
 *
 * // Configure responses
 * client.responses.set('/api/cards', [{ id: '1', title: 'Test' }]);
 *
 * // Use in code under test
 * const result = await client.get<Card[]>('/api/cards');
 *
 * // Inspect recorded requests
 * expect(client.requests).toHaveLength(1);
 * expect(client.requests[0].method).toBe('GET');
 *
 * // Reset between tests
 * client.reset();
 * ```
 */
export class TestHttpClient implements HttpClient {
  /**
   * All recorded HTTP requests in order.
   *
   * Behavior: this list grows with each request until cleared.
   */
  public requests: RecordedRequest[] = [];

  /**
   * Map of URL to response data.
   *
   * Behavior: the same value is returned on every request to the URL unless
   * the map entry is replaced.
   */
  public responses: Map<string, unknown> = new Map();

  /**
   * Performs a GET request.
   *
   * Behavior: records the request and returns a configured response or `{}`.
   *
   * @param url - The URL to request
   * @returns The configured response or empty object
   */
  async get<T>(url: string): Promise<T> {
    this.requests.push({ method: 'GET', url });
    return (this.responses.get(url) ?? {}) as T;
  }

  /**
   * Performs a POST request.
   *
   * Behavior: records the body as-is for later inspection.
   *
   * @param url - The URL to request
   * @param body - The request body
   * @returns The configured response or empty object
   */
  async post<T>(url: string, body: unknown): Promise<T> {
    this.requests.push({ method: 'POST', url, body });
    return (this.responses.get(url) ?? {}) as T;
  }

  /**
   * Performs a PUT request.
   *
   * @param url - The URL to request
   * @param body - The request body
   * @returns The configured response or empty object
   */
  async put<T>(url: string, body: unknown): Promise<T> {
    this.requests.push({ method: 'PUT', url, body });
    return (this.responses.get(url) ?? {}) as T;
  }

  /**
   * Performs a PATCH request.
   *
   * @param url - The URL to request
   * @param body - The request body
   * @returns The configured response or empty object
   */
  async patch<T>(url: string, body: unknown): Promise<T> {
    this.requests.push({ method: 'PATCH', url, body });
    return (this.responses.get(url) ?? {}) as T;
  }

  /**
   * Performs a DELETE request.
   *
   * Behavior: records the request and returns `void`.
   *
   * @param url - The URL to request
   * @param _options - Unused; accepted for interface compatibility.
   * @returns The configured response, if any.
   */
  async delete<T = void>(url: string, _options?: RequestInit): Promise<T> {
    this.requests.push({ method: 'DELETE', url });
    return this.responses.get(url) as T;
  }

  /**
   * Clears all recorded requests.
   */
  clearRequests(): void {
    this.requests = [];
  }

  /**
   * Clears all configured responses.
   */
  clearResponses(): void {
    this.responses.clear();
  }

  /**
   * Resets the client by clearing both requests and responses.
   */
  reset(): void {
    this.clearRequests();
    this.clearResponses();
  }
}
