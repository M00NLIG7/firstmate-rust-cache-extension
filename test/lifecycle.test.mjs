import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  finishExecution,
  getStoragePaths,
  prepareExecution,
  supportsDescriptorBoundCacheOperations,
  supportsPinnedCompilerLeases,
} from "../lib/core.mjs";
import { cli, createProject, makeEnvironment, status, temporaryRoot, writeExecutable } from "./helpers.mjs";

async function waitFor(predicate, timeoutMs = 5_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  throw new Error("timed out waiting for observable state");
}

test("enable/disable are idempotent and backend absence runs an ordinary Cargo build", async () => {
  const root = await temporaryRoot("lifecycle");
  try {
    const project = await createProject(root, "project with spaces", "https://token@example.com/org/lifecycle.git?secret=drop");
    const env = await makeEnvironment(root, null);

    let result = await cli(
      ["enable", "--project", project, "--max-size", "32MiB", "--retention-days", "7"],
      project,
      env,
    );
    assert.equal(result.code, 0, result.stderr);
    const configPath = join(env.FIRSTMATE_RUST_CACHE_CONFIG_DIR, "config.json");
    const first = await readFile(configPath, "utf8");
    assert.equal(first.includes("token"), false, "credentials must not be persisted");
    assert.equal(first.includes("secret"), false, "query data must not be persisted");

    result = await cli(
      ["enable", "--project", project, "--max-size", "32MiB", "--retention-days", "7"],
      project,
      env,
    );
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /unchanged/);
    assert.equal(await readFile(configPath, "utf8"), first, "idempotent enable must not rewrite timestamps");

    result = await cli(["run", "--", "cargo", "build", "--lib"], project, env);
    assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /running ordinary command/);
    await stat(join(project, "target", "debug"));
    await assert.rejects(stat(env.FIRSTMATE_RUST_CACHE_CACHE_DIR), { code: "ENOENT" });

    result = await cli(["disable", "--project", project], project, env);
    assert.equal(result.code, 0, result.stderr);
    result = await cli(["disable", "--project", project], project, env);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /unchanged/);

    const disabled = await status(project, env);
    assert.equal(disabled.state, "disabled");
    assert.equal(disabled.reason, "selection-disabled");

    result = await cli(["forget", "--project", project], project, env);
    assert.equal(result.code, 0, result.stderr);
    result = await cli(["forget", "--project", project], project, env);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /unchanged/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("configuration mutations reuse their private lock directory", { skip: process.platform !== "linux" }, async () => {
  const root = await temporaryRoot("configuration lock release");
  try {
    const project = await createProject(root, "project", "git@github.com:example/configuration-lock.git");
    const env = await makeEnvironment(root, null);
    const paths = getStoragePaths(env);
    for (const command of [
      ["enable", "--project", project, "--max-size", "8MiB"],
      ["disable", "--project", project],
      ["enable", "--project", project, "--max-size", "8MiB"],
    ]) {
      const result = await cli(command, project, env);
      assert.equal(result.code, 0, result.stderr);
      await stat(join(paths.configLock, "owner.json"));
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("concurrent configuration mutations retain both selections", { skip: process.platform !== "linux" }, async () => {
  const root = await temporaryRoot("concurrent configuration mutations");
  try {
    const first = await createProject(root, "first", "git@github.com:example/concurrent-first.git");
    const second = await createProject(root, "second", "git@github.com:example/concurrent-second.git");
    const env = await makeEnvironment(root, null);
    const [firstResult, secondResult] = await Promise.all([
      cli(["enable", "--project", first, "--max-size", "8MiB"], first, env),
      cli(["enable", "--project", second, "--max-size", "8MiB"], second, env),
    ]);
    assert.equal(firstResult.code, 0, firstResult.stderr);
    assert.equal(secondResult.code, 0, secondResult.stderr);
    const config = JSON.parse(await readFile(join(env.FIRSTMATE_RUST_CACHE_CONFIG_DIR, "config.json"), "utf8"));
    assert.equal(config.projects.length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("aggregate configured limits are enforced before cache state is created", async () => {
  const root = await temporaryRoot("limits");
  try {
    const env = await makeEnvironment(root, null);
    const first = await createProject(root, "first", "git@github.com:example/limit-first.git");
    const second = await createProject(root, "second", "git@github.com:example/limit-second.git");
    let result = await cli(["limits", "--max-size", "32MiB"], first, env);
    assert.equal(result.code, 0, result.stderr);
    result = await cli(["enable", "--project", first, "--max-size", "20MiB"], first, env);
    assert.equal(result.code, 0, result.stderr);
    result = await cli(["enable", "--project", second, "--max-size", "20MiB"], second, env);
    assert.equal(result.code, 2);
    assert.match(result.stderr, /above global_max_bytes/);
    result = await cli(["limits", "--max-size", "16MiB"], first, env);
    assert.equal(result.code, 2, "lowering below allocated namespaces must refuse");
    await assert.rejects(stat(env.FIRSTMATE_RUST_CACHE_CACHE_DIR), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("pinned lease support requires an accessible procfs boundary", async () => {
  const root = await temporaryRoot("procfs capability");
  try {
    assert.equal(await supportsPinnedCompilerLeases("darwin"), false);
    assert.equal(await supportsPinnedCompilerLeases("linux", join(root, "missing procfs")), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("active lease capacity bypasses excess executions and recovers after release", { skip: process.platform !== "linux" || !supportsDescriptorBoundCacheOperations() }, async () => {
  const root = await temporaryRoot("lease capacity");
  try {
    const project = await createProject(root, "project", "git@github.com:example/lease-capacity.git");
    const backend = join(root, "sccache");
    await writeExecutable(backend, "#!/bin/sh\necho 'sccache 0.17.0'\n");
    const env = await makeEnvironment(root, backend);
    const enabled = await cli(["enable", "--project", project, "--max-size", "8MiB"], project, env);
    assert.equal(enabled.code, 0, enabled.stderr);

    const executions = await Promise.all(Array.from({ length: 40 }, () => prepareExecution(project, env)));
    const ready = executions.filter((plan) => plan.state === "ready");
    const bypassed = executions.filter((plan) => plan.state === "bypass");
    assert.ok(ready.length > 0);
    assert.ok(bypassed.length > 0, "excess selected builds must bypass caching");
    assert.ok(bypassed.every((plan) => plan.reason === "lease-capacity-exhausted"));

    const leases = await readdir(ready[0].namespace.leasesDir);
    const metadataBytes = (
      await Promise.all(leases.map(async (name) => Number((await stat(join(ready[0].namespace.leasesDir, name), { bigint: true })).blocks * 512n)))
    ).reduce((total, bytes) => total + bytes, 0);
    assert.ok(metadataBytes <= 128 * 1024, "active lease metadata must stay inside its reserve");

    await Promise.all(ready.map((plan) => finishExecution(plan)));
    assert.deepEqual(await readdir(ready[0].namespace.leasesDir), []);
    const retried = await prepareExecution(project, env);
    assert.equal(retried.state, "ready");
    await finishExecution(retried);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("activation preserves namespace state when descriptor-bound operations are unavailable", { skip: supportsDescriptorBoundCacheOperations() }, async () => {
  const root = await temporaryRoot("descriptor activation");
  try {
    const project = await createProject(root, "project", "git@github.com:example/descriptor-activation.git");
    const backend = join(root, "sccache");
    await writeExecutable(backend, "#!/bin/sh\necho 'sccache 0.17.0'\n");
    const env = await makeEnvironment(root, backend);
    const result = await cli(["enable", "--project", project, "--max-size", "8MiB"], project, env);
    assert.equal(result.code, 0, result.stderr);
    const activation = await prepareExecution(project, env);
    assert.equal(supportsDescriptorBoundCacheOperations(), false);
    assert.equal(activation.state, "bypass");
    assert.equal(activation.reason, "unsupported-platform");
    await assert.rejects(stat(env.FIRSTMATE_RUST_CACHE_CACHE_DIR), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("uninstall preserves owned cache data without descriptor-bound removal", { skip: supportsDescriptorBoundCacheOperations() }, async () => {
  const root = await temporaryRoot("descriptor cleanup");
  try {
    const project = await createProject(root, "project", "git@github.com:example/descriptor-cleanup.git");
    const env = await makeEnvironment(root, null);
    let result = await cli(["enable", "--project", project, "--max-size", "8MiB"], project, env);
    assert.equal(result.code, 0, result.stderr);

    const cacheRoot = env.FIRSTMATE_RUST_CACHE_CACHE_DIR;
    await mkdir(cacheRoot, { recursive: true, mode: 0o700 });
    const identity = await stat(cacheRoot, { bigint: true });
    await writeFile(
      join(cacheRoot, ".firstmate-rust-cache-root.json"),
      `${JSON.stringify({
        schema: "firstmate-rust-cache.root.v1",
        root_id: createHash("sha256").update(resolve(cacheRoot)).digest("hex"),
        directory: { device: String(identity.dev), inode: String(identity.ino) },
      })}\n`,
      { mode: 0o600 },
    );
    await writeFile(join(cacheRoot, "must-survive"), "sentinel\n", { mode: 0o600 });

    result = await cli(["uninstall", "--remove-cache"], project, env);
    assert.equal(result.code, 2);
    assert.match(result.stderr, /descriptor-bound cleanup is unavailable/);
    assert.equal(await readFile(join(cacheRoot, "must-survive"), "utf8"), "sentinel\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("unsafe state-root overrides are refused without modifying foreign trees", async () => {
  const root = await temporaryRoot("safe cleanup");
  try {
    const project = await createProject(root, "source sentinel", "git@github.com:example/safe-clean.git");
    const env = await makeEnvironment(root, null);
    env.FIRSTMATE_RUST_CACHE_CACHE_DIR = project;
    await writeFile(join(project, "must-survive"), "sentinel\n");
    const modeBefore = (await stat(project)).mode & 0o777;
    let result = await cli(["enable", "--project", project, "--max-size", "8MiB"], project, env);
    assert.equal(result.code, 0, result.stderr);
    result = await cli(["uninstall", "--remove-cache"], project, env);
    assert.equal(result.code, 2);
    assert.match(result.stderr, /(ownership marker|state root must not be)/);
    assert.equal(await readFile(join(project, "must-survive"), "utf8"), "sentinel\n");
    assert.equal((await stat(project)).mode & 0o777, modeBefore, "refusal must not chmod a project tree");
    const foreignConfig = join(root, "credential directory");
    await mkdir(foreignConfig, { recursive: true, mode: 0o700 });
    await writeFile(join(foreignConfig, "config.json"), "credential-sentinel\n", { mode: 0o600 });
    const configEnv = { ...env, FIRSTMATE_RUST_CACHE_CONFIG_DIR: foreignConfig, FIRSTMATE_RUST_CACHE_CACHE_DIR: join(root, "safe cache") };
    result = await cli(["enable", "--project", project, "--max-size", "8MiB"], project, configEnv);
    assert.equal(result.code, 2);
    assert.match(result.stderr, /configuration root.*ownership marker/);
    assert.equal(await readFile(join(foreignConfig, "config.json"), "utf8"), "credential-sentinel\n");
    assert.deepEqual((await readdir(foreignConfig)).sort(), ["config.json"]);

    await mkdir(join(root, "another extension"), { recursive: true });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("symlinked state-root ancestors are refused before creating package state", async () => {
  const root = await temporaryRoot("symlink ancestors");
  try {
    const project = await createProject(root, "project", "git@github.com:example/symlink-parent.git");
    const foreign = join(root, "foreign state");
    const link = join(root, "state link");
    await mkdir(foreign, { recursive: true, mode: 0o700 });
    await writeFile(join(foreign, "must-survive"), "sentinel\n", { mode: 0o600 });
    await symlink(foreign, link);

    const env = await makeEnvironment(root, null);
    const backend = join(root, "sccache");
    await writeExecutable(backend, "#!/bin/sh\necho 'sccache 0.17.0'\n");
    env.FIRSTMATE_RUST_CACHE_SCCACHE = backend;
    env.FIRSTMATE_RUST_CACHE_CACHE_DIR = join(link, "cache");
    let result = await cli(["enable", "--project", project, "--max-size", "8MiB"], project, env);
    assert.equal(result.code, 0, result.stderr);
    const activation = await prepareExecution(project, env);
    assert.equal(activation.state, "bypass");
    assert.equal(activation.reason, "unsupported-platform");
    assert.equal(await readFile(join(foreign, "must-survive"), "utf8"), "sentinel\n");
    assert.deepEqual(await readdir(foreign), ["must-survive"]);

    const configEnv = {
      ...env,
      FIRSTMATE_RUST_CACHE_CONFIG_DIR: join(link, "config"),
      FIRSTMATE_RUST_CACHE_CACHE_DIR: join(root, "safe cache"),
    };
    result = await cli(["enable", "--project", project, "--max-size", "8MiB"], project, configEnv);
    assert.equal(result.code, 2);
    assert.equal(await readFile(join(foreign, "must-survive"), "utf8"), "sentinel\n");
    assert.deepEqual(await readdir(foreign), ["must-survive"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("run bypasses shell and foreign Cargo manifest commands", async () => {
  const root = await temporaryRoot("verified command");
  try {
    const first = await createProject(root, "first project", "git@github.com:example/first.git");
    const second = await createProject(root, "second project", "git@github.com:example/second.git");
    const nested = await createProject(first, "nested repository", "git@github.com:example/nested.git");
    const backend = join(root, "sccache");
    await writeExecutable(backend, "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo 'sccache 0.17.0'; exit 0; fi\nexec \"$@\"\n");
    const env = await makeEnvironment(root, backend);

    let result = await cli(["enable", "--project", first, "--max-size", "8MiB"], first, env);
    assert.equal(result.code, 0, result.stderr);

    result = await cli(["run", "--", "sh", "-c", `cd "${second}" && cargo build --lib`], first, env);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stderr, /unverified-cargo-command/);
    await stat(join(second, "target", "debug"));
    await assert.rejects(stat(env.FIRSTMATE_RUST_CACHE_CACHE_DIR), { code: "ENOENT" });

    result = await cli(
      ["run", "--", "cargo", "build", "--lib", "--manifest-path", join(second, "Cargo.toml")],
      first,
      env,
    );
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stderr, /unverified-cargo-command/);
    await assert.rejects(stat(env.FIRSTMATE_RUST_CACHE_CACHE_DIR), { code: "ENOENT" });

    result = await cli(
      ["run", "--", "cargo", "build", "--lib", "--manifest-path", join(nested, "Cargo.toml")],
      first,
      env,
    );
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stderr, /unverified-cargo-command/);
    await stat(join(nested, "target", "debug"));
    await assert.rejects(stat(env.FIRSTMATE_RUST_CACHE_CACHE_DIR), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("clean refuses a symlinked lease directory without touching foreign leases", { skip: process.platform !== "linux" || !supportsDescriptorBoundCacheOperations() }, async () => {
  const root = await temporaryRoot("lease symlink");
  try {
    const project = await createProject(root, "project", "git@github.com:example/lease-symlink.git");
    const backend = join(root, "sccache");
    await writeExecutable(backend, "#!/bin/sh\necho 'sccache 0.17.0'\n");
    const env = await makeEnvironment(root, backend);
    let result = await cli(["enable", "--project", project, "--max-size", "8MiB"], project, env);
    assert.equal(result.code, 0, result.stderr);
    const plan = await prepareExecution(project, env);
    assert.equal(plan.state, "ready");
    await finishExecution(plan);

    const foreign = join(root, "foreign leases");
    const foreignLease = join(foreign, "0123456789abcdef0123456789abcdef.json");
    await mkdir(foreign, { recursive: true, mode: 0o700 });
    await writeFile(foreignLease, '{"pid":999999}\n', { mode: 0o600 });
    await rm(plan.namespace.leasesDir, { recursive: true, force: true });
    await symlink(foreign, plan.namespace.leasesDir);

    result = await cli(["clean", "--project", project], project, env);
    assert.equal(result.code, 2);
    assert.match(result.stderr, /symlinked|unsafe-state/);
    assert.equal(await readFile(foreignLease, "utf8"), '{"pid":999999}\n');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("clean preserves a namespace when its leases directory identity changes", { skip: process.platform !== "linux" || !supportsDescriptorBoundCacheOperations() }, async () => {
  const root = await temporaryRoot("lease identity");
  try {
    const project = await createProject(root, "project", "git@github.com:example/lease-identity.git");
    const backend = join(root, "sccache");
    await writeExecutable(backend, "#!/bin/sh\necho 'sccache 0.17.0'\n");
    const env = await makeEnvironment(root, backend);
    let result = await cli(["enable", "--project", project, "--max-size", "8MiB"], project, env);
    assert.equal(result.code, 0, result.stderr);
    const plan = await prepareExecution(project, env);
    assert.equal(plan.state, "ready");

    await rename(plan.namespace.leasesDir, join(plan.namespace.namespaceDir, "retired leases"));
    await mkdir(plan.namespace.leasesDir, { mode: 0o700 });

    result = await cli(["clean", "--project", project], project, env);
    assert.equal(result.code, 2);
    assert.match(result.stderr, /leases directory identity changed/);
    await stat(plan.namespace.namespaceDir);
    await finishExecution(plan);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("clean refuses a replaced namespace without deleting either directory", { skip: process.platform !== "linux" || !supportsDescriptorBoundCacheOperations() }, async () => {
  const root = await temporaryRoot("namespace replacement");
  try {
    const project = await createProject(root, "project", "git@github.com:example/namespace-replacement.git");
    const backend = join(root, "sccache");
    await writeExecutable(backend, "#!/bin/sh\necho 'sccache 0.17.0'\n");
    const env = await makeEnvironment(root, backend);
    let result = await cli(["enable", "--project", project, "--max-size", "8MiB"], project, env);
    assert.equal(result.code, 0, result.stderr);
    const plan = await prepareExecution(project, env);
    assert.equal(plan.state, "ready");

    const preserved = join(root, "preserved namespace");
    const state = await readFile(plan.namespace.stateFile, "utf8");
    await rename(plan.namespace.namespaceDir, preserved);
    await mkdir(join(plan.namespace.namespaceDir, "leases"), { recursive: true, mode: 0o700 });
    await writeFile(plan.namespace.stateFile, state, { mode: 0o600 });
    await writeFile(join(plan.namespace.namespaceDir, "must-survive"), "replacement sentinel\n", { mode: 0o600 });

    result = await cli(["clean", "--project", project], project, env);
    assert.equal(result.code, 2);
    assert.match(result.stderr, /namespace directory identity changed/);
    assert.equal(await readFile(join(plan.namespace.namespaceDir, "must-survive"), "utf8"), "replacement sentinel\n");
    await stat(join(preserved, "leases"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("uninstall preserves a replaced cache root", { skip: process.platform !== "linux" || !supportsDescriptorBoundCacheOperations() }, async () => {
  const root = await temporaryRoot("cache root replacement");
  try {
    const project = await createProject(root, "project", "git@github.com:example/cache-root-replacement.git");
    const backend = join(root, "sccache");
    await writeExecutable(backend, "#!/bin/sh\necho 'sccache 0.17.0'\n");
    const env = await makeEnvironment(root, backend);
    let result = await cli(["enable", "--project", project, "--max-size", "8MiB"], project, env);
    assert.equal(result.code, 0, result.stderr);
    const plan = await prepareExecution(project, env);
    assert.equal(plan.state, "ready");

    const marker = await readFile(join(env.FIRSTMATE_RUST_CACHE_CACHE_DIR, ".firstmate-rust-cache-root.json"), "utf8");
    const preserved = join(root, "preserved cache");
    await rename(env.FIRSTMATE_RUST_CACHE_CACHE_DIR, preserved);
    await mkdir(env.FIRSTMATE_RUST_CACHE_CACHE_DIR, { recursive: true, mode: 0o700 });
    await writeFile(join(env.FIRSTMATE_RUST_CACHE_CACHE_DIR, ".firstmate-rust-cache-root.json"), marker, { mode: 0o600 });
    await writeFile(join(env.FIRSTMATE_RUST_CACHE_CACHE_DIR, "must-survive"), "replacement sentinel\n", { mode: 0o600 });

    result = await cli(["uninstall", "--remove-cache"], project, env);
    assert.equal(result.code, 2);
    assert.match(result.stderr, /cache root ownership marker is invalid/);
    assert.equal(
      await readFile(join(env.FIRSTMATE_RUST_CACHE_CACHE_DIR, "must-survive"), "utf8"),
      "replacement sentinel\n",
    );
    await stat(join(preserved, "namespaces"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("clean refuses a symlinked runtime ancestor without touching foreign sockets", async () => {
  const root = await temporaryRoot("runtime symlink");
  try {
    const project = await createProject(root, "project", "git@github.com:example/runtime-symlink.git");
    const foreign = join(root, "foreign runtime");
    const link = join(root, "runtime link");
    await mkdir(join(foreign, "runtime"), { recursive: true, mode: 0o700 });
    await symlink(foreign, link);
    const env = await makeEnvironment(root, null);
    env.FIRSTMATE_RUST_CACHE_RUNTIME_DIR = join(link, "runtime");
    let result = await cli(["enable", "--project", project, "--max-size", "8MiB"], project, env);
    assert.equal(result.code, 0, result.stderr);
    const selected = await status(project, env);
    const socket = join(foreign, "runtime", `${selected.namespace.slice(0, 24)}.sock`);
    await writeFile(socket, "socket sentinel\n", { mode: 0o600 });

    result = await cli(["clean", "--project", project], project, env);
    assert.equal(result.code, 2);
    assert.match(result.stderr, /symlinked|unsafe-state/);
    assert.equal(await readFile(socket, "utf8"), "socket sentinel\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a prepared activation bypasses after concurrent cache removal", { skip: process.platform !== "linux" || !supportsDescriptorBoundCacheOperations() }, async () => {
  const root = await temporaryRoot("activation race");
  try {
    const project = await createProject(root, "project", "git@github.com:example/activation-race.git");
    const backend = join(root, "sccache");
    const probe = join(root, "backend probe");
    const release = join(root, "backend release");
    await writeExecutable(
      backend,
      "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then\n  if [ ! -e \"$FIRSTMATE_RUST_CACHE_TEST_PROBE\" ]; then\n    : > \"$FIRSTMATE_RUST_CACHE_TEST_PROBE\"\n    while [ ! -e \"$FIRSTMATE_RUST_CACHE_TEST_RELEASE\" ]; do sleep 0.02; done\n  fi\n  echo 'sccache 0.17.0'\n  exit 0\nfi\nexit 1\n",
    );
    const env = await makeEnvironment(root, backend);
    env.FIRSTMATE_RUST_CACHE_TEST_PROBE = probe;
    env.FIRSTMATE_RUST_CACHE_TEST_RELEASE = release;
    let result = await cli(["enable", "--project", project, "--max-size", "8MiB"], project, env);
    assert.equal(result.code, 0, result.stderr);

    const activation = prepareExecution(project, env);
    await waitFor(async () => stat(probe).then(() => true).catch(() => false));
    result = await cli(["uninstall", "--remove-cache"], project, env);
    assert.equal(result.code, 0, result.stderr);
    await writeFile(release, "release\n");

    const plan = await activation;
    assert.equal(plan.state, "disabled");
    await assert.rejects(stat(env.FIRSTMATE_RUST_CACHE_CACHE_DIR), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
