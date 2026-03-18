import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { CompletionHandler } from "./completion-handler.js";
import { Database } from "../db/database.js";
import type { TaskDispatcher } from "./task-dispatcher.js";

const NOW = "2026-03-18T09:00:00.000Z";

describe("CompletionHandler", () => {
  let db: Database;
  let dispatcher: TaskDispatcher;
  let handler: CompletionHandler;

  beforeEach(async () => {
    db = await Database.open(":memory:");

    // Seed initial data
    db.insertAgent({ agent_id: "a1", host_id: "h1", project_id: "p1", status: "ONLINE", last_heartbeat_at: NOW });
    db.insertStory({ story_id: "s1", project_id: "p1", status: "OPEN", created_at: NOW, updated_at: NOW });

    dispatcher = {
      dispatchForStory: vi.fn().mockResolvedValue({ dispatched: [], errors: [] }),
    } as unknown as TaskDispatcher;

    handler = new CompletionHandler(db, dispatcher, () => NOW);
  });

  afterEach(() => {
    db.close();
  });

  it("marks task as DONE, updates story to DONE if all tasks are DONE, and calls dispatchForStory", async () => {
    // Single task in story, currently RUNNING
    db.insertTask({
      task_id: "t1",
      story_id: "s1",
      project_id: "p1",
      owner_agent_id: "a1",
      title: "Task 1",
      prompt: "Do it",
      status: "RUNNING",
      session_id: "sessions/abc",
      created_at: NOW,
      updated_at: NOW,
    });

    const event = { session_id: "sessions/abc" };
    await handler.handleCompletion(event);

    const task = db.getTask("t1");
    expect(task!.status).toBe("DONE");
    expect(task!.updated_at).toBe(NOW);

    const story = db.getStory("s1");
    expect(story!.status).toBe("DONE");
    expect(story!.updated_at).toBe(NOW);

    expect(dispatcher.dispatchForStory).toHaveBeenCalledWith("s1");
  });

  it("updates story to IN_PROGRESS if there are pending tasks", async () => {
    db.insertTask({
      task_id: "t1",
      story_id: "s1",
      project_id: "p1",
      owner_agent_id: "a1",
      title: "Task 1",
      prompt: "Do it",
      status: "RUNNING",
      session_id: "sessions/abc",
      created_at: NOW,
      updated_at: NOW,
    });
    db.insertTask({
      task_id: "t2",
      story_id: "s1",
      project_id: "p1",
      owner_agent_id: "a1",
      title: "Task 2",
      prompt: "Do it later",
      status: "PENDING",
      created_at: NOW,
      updated_at: NOW,
    });

    const event = { session_id: "sessions/abc" };
    await handler.handleCompletion(event);

    const story = db.getStory("s1");
    expect(story!.status).toBe("IN_PROGRESS");
    expect(story!.updated_at).toBe(NOW);
  });

  it("does nothing if task not found for session", async () => {
    const event = { session_id: "sessions/unknown" };
    await handler.handleCompletion(event);

    expect(dispatcher.dispatchForStory).not.toHaveBeenCalled();
  });

  it("does nothing if session_id is missing from event", async () => {
    const event = {};
    await handler.handleCompletion(event);

    expect(dispatcher.dispatchForStory).not.toHaveBeenCalled();
  });
});
