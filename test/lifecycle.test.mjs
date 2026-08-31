import assert from "node:assert/strict";
import { mkdir, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { finishExecution, prepareExecution } from "../lib/core.mjs";
import { cli, createProject, makeEnvironment, status, temporaryRoot, writeExecutable } from "./helpers.mjs";

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
    assert.equal(activation.reason, "unsafe-state");
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
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("clean refuses a symlinked lease directory without touching foreign leases", async () => {
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
