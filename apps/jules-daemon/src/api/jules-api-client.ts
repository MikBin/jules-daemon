import type { JulesSession } from "@jules-daemon/contracts";

/**
 * Port interface for the Jules API.
 * Implementations can call the real Google Jules API or act as test doubles.
 */
export interface JulesApiClient {
  /** Fetch the current state of a single session. */
  getSession(sessionId: string): Promise<JulesSession>;

  /** Approve a plan for a session awaiting user feedback. */
  approvePlan(sessionId: string): Promise<void>;

  /** Send a free-form message to a session. */
  sendMessage(sessionId: string, message: string): Promise<void>;

  /** Extract PR details from a completed session. */
  extractPr(sessionId: string): Promise<{ pr_url: string } | null>;
}
