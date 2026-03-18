#!/usr/bin/env node
import { Command } from "commander";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { Database } from "./db/database.js";
import { DaemonRunner } from "./daemon-runner.js";
import { JulesApiHttpClient } from "./api/jules-api-http-client.js";

const JULES_DIR = path.join(os.homedir(), ".jules-daemon");
if (!fs.existsSync(JULES_DIR)) {
  fs.mkdirSync(JULES_DIR, { recursive: true });
}

const PID_FILE = path.join(JULES_DIR, "daemon.pid");
const DB_FILE = path.join(JULES_DIR, "jules-daemon.sqlite");
const OUT_LOG = path.join(JULES_DIR, "daemon.out.log");
const ERR_LOG = path.join(JULES_DIR, "daemon.err.log");

const program = new Command();

program
  .name("jules-daemon")
  .description("Jules Daemon CLI for managing autonomous orchestration")
  .version("0.1.0");

program
  .command("start")
  .description("Start the daemon process (foreground or background)")
  .option("-b, --background", "Run in background (detached)")
  .action(async (options) => {
    if (fs.existsSync(PID_FILE)) {
      console.error(`Daemon already running (pid file exists: ${PID_FILE}).`);
      process.exit(1);
    }

    if (options.background) {
      console.log("Starting daemon in background...");
      const out = fs.openSync(OUT_LOG, "a");
      const err = fs.openSync(ERR_LOG, "a");

      // Use tsx if running from source, node if running from dist
      // If we are invoking from tsx npx, process.argv[0] could just be node.
      const isTs = process.argv[1]?.endsWith(".ts");
      const args = isTs ? [path.resolve(process.cwd(), "node_modules/.bin/tsx"), process.argv[1]!, "start"] : [process.argv[0]!, process.argv[1]!, "start"];

      const child = spawn(args[0], args.slice(1), {
        detached: true,
        stdio: ["ignore", out, err],
      });

      child.unref();
      console.log(`Daemon spawned with pid ${child.pid}. It will write its own pid file.`);
      process.exit(0);
    } else {
      console.log("Starting daemon in foreground...");
      fs.writeFileSync(PID_FILE, process.pid.toString(), "utf-8");

      try {
        const db = await Database.open(DB_FILE);
        const api = new JulesApiHttpClient({ token: process.env.JULES_API_TOKEN ?? "dummy-token" });
        const runner = new DaemonRunner(db, api);

        runner.start();

        const shutdown = () => {
          console.log("\nShutting down daemon gracefully...");
          runner.stop();
          if (fs.existsSync(PID_FILE)) {
            fs.unlinkSync(PID_FILE);
          }
          process.exit(0);
        };

        process.on("SIGINT", shutdown);
        process.on("SIGTERM", shutdown);

      } catch (err) {
        console.error("Failed to start daemon:", err);
        if (fs.existsSync(PID_FILE)) {
          fs.unlinkSync(PID_FILE);
        }
        process.exit(1);
      }
    }
  });

program
  .command("stop")
  .description("Graceful shutdown")
  .action(async () => {
    if (!fs.existsSync(PID_FILE)) {
      console.log("No daemon is currently running (no pid file found).");
      return;
    }

    const pidStr = fs.readFileSync(PID_FILE, "utf-8").trim();
    const pid = parseInt(pidStr, 10);

    if (isNaN(pid)) {
      console.error(`Invalid pid file content: ${pidStr}`);
      return;
    }

    console.log(`Sending SIGTERM to daemon process ${pid}...`);
    try {
      process.kill(pid, "SIGTERM");
      console.log("Shutdown signal sent successfully.");
    } catch (err: any) {
      if (err.code === "ESRCH") {
        console.warn(`Process ${pid} not found. Cleaning up stale pid file.`);
        fs.unlinkSync(PID_FILE);
      } else {
        console.error(`Failed to kill process ${pid}:`, err);
      }
    }
  });

program
  .command("status")
  .description("Show running state, tracked sessions, heartbeat health")
  .action(async () => {
    let running = false;
    if (fs.existsSync(PID_FILE)) {
      const pidStr = fs.readFileSync(PID_FILE, "utf-8").trim();
      const pid = parseInt(pidStr, 10);
      try {
        process.kill(pid, 0); // test signal
        running = true;
      } catch (e) {
        // Not running
      }
    }

    console.log("-----------------------------------------");
    console.log(`Daemon Status:  ${running ? "\x1b[32mRUNNING\x1b[0m" : "\x1b[31mSTOPPED\x1b[0m"}`);
    if (running) {
      console.log(`PID File:       ${PID_FILE}`);
    }
    console.log(`Database:       ${DB_FILE}`);
    console.log("-----------------------------------------");

    if (!fs.existsSync(DB_FILE)) {
      console.log("No database file found. Run 'start' to initialize.");
      return;
    }

    const db = await Database.open(DB_FILE);

    const runningTasks = db.getRunningTaskCount();
    console.log(`Active Tracked Sessions (RUNNING): ${runningTasks}`);

    const agents = (db as any).db.exec("SELECT agent_id, status, last_heartbeat_at FROM agents");
    if (agents.length === 0 || agents[0].values.length === 0) {
      console.log("\nNo connected agents.");
    } else {
      console.log("\nAgent Heartbeats:");
      for (const row of agents[0].values) {
        console.log(`  Agent: ${row[0]} | Status: ${row[1]} | Last Heartbeat: ${row[2]}`);
      }
    }

    db.close();
  });

program
  .command("summary")
  .description("2-hour check-in view: completed, running, escalations")
  .action(async () => {
    if (!fs.existsSync(DB_FILE)) {
      console.log("No database file found. Run 'start' to initialize.");
      return;
    }

    const db = await Database.open(DB_FILE);
    const summary = db.getSummary();

    console.log("-----------------------------------------");
    console.log("            DAEMON SUMMARY               ");
    console.log("-----------------------------------------");
    console.log("\nStories:");
    const stories = summary.stories as Record<string, number>;
    console.log(`  OPEN:        ${stories.OPEN || 0}`);
    console.log(`  IN_PROGRESS: ${stories.IN_PROGRESS || 0}`);
    console.log(`  DONE:        ${stories.DONE || 0}`);

    console.log("\nTasks:");
    console.log(`  PENDING:     ${summary.PENDING || 0}`);
    console.log(`  RUNNING:     ${summary.RUNNING || 0}`);
    console.log(`  DONE:        ${summary.DONE || 0}`);
    console.log(`  FAILED:      ${summary.FAILED || 0}`);
    console.log(`  BLOCKED:     ${summary.BLOCKED || 0}`);

    console.log(`\nEscalations:   ${summary.ESCALATED || 0}`);
    console.log("-----------------------------------------");

    db.close();
  });

program.parseAsync(process.argv).catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
