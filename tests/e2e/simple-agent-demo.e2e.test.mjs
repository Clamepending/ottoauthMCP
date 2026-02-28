import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { describe, it, expect } from "vitest";
import { startMockOttoauth } from "../helpers.mjs";

const demoAgentScript = "/Users/mark/Desktop/projects/autoauth/scripts/demo-agent.mjs";

function runNode(args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn("node", args, {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });

    child.on("close", (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

describe("simple-agent e2e (autoauth demo-agent)", () => {
  it("initializes creds and starts a run against Ottoauth-like API", async () => {
    const mock = await startMockOttoauth({
      handlers: {
        "POST /api/agents/create": (_req, body) => ({
          username: body.username,
          privateKey: "pk_test_123",
        }),
        "POST /api/computeruse/runs": (_req, body) => ({
          run_id: "run_demo_1",
          status: "queued",
          accepted_prompt: body.task_prompt,
          username: body.username,
        }),
      },
    });

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ottoauthmcp-demo-agent-"));
    const credsPath = path.join(tmpDir, "creds.json");

    try {
      const init = await runNode([demoAgentScript, "init", "demoagent"], {
        OTTOAUTH_BASE_URL: mock.baseUrl,
        OTTOAUTH_DEMO_CREDS: credsPath,
      });

      expect(init.code).toBe(0);
      const initOut = JSON.parse(init.stdout);
      expect(initOut.ok).toBe(true);
      expect(initOut.username).toBe("demoagent");

      const run = await runNode([demoAgentScript, "run", "Open https://example.com"], {
        OTTOAUTH_BASE_URL: mock.baseUrl,
        OTTOAUTH_DEMO_CREDS: credsPath,
        OTTOAUTH_DEVICE_ID: "local-device-1",
      });

      expect(run.code).toBe(0);
      const runOut = JSON.parse(run.stdout);
      expect(runOut.run_id).toBe("run_demo_1");
      expect(runOut.status).toBe("queued");
      expect(runOut.accepted_prompt).toContain("Open https://example.com");
    } finally {
      await mock.close();
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("fails clearly when demo-agent creds are missing", async () => {
    const mock = await startMockOttoauth();
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ottoauthmcp-demo-agent-"));
    const credsPath = path.join(tmpDir, "missing.json");

    try {
      const run = await runNode([demoAgentScript, "run", "task"], {
        OTTOAUTH_BASE_URL: mock.baseUrl,
        OTTOAUTH_DEMO_CREDS: credsPath,
      });

      expect(run.code).toBe(1);
      expect(run.stderr).toMatch(/No credentials found/);
    } finally {
      await mock.close();
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
