import { JulesSession, JulesSessionSchema } from "@jules-daemon/contracts";
import { CreateSessionParams, JulesApiClient } from "./jules-api-client.js";

interface HttpClientOptions {
  token: string;
  baseUrl?: string;
}

/**
 * HTTP implementation of the JulesApiClient interface that calls the Google Jules API.
 * Handles auth, retries with exponential backoff, and response validation.
 *
 * // TODO: verify against actual Jules API docs when available
 */
export class JulesApiHttpClient implements JulesApiClient {
  private readonly token: string;
  private readonly baseUrl: string;

  constructor(options: HttpClientOptions) {
    this.token = options.token;
    this.baseUrl = options.baseUrl ?? "https://jules.google.com/api/v1";
  }

  /**
   * Helper method to perform a fetch with exponential backoff retries.
   * Retries on 429, 500, 502, 503, 504. Max 3 retries.
   */
  private async fetchWithRetry(
    endpoint: string,
    options: RequestInit = {}
  ): Promise<Response> {
    const url = `${this.baseUrl}${endpoint}`;
    const headers = new Headers(options.headers);
    headers.set("Authorization", `Bearer ${this.token}`);

    // Default Content-Type to application/json if sending a body
    if (options.body && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }

    const fetchOptions: RequestInit = {
      ...options,
      headers,
    };

    let attempt = 0;
    const maxRetries = 3;
    let delayMs = 1000;

    while (attempt <= maxRetries) {
      try {
        const response = await fetch(url, fetchOptions);

        if (!response.ok) {
          const isRetryable =
            response.status === 429 ||
            (response.status >= 500 && response.status <= 504);

          if (isRetryable && attempt < maxRetries) {
            attempt++;
            await new Promise((resolve) => setTimeout(resolve, delayMs));
            delayMs *= 2; // Exponential backoff
            continue;
          }

          // If not retryable or max retries reached, throw an error
          const errorText = await response.text().catch(() => "Unknown error");
          throw new Error(
            `Jules API Error: ${response.status} ${response.statusText} - ${errorText}`
          );
        }

        return response;
      } catch (error: any) {
        // Only retry on network errors (fetch throws on network failure)
        if (attempt < maxRetries && error.name === "TypeError") {
          attempt++;
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          delayMs *= 2;
          continue;
        }
        throw error;
      }
    }

    throw new Error("Unreachable");
  }

  /**
   * Create a new Jules session and return its ID.
   * // TODO: verify against actual Jules API docs (endpoint and payload structure)
   */
  async createSession(params: CreateSessionParams): Promise<string> {
    const response = await this.fetchWithRetry("/sessions", {
      method: "POST",
      body: JSON.stringify(params),
    });

    const data = await response.json() as { session_id?: string };
    // Assuming the API returns an object with a session_id field or similar
    // TODO: update based on actual response format
    if (!data || !data.session_id) {
      throw new Error(`Failed to create session, unexpected response format: ${JSON.stringify(data)}`);
    }

    return data.session_id;
  }

  /**
   * Fetch the current state of a single session.
   * // TODO: verify against actual Jules API docs (endpoint and response structure)
   */
  async getSession(sessionId: string): Promise<JulesSession> {
    const response = await this.fetchWithRetry(`/sessions/${sessionId}`, {
      method: "GET",
    });

    const data = await response.json();

    // Assuming the API returns the session object directly, or unwrap if needed.
    // TODO: verify exact response nesting (e.g., data.session vs data)
    try {
      return JulesSessionSchema.parse(data);
    } catch (error) {
      throw new Error(`Failed to parse session data for ${sessionId}: ${error}`);
    }
  }

  /**
   * Approve a plan for a session awaiting user feedback.
   * // TODO: verify against actual Jules API docs (endpoint and payload structure)
   */
  async approvePlan(sessionId: string): Promise<void> {
    await this.fetchWithRetry(`/sessions/${sessionId}/approve`, {
      method: "POST",
    });
  }

  /**
   * Send a free-form message to a session.
   * // TODO: verify against actual Jules API docs (endpoint and payload structure)
   */
  async sendMessage(sessionId: string, message: string): Promise<void> {
    await this.fetchWithRetry(`/sessions/${sessionId}/messages`, {
      method: "POST",
      body: JSON.stringify({ message }),
    });
  }

  /**
   * Extract PR details from a completed session.
   * By default, we might just inspect the session state, or the API might have an endpoint.
   * Here we implement a best-guess by fetching the session and reading the pr_url field.
   * // TODO: verify against actual Jules API docs
   */
  async extractPr(sessionId: string): Promise<{ pr_url: string } | null> {
    const session = await this.getSession(sessionId);

    if (session.pr_url) {
      return { pr_url: session.pr_url };
    }

    return null;
  }
}
