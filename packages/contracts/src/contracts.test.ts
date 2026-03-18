import { describe, it, expect } from "vitest";
import {
  EventV1Schema,
  TaskV1Schema,
  TaskStatus,
  StoryV1Schema,
  AgentV1Schema,
  JulesSessionSchema,
  JulesSessionState,
} from "./index.js";

const NOW = "2026-03-18T09:00:00.000Z";

describe("EventV1Schema", () => {
  it("parses a valid event", () => {
    const result = EventV1Schema.parse({
      event_id: "evt_1",
      event_type: "completed",
      session_id: "sessions/abc",
      task_id: "t1",
      story_id: "s1",
      project_id: "p1",
      owner_agent_id: "a1",
      severity: "info",
      requires: "auto",
      summary: "Session completed",
      observed_at: NOW,
    });
    expect(result.event_type).toBe("completed");
  });

  it("accepts optional context_ref", () => {
    const result = EventV1Schema.parse({
      event_id: "evt_1",
      event_type: "question",
      session_id: "sessions/abc",
      task_id: "t1",
      story_id: "s1",
      project_id: "p1",
      owner_agent_id: "a1",
      severity: "warning",
      requires: "agent",
      summary: "Needs input",
      context_ref: "logs/abc.json",
      observed_at: NOW,
    });
    expect(result.context_ref).toBe("logs/abc.json");
  });

  it("rejects invalid event_type", () => {
    expect(() =>
      EventV1Schema.parse({
        event_id: "evt_1",
        event_type: "invalid",
        session_id: "s",
        task_id: "t",
        story_id: "s",
        project_id: "p",
        owner_agent_id: "a",
        severity: "info",
        requires: "auto",
        summary: "x",
        observed_at: NOW,
      }),
    ).toThrow();
  });

  it("rejects invalid severity", () => {
    expect(() =>
      EventV1Schema.parse({
        event_id: "evt_1",
        event_type: "completed",
        session_id: "s",
        task_id: "t",
        story_id: "s",
        project_id: "p",
        owner_agent_id: "a",
        severity: "low",
        requires: "auto",
        summary: "x",
        observed_at: NOW,
      }),
    ).toThrow();
  });

  it("rejects invalid requires", () => {
    expect(() =>
      EventV1Schema.parse({
        event_id: "evt_1",
        event_type: "completed",
        session_id: "s",
        task_id: "t",
        story_id: "s",
        project_id: "p",
        owner_agent_id: "a",
        severity: "info",
        requires: "nobody",
        summary: "x",
        observed_at: NOW,
      }),
    ).toThrow();
  });

  it("validates all event_type values", () => {
    for (const type of ["question", "completed", "failed", "stuck", "dependency_ready"]) {
      const result = EventV1Schema.parse({
        event_id: "evt_1",
        event_type: type,
        session_id: "s",
        task_id: "t",
        story_id: "s",
        project_id: "p",
        owner_agent_id: "a",
        severity: "info",
        requires: "auto",
        summary: "x",
        observed_at: NOW,
      });
      expect(result.event_type).toBe(type);
    }
  });
});

describe("TaskV1Schema", () => {
  it("parses a valid task with defaults", () => {
    const result = TaskV1Schema.parse({
      task_id: "t1",
      story_id: "s1",
      project_id: "p1",
      owner_agent_id: "a1",
      title: "Task 1",
      prompt: "Do stuff",
      status: "PENDING",
      created_at: NOW,
      updated_at: NOW,
    });
    expect(result.retry_count).toBe(0);
    expect(result.depends_on).toEqual([]);
    expect(result.session_id).toBeUndefined();
  });

  it("accepts nullable session_id", () => {
    const result = TaskV1Schema.parse({
      task_id: "t1",
      story_id: "s1",
      project_id: "p1",
      owner_agent_id: "a1",
      title: "Task 1",
      prompt: "Do stuff",
      status: "RUNNING",
      session_id: "sessions/abc",
      created_at: NOW,
      updated_at: NOW,
    });
    expect(result.session_id).toBe("sessions/abc");
  });

  it("rejects invalid status", () => {
    expect(() =>
      TaskV1Schema.parse({
        task_id: "t1",
        story_id: "s1",
        project_id: "p1",
        owner_agent_id: "a1",
        title: "Task 1",
        prompt: "Do stuff",
        status: "INVALID",
        created_at: NOW,
        updated_at: NOW,
      }),
    ).toThrow();
  });

  it("validates all TaskStatus values", () => {
    for (const s of ["PENDING", "RUNNING", "BLOCKED", "DONE", "FAILED", "ESCALATED"]) {
      expect(TaskStatus.parse(s)).toBe(s);
    }
  });
});

