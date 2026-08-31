import assert from "node:assert/strict";
import {
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import firstmateRustCache from "../extensions/firstmate-rust-cache.mjs";
import {
  CLI,
  cli,
  createProject,
  findSccache,
  makeEnvironment,
  removeTarget,
  run,
  runStreaming,
  status,
  temporaryRoot,
} from "./helpers.mjs";

function extensionHarness() {
  const events = new Map();
  const tools = [];
  const commands = new Map();
  const statuses = new Map();
  const pi = {
    on(name, handler) {
      events.set(name, handler);
    },
    registerTool(tool) {
      tools.push(tool);
    },
    registerCommand(name, command) {
      commands.set(name, command);
    },
  };
  return { pi, events, tools, commands, statuses };
}

function context(cwd, statuses) {
  return {
    cwd,
    ui: {
      setStatus(name, value) {
        statuses.set(name, value);
      },
      notify() {},
    },
    async reload() {},
  };
}

async function invokeBash(tool, cwd, command) {
  const result = await tool.execute("integration-call", { command }, undefined, undefined, { cwd });
  const text = result.content.map((item) => (item.type === "text" ? item.text : "")).join("\n");
  assert.equal(result.details?.exitCode ?? 0, 0, text);
  return result;
}

async function waitFor(predicate, timeoutMs = 5_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  throw new Error("timed out waiting for observable state");
}

function replaceProcessEnv(next) {
  const previous = { ...process.env };
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, next);
  return () => {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, previous);
  };
}

