import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import firstmateRustCache from "../extensions/firstmate-rust-cache.mjs";
import { finishExecution, prepareExecution } from "../lib/core.mjs";
import { cli, createProject, makeEnvironment, REPO_ROOT, run, temporaryRoot, writeExecutable } from "./helpers.mjs";

function fakePi() {
  const events = new Map();
  const tools = [];
  const commands = new Map();
  return {
    events,
    tools,
    commands,
    api: {
      on(name, handler) {
        events.set(name, handler);
      },
      registerTool(tool) {
        tools.push(tool);
      },
      registerCommand(name, command) {
        commands.set(name, command);
      },
    },
  };
}

function fakeContext(cwd) {
  return {
    cwd,
    ui: {
      setStatus() {},
      notify() {},
    },
    async reload() {},
  };
}

test("installation is inert until an explicit project/workload selection exists", async () => {
  const root = await temporaryRoot("default off");
  try {
    const project = await createProject(root, "project with spaces", "git@github.com:example/default-off.git");
    const env = await makeEnvironment(root, null);
    const previous = { ...process.env };
    Object.assign(process.env, env);
    try {
      const harness = fakePi();
      firstmateRustCache(harness.api);
      assert.equal(harness.commands.has("rust-cache"), true);
      assert.equal(harness.tools.length, 0);
      await harness.events.get("session_start")({}, fakeContext(project));
      assert.equal(harness.tools.length, 0, "disabled package must not override Pi bash");
    } finally {
      for (const key of Object.keys(process.env)) {
        if (!(key in previous)) delete process.env[key];
      }
      Object.assign(process.env, previous);
    }

    await assert.rejects(readFile(env.FIRSTMATE_RUST_CACHE_CONFIG_DIR), { code: "ENOENT" });
    await assert.rejects(readFile(env.FIRSTMATE_RUST_CACHE_CACHE_DIR), { code: "ENOENT" });

    const result = await cli(["status", "--project", project, "--json"], project, env);
    assert.equal(result.code, 0, result.stderr);
    const status = JSON.parse(result.stdout);
    assert.equal(status.state, "disabled");
    assert.equal(status.reason, "not-configured");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("unsupported platforms run selected Cargo builds ordinarily without cache state", { skip: process.platform === "linux" }, async () => {
  const root = await temporaryRoot("platform fallback");
  try {
    const project = await createProject(root, "selected", "git@github.com:example/platform-fallback.git");
    const backend = join(root, "sccache");
    await writeExecutable(backend, "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo 'sccache 0.17.0'; fi\n");
    const env = await makeEnvironment(root, backend);
    let result = await cli(["enable", "--project", project, "--max-size", "8MiB"], project, env);
    assert.equal(result.code, 0, result.stderr);

    result = await cli(["status", "--project", project, "--json"], project, env);
    assert.equal(result.code, 0, result.stderr);
    const activation = JSON.parse(result.stdout);
    assert.equal(activation.state, "bypass");
    assert.equal(activation.reason, "unsupported-platform");

    result = await cli(["run", "--", "cargo", "build", "--lib"], project, env);
    assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /unsupported-platform/);
    await stat(join(project, "target", "debug"));
    await assert.rejects(stat(env.FIRSTMATE_RUST_CACHE_CACHE_DIR), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an unselected Pi session leaves expired selected cache state untouched", { skip: process.platform !== "linux" }, async () => {
  const root = await temporaryRoot("unselected session");
  try {
    const selected = await createProject(root, "selected", "git@github.com:example/selected.git");
    const unselected = await createProject(root, "unselected", "git@github.com:example/unselected.git");
    const backend = join(root, "sccache");
    await writeExecutable(backend, "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo 'sccache 0.17.0'; fi\n");
    const env = await makeEnvironment(root, backend);
    let result = await cli(["enable", "--project", selected, "--max-size", "8MiB", "--retention-days", "1"], selected, env);
    assert.equal(result.code, 0, result.stderr);
    const plan = await prepareExecution(selected, env);
    assert.equal(plan.state, "ready");
    await finishExecution(plan);
    const state = join(env.FIRSTMATE_RUST_CACHE_CACHE_DIR, "namespaces", plan.namespace.namespaceId, "state.json");
    const value = JSON.parse(await readFile(state, "utf8"));
    value.last_used_at = "2000-01-01T00:00:00.000Z";
    await writeFile(state, `${JSON.stringify(value)}\n`, { mode: 0o600 });

    const previous = { ...process.env };
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, env);
    try {
      const harness = fakePi();
      firstmateRustCache(harness.api);
      await harness.events.get("session_start")({}, fakeContext(unselected));
    } finally {
      for (const key of Object.keys(process.env)) delete process.env[key];
      Object.assign(process.env, previous);
    }
    await stat(state);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a clean packed install exposes the CLI and remains default-off", async () => {
  const root = await temporaryRoot("packed install");
  try {
    const pack = await run("npm", ["pack", "--json", "--pack-destination", root], {
      cwd: REPO_ROOT,
      env: process.env,
    });
    assert.equal(pack.code, 0, pack.stderr);
    const tarball = join(root, JSON.parse(pack.stdout)[0].filename);
    const prefix = join(root, "installed package");
    const install = await run(
      "npm",
      ["install", "--ignore-scripts", "--legacy-peer-deps", "--prefix", prefix, tarball],
      { cwd: root, env: process.env },
    );
    assert.equal(install.code, 0, install.stderr);
    const project = await createProject(root, "packed project", "git@github.com:example/packed.git");
    const env = await makeEnvironment(root, null);
    const executable = join(prefix, "node_modules", ".bin", "firstmate-rust-cache");
    const result = await run(executable, ["status", "--project", project, "--json"], {
      cwd: project,
      env,
    });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).state, "disabled");
    await assert.rejects(readFile(join(env.FIRSTMATE_RUST_CACHE_CONFIG_DIR, "config.json")), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Pi 0.84 loads the local package contract without a provider or LLM call", async (t) => {
  const pi = process.env.PATH?.split(":").map((path) => join(path, "pi"));
  let piPath = null;
  for (const candidate of pi || []) {
    try {
      await access(candidate);
      piPath = candidate;
      break;
    } catch {
      // Continue.
    }
  }
  if (!piPath) {
    t.skip("pi executable is unavailable");
    return;
  }

  const root = await temporaryRoot("pi rpc");
  try {
    const project = await createProject(root, "rpc project", "https://github.com/example/rpc-load.git");
    const agentDir = join(root, "pi agent");
    await mkdir(agentDir, { recursive: true });
    await writeFile(join(agentDir, "settings.json"), `${JSON.stringify({ packages: [REPO_ROOT] }, null, 2)}\n`);
    const env = {
      ...process.env,
      PI_CODING_AGENT_DIR: agentDir,
      PI_OFFLINE: "1",
      PI_SKIP_VERSION_CHECK: "1",
      FIRSTMATE_RUST_CACHE_CONFIG_DIR: join(root, "config"),
      FIRSTMATE_RUST_CACHE_CACHE_DIR: join(root, "cache"),
      FIRSTMATE_RUST_CACHE_SCCACHE: join(root, "missing"),
    };
    const child = spawn(piPath, ["--mode", "rpc", "--no-session"], {
      cwd: project,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let buffer = "";
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const response = new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => rejectPromise(new Error(`Pi RPC timed out: ${stderr}`)), 15_000);
      child.stdout.on("data", (chunk) => {
        buffer += chunk;
        while (buffer.includes("\n")) {
          const index = buffer.indexOf("\n");
          const line = buffer.slice(0, index);
          buffer = buffer.slice(index + 1);
          if (!line) continue;
          const value = JSON.parse(line);
          if (value.type === "response" && value.command === "get_commands") {
            clearTimeout(timer);
            resolvePromise(value);
          }
        }
      });
      child.on("error", rejectPromise);
      child.on("exit", (code) => {
        if (code !== null && code !== 0) rejectPromise(new Error(`Pi exited ${code}: ${stderr}`));
      });
    });
    child.stdin.write(`${JSON.stringify({ type: "get_commands" })}\n`);
    const value = await response;
    child.kill("SIGTERM");
    assert.equal(value.success, true);
    assert.equal(value.data.commands.some((command) => command.name === "rust-cache"), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
