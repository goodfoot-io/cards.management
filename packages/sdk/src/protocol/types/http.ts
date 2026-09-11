/**
 * HTTP client interface for dependency injection.
 *
 * The protocol uses this interface so callers can swap between real network
 * clients and test doubles without changing card logic.
 *
 *
 * @summary HTTP client interface for dependency injection
 * @module types/http
 */

/**
 * HTTP client contract used by Cards V2 services.
 *
 * Implementations are expected to handle authentication internally (for
 * example, by capturing an access token in a constructor) so callers do not
 * repeat auth headers for every request.
 *
 * Errors should be surfaced by rejecting the Promise on transport failures or
 * non-2xx HTTP responses, with an Error that preserves the root cause when
 * possible.
 */
export interface HttpClient {
  /**
   * Issue a GET request and return the parsed response payload.
   *
   * @param url - Path or absolute URL understood by the implementation.
   * @param options - Request options merged with implementation defaults.
   * @returns Parsed response body.
   */
  get<T>(url: string, options?: RequestInit): Promise<T>;
  /**
   * Issue a POST request with a JSON-compatible body.
   *
   * @param url - Path or absolute URL understood by the implementation.
   * @param body - Payload to serialize or pass through to the transport.
   * @param options - Request options merged with implementation defaults.
   * @returns Parsed response body.
   */
  post<T>(url: string, body: unknown, options?: RequestInit): Promise<T>;
  /**
   * Issue a PUT request with a JSON-compatible body.
   *
   * @param url - Path or absolute URL understood by the implementation.
   * @param body - Payload to serialize or pass through to the transport.
   * @param options - Request options merged with implementation defaults.
   * @returns Parsed response body.
   */
  put<T>(url: string, body: unknown, options?: RequestInit): Promise<T>;
  /**
   * Issue a PATCH request with a JSON-compatible body.
   *
   * @param url - Path or absolute URL understood by the implementation.
   * @param body - Payload to serialize or pass through to the transport.
   * @param options - Request options merged with implementation defaults.
   * @returns Parsed response body.
   */
  patch<T>(url: string, body: unknown, options?: RequestInit): Promise<T>;
  /**
   * Issue a DELETE request and resolve when the deletion is acknowledged.
   *
   * @param url - Path or absolute URL understood by the implementation.
   * @param options - Request options merged with implementation defaults.
   */
  delete<T = void>(url: string, options?: RequestInit): Promise<T>;
}