describe("StoryV1Schema", () => {
  it("parses a valid story", () => {
    const result = StoryV1Schema.parse({
      story_id: "s1",
      project_id: "p1",
      status: "OPEN",
      created_at: NOW,
      updated_at: NOW,
    });
    expect(result.status).toBe("OPEN");
  });

  it("rejects invalid status", () => {
    expect(() =>
      StoryV1Schema.parse({
        story_id: "s1",
        project_id: "p1",
        status: "CLOSED",
        created_at: NOW,
        updated_at: NOW,
      }),
    ).toThrow();
  });

  it("validates all status values", () => {
    for (const s of ["OPEN", "IN_PROGRESS", "DONE"]) {
      const result = StoryV1Schema.parse({
        story_id: "s1",
        project_id: "p1",
        status: s,
        created_at: NOW,
        updated_at: NOW,
      });
      expect(result.status).toBe(s);
    }
  });
});

describe("AgentV1Schema", () => {
  it("parses a valid agent", () => {
    const result = AgentV1Schema.parse({
      agent_id: "a1",
      host_id: "h1",
      project_id: "p1",
      status: "ONLINE",
      last_heartbeat_at: NOW,
    });
    expect(result.status).toBe("ONLINE");
  });

  it("rejects invalid status", () => {
    expect(() =>
      AgentV1Schema.parse({
        agent_id: "a1",
        host_id: "h1",
        project_id: "p1",
        status: "UNKNOWN",
        last_heartbeat_at: NOW,
      }),
    ).toThrow();
  });

  it("validates both status values", () => {
    for (const s of ["ONLINE", "OFFLINE"]) {
      expect(AgentV1Schema.parse({
        agent_id: "a1",
        host_id: "h1",
        project_id: "p1",
        status: s,
        last_heartbeat_at: NOW,
      }).status).toBe(s);
    }
  });
});

describe("JulesSessionSchema", () => {
  it("parses a minimal session", () => {
    const result = JulesSessionSchema.parse({
      session_id: "sessions/abc",
      state: "RUNNING",
    });
    expect(result.state).toBe("RUNNING");
    expect(result.owner).toBeUndefined();
  });

  it("parses a full session", () => {
    const result = JulesSessionSchema.parse({
      session_id: "sessions/abc",
      state: "COMPLETED",
      owner: "MikBin",
      repo: "algorithmsts",
      branch: "feat/x",
      pr_url: "https://github.com/MikBin/algorithmsts/pull/1",
      updated_at: NOW,
    });
    expect(result.pr_url).toBe("https://github.com/MikBin/algorithmsts/pull/1");
  });

  it("rejects invalid state", () => {
    expect(() =>
      JulesSessionSchema.parse({
        session_id: "sessions/abc",
        state: "UNKNOWN",
      }),
    ).toThrow();
  });

  it("validates all JulesSessionState values", () => {
    for (const s of ["STARTING", "RUNNING", "AWAITING_USER_FEEDBACK", "COMPLETED", "FAILED", "CANCELLED"]) {
      expect(JulesSessionState.parse(s)).toBe(s);
    }
  });
});