test("real Pi bash integration reuses cache and preserves every namespace/lifecycle boundary", { timeout: 120_000 }, async () => {
  const sccache = await findSccache();
  assert.ok(sccache, "sccache 0.17+ is required for the behavioral integration suite");
  const root = await temporaryRoot("real integration");
  let restore = null;
  let cleanupEnv = null;
  let cleanupProject = null;
  try {
    const env = await makeEnvironment(root, sccache);
    cleanupEnv = env;
    const projectA = await createProject(
      root,
      "project A with spaces",
      "git@github.com:example/cache-project-a.git",
      { crateName: "cache_project_a" },
    );
    cleanupProject = projectA;
    const projectB = await createProject(
      root,
      "project B with spaces",
      "https://github.com/example/cache-project-b.git",
      { crateName: "cache_project_b" },
    );
    const manifestProject = await createProject(
      projectA,
      "nested-git-repository",
      "https://github.com/example/cache-nested-project.git",
      { crateName: "cache_manifest_project" },
    );

    let result = await cli(
      ["enable", "--project", projectA, "--max-size", "96MiB", "--retention-days", "1"],
      projectA,
      env,
    );
    assert.equal(result.code, 0, result.stderr);
    result = await cli(
      ["enable", "--project", projectB, "--max-size", "96MiB", "--retention-days", "30"],
      projectB,
      env,
    );
    assert.equal(result.code, 0, result.stderr);

    restore = replaceProcessEnv(env);
    const harness = extensionHarness();
    firstmateRustCache(harness.pi);
    await harness.events.get("session_start")({}, context(projectA, harness.statuses));
    assert.equal(harness.tools.length, 1, "enabled healthy selection must install one Pi bash override");
    assert.equal(harness.tools[0].name, "bash");

    await invokeBash(harness.tools[0], projectA, "cargo build --lib");
    const firstStatus = await status(projectA, env);
    assert.ok((firstStatus.stats?.cache_misses ?? 0) >= 1, JSON.stringify(firstStatus));
    await removeTarget(projectA);
    await invokeBash(harness.tools[0], projectA, "cargo build --lib");
    const repeatStatus = await status(projectA, env);
    assert.ok(
      (repeatStatus.stats?.cache_hits ?? 0) > (firstStatus.stats?.cache_hits ?? 0),
      "a clean repeated build must produce a genuine sccache hit",
    );

    await removeTarget(projectA);
    process.env.SCCACHE_LOG = "info";
    await invokeBash(harness.tools[0], projectA, "cargo build --lib");
    delete process.env.SCCACHE_LOG;
    const conflictStatus = await status(projectA, env);
    assert.deepEqual(
      conflictStatus.stats,
      repeatStatus.stats,
      "ambient sccache configuration must bypass without touching the selected cache",
    );

    await removeTarget(projectA);
    process.env.RUSTFLAGS = "-C opt-level=1";
    const missesBeforeFlags = repeatStatus.stats.cache_misses;
    await invokeBash(harness.tools[0], projectA, "cargo build --lib");
    let separated = await status(projectA, env);
    assert.ok(separated.stats.cache_misses > missesBeforeFlags, "compiler flags must not cross-hit");
    await removeTarget(projectA);
    const hitsBeforeSameFlags = separated.stats.cache_hits;
    await invokeBash(harness.tools[0], projectA, "cargo build --lib");
    separated = await status(projectA, env);
    assert.ok(separated.stats.cache_hits > hitsBeforeSameFlags, "same compiler flags should reuse their own entry");
    delete process.env.RUSTFLAGS;

    await removeTarget(projectA);
    const missesBeforeFeature = separated.stats.cache_misses;
    await invokeBash(harness.tools[0], projectA, "cargo build --lib --features fancy");
    separated = await status(projectA, env);
    assert.ok(separated.stats.cache_misses > missesBeforeFeature, "feature cfg arguments must not cross-hit");

    await removeTarget(projectA);
    await invokeBash(harness.tools[0], projectA, "cargo build --lib");
    const beforeTarget = await status(projectA, env);
    const versionResult = await run("rustc", ["-vV"], { cwd: projectA, env });
    assert.equal(versionResult.code, 0, versionResult.stderr);
    const hostTarget = versionResult.stdout.match(/^host: (.+)$/m)?.[1];
    assert.ok(hostTarget, "rustc -vV must expose the host target");
    await invokeBash(harness.tools[0], projectA, `cargo build --lib --target ${hostTarget}`);
    const afterTarget = await status(projectA, env);
    assert.ok(
      afterTarget.stats.cache_misses > beforeTarget.stats.cache_misses,
      "an explicit target must not cross-hit the default-target entry",
    );

    const alternateToolchain = process.env.FIRSTMATE_RUST_CACHE_TEST_ALT_TOOLCHAIN || "1.85.0";
    await removeTarget(projectA);
    const beforeToolchain = await status(projectA, env);
    await invokeBash(harness.tools[0], projectA, `cargo +${alternateToolchain} build --lib`);
    const afterToolchain = await status(projectA, env);
    assert.ok(
      afterToolchain.stats.cache_misses > beforeToolchain.stats.cache_misses,
      `distinct installed Rust toolchains must not cross-hit: before=${JSON.stringify(beforeToolchain.stats)} after=${JSON.stringify(afterToolchain.stats)}`,
    );

    const contextBEnv = { ...env, FIRSTMATE_RUST_CACHE_CONTEXT: "customer-b" };
    result = await cli(
      ["enable", "--project", projectA, "--context", "customer-b", "--max-size", "32MiB"],
      projectA,
      env,
    );
    assert.equal(result.code, 0, result.stderr);
    process.env.FIRSTMATE_RUST_CACHE_CONTEXT = "customer-b";
    const contextHarness = extensionHarness();
    firstmateRustCache(contextHarness.pi);
    await contextHarness.events.get("session_start")({}, context(projectA, contextHarness.statuses));
    assert.equal(contextHarness.tools.length, 1);
    await removeTarget(projectA);
    await invokeBash(contextHarness.tools[0], projectA, "cargo build --lib");
    const contextBStatus = await status(projectA, contextBEnv);
    const contextAStatus = await status(projectA, env);
    assert.notEqual(contextBStatus.namespace, contextAStatus.namespace, "security contexts require physical namespaces");
    assert.ok((contextBStatus.stats?.cache_misses ?? 0) >= 1);
    delete process.env.FIRSTMATE_RUST_CACHE_CONTEXT;

    const harnessB = extensionHarness();
    firstmateRustCache(harnessB.pi);
    await harnessB.events.get("session_start")({}, context(projectB, harnessB.statuses));
    assert.equal(harnessB.tools.length, 1);
    await invokeBash(harnessB.tools[0], projectB, "cargo build --lib");
    const statusA = await status(projectA, env);
    const statusB = await status(projectB, env);
    assert.notEqual(statusA.namespace, statusB.namespace, "unrelated repositories require physical namespaces");
    assert.ok((statusB.stats?.cache_misses ?? 0) >= 1);
    assert.ok(statusA.cache.bytes <= statusA.cache.max_bytes, "namespace disk use must stay within its configured bound");
    assert.ok(statusB.cache.bytes <= statusB.cache.max_bytes, "namespace disk use must stay within its configured bound");

    const beforeCrossDirectoryCommand = await status(projectB, env);
    await invokeBash(harness.tools[0], projectA, `cd "${projectB}" && cargo build --lib`);
    const afterCrossDirectoryCommand = await status(projectB, env);
    assert.deepEqual(
      afterCrossDirectoryCommand.stats,
      beforeCrossDirectoryCommand.stats,
      "a shell command that changes directories must bypass the selected cache",
    );

    const beforeForeignManifest = await status(projectA, env);
    await invokeBash(harness.tools[0], projectA, "cargo build --lib --manifest-path nested-git-repository/Cargo.toml");
    const afterForeignManifest = await status(projectA, env);
    assert.deepEqual(
      afterForeignManifest.stats,
      beforeForeignManifest.stats,
      "a manifest outside the selected project must bypass the selected cache",
    );
    await stat(join(manifestProject, "target", "debug"));

    const cacheRoot = env.FIRSTMATE_RUST_CACHE_CACHE_DIR;
    const namespaceA = join(cacheRoot, "namespaces", statusA.namespace);
    const namespaceB = join(cacheRoot, "namespaces", statusB.namespace);
    await stat(namespaceA);
    await stat(namespaceB);
    await mkdir(join(env.CARGO_HOME, "registry"), { recursive: true });
    await mkdir(join(env.CARGO_HOME, "git"), { recursive: true });
    await writeFile(join(env.CARGO_HOME, "registry", "must-survive"), "registry\n");
    await writeFile(join(env.CARGO_HOME, "git", "must-survive"), "git\n");
    await writeFile(join(projectA, "target", "must-survive"), "target\n");
    const foreignState = join(root, "another extension state");
    await mkdir(foreignState, { recursive: true });
    await writeFile(join(foreignState, "must-survive"), "foreign\n");

    result = await cli(["clean", "--project", projectA], projectA, env);
    assert.equal(result.code, 0, result.stderr);
    await assert.rejects(stat(namespaceA), { code: "ENOENT" });
    await stat(namespaceB);
    assert.equal(await readFile(join(projectA, "target", "must-survive"), "utf8"), "target\n");
    assert.equal(await readFile(join(env.CARGO_HOME, "registry", "must-survive"), "utf8"), "registry\n");
    assert.equal(await readFile(join(env.CARGO_HOME, "git", "must-survive"), "utf8"), "git\n");
    assert.equal(await readFile(join(foreignState, "must-survive"), "utf8"), "foreign\n");
    result = await cli(["clean", "--project", projectA], projectA, env);
    assert.equal(result.code, 0, result.stderr, "targeted cleanup must be idempotent");

    // Two disposable paths with the same origin share only project A's namespace.
    const projectA2 = await createProject(
      root,
      "project A second disposable copy",
      "https://github.com/example/cache-project-a.git",
      { crateName: "cache_project_a" },
    );
    await removeTarget(projectA);
    const concurrent = await Promise.all([
      cli(["run", "--", "cargo", "build", "--lib"], projectA, env),
      cli(["run", "--", "cargo", "build", "--lib"], projectA2, env),
    ]);
    for (const invocation of concurrent) {
      assert.equal(invocation.code, 0, `${invocation.stdout}\n${invocation.stderr}`);
    }
    const currentA = await status(projectA, env);
    const leasesDir = join(cacheRoot, "namespaces", currentA.namespace, "leases");
    assert.deepEqual(await readdir(leasesDir), [], "concurrent commands must release every lease");

    const sleeper = runStreaming(
      process.execPath,
      [CLI, "run", "--", process.execPath, "-e", "setTimeout(()=>{}, 30000)"],
      { cwd: projectA, env },
    );
    await waitFor(async () => {
      try {
        return (await readdir(leasesDir)).length === 1;
      } catch {
        return false;
      }
    });
    sleeper.kill("SIGTERM");
    await new Promise((resolvePromise) => sleeper.on("close", resolvePromise));
    await waitFor(async () => (await readdir(leasesDir)).length === 0);
    result = await cli(["clean", "--project", projectA], projectA, env);
    assert.equal(result.code, 0, result.stderr, "cleanup after interruption must recover deterministically");

    // Recreate A, age only that persisted namespace state, and exercise retention.
    await invokeBash(harness.tools[0], projectA, "cargo build --lib");
    const aged = await status(projectA, env);
    const statePath = join(cacheRoot, "namespaces", aged.namespace, "state.json");
    const stateValue = JSON.parse(await readFile(statePath, "utf8"));
    stateValue.last_used_at = "2000-01-01T00:00:00.000Z";
    await writeFile(statePath, `${JSON.stringify(stateValue, null, 2)}\n`, { mode: 0o600 });
    result = await cli(["gc"], projectA, env);
    assert.equal(result.code, 0, result.stderr);
    await assert.rejects(stat(join(cacheRoot, "namespaces", aged.namespace)), { code: "ENOENT" });
    await stat(namespaceB);

    result = await cli(["uninstall", "--keep-cache"], projectB, env);
    assert.equal(result.code, 0, result.stderr);
    const retainedConfig = JSON.parse(
      await readFile(join(env.FIRSTMATE_RUST_CACHE_CONFIG_DIR, "config.json"), "utf8"),
    );
    assert.equal(retainedConfig.projects.every((entry) => entry.enabled === false), true);
    await stat(namespaceB);
    result = await cli(["uninstall", "--keep-cache"], projectB, env);
    assert.equal(result.code, 0, result.stderr, "preserving uninstall must be idempotent");
    result = await cli(["uninstall", "--remove-cache"], projectB, env);
    assert.equal(result.code, 0, result.stderr);
    await assert.rejects(stat(cacheRoot), { code: "ENOENT" });
    result = await cli(["run", "--", "cargo", "build", "--lib"], projectB, env);
    assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(await readFile(join(env.CARGO_HOME, "registry", "must-survive"), "utf8"), "registry\n");
    assert.equal(await readFile(join(foreignState, "must-survive"), "utf8"), "foreign\n");
  } finally {
    if (cleanupEnv && cleanupProject) {
      await cli(["uninstall", "--remove-cache"], cleanupProject, cleanupEnv).catch(() => {});
    }
    if (restore) restore();
    await rm(root, { recursive: true, force: true });
  }
});
