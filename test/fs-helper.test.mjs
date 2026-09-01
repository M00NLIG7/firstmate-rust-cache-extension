import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { temporaryRoot } from "./helpers.mjs";

const helperSource = new URL("../bin/fm-fs-helper.rs", import.meta.url);

function run(command, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: "pipe" });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => resolvePromise({ code, stderr }));
  });
}

function waitForOutput(child, expected) {
  return new Promise((resolvePromise, reject) => {
    let output = "";
    const cleanup = () => {
      child.stdout.off("data", onData);
      child.off("error", onError);
      child.off("close", onClose);
    };
    const onData = (chunk) => {
      output += chunk;
      if (output.includes(expected)) {
        cleanup();
        resolvePromise();
      }
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onClose = (code) => {
      cleanup();
      reject(new Error(`helper closed before ${expected} (${code ?? "signal"})`));
    };
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", onData);
    child.once("error", onError);
    child.once("close", onClose);
  });
}

function waitForClose(child) {
  return new Promise((resolvePromise) => child.once("close", resolvePromise));
}

test("filesystem helper preserves a replacement lock", { skip: process.platform !== "linux" }, async () => {
  const root = await temporaryRoot("filesystem helper");
  try {
    const helper = join(root, "fm-fs-helper");
    let result = await run("rustc", [helperSource.pathname, "--edition=2021", "-O", "-o", helper]);
    assert.equal(result.code, 0, result.stderr);

    const lock = join(root, "lock");
    const retired = join(root, "retired-lock");
    const token = "0123456789abcdef0123456789abcdef";
    await mkdir(lock, { mode: 0o700 });
    await writeFile(join(lock, "owner.json"), `${JSON.stringify({ token })}\n`, { mode: 0o600 });
    const parentIdentity = await stat(root, { bigint: true });
    const identity = await stat(lock, { bigint: true });
    await rename(lock, retired);
    await mkdir(lock, { mode: 0o700 });
    await writeFile(join(lock, "owner.json"), `${JSON.stringify({ token })}\n`, { mode: 0o600 });

    result = await run(helper, [
      "release-lock",
      lock,
      String(parentIdentity.dev),
      String(parentIdentity.ino),
      String(identity.dev),
      String(identity.ino),
      token,
    ]);
    assert.notEqual(result.code, 0);
    assert.equal(await readFile(join(lock, "owner.json"), "utf8"), `${JSON.stringify({ token })}\n`);
    assert.equal(await readFile(join(retired, "owner.json"), "utf8"), `${JSON.stringify({ token })}\n`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("filesystem helper refuses a replacement parent", { skip: process.platform !== "linux" }, async () => {
  const root = await temporaryRoot("filesystem helper parent");
  try {
    const helper = join(root, "fm-fs-helper");
    let result = await run("rustc", [helperSource.pathname, "--edition=2021", "-O", "-o", helper]);
    assert.equal(result.code, 0, result.stderr);

    const parent = join(root, "parent");
    const retired = join(root, "retired-parent");
    const name = "owned";
    await mkdir(parent, { mode: 0o700 });
    await writeFile(join(parent, name), "owned\n", { mode: 0o600 });
    const parentIdentity = await stat(parent, { bigint: true });
    const fileIdentity = await stat(join(parent, name), { bigint: true });
    await rename(parent, retired);
    await mkdir(parent, { mode: 0o700 });
    await writeFile(join(parent, name), "replacement\n", { mode: 0o600 });

    result = await run(helper, [
      "remove-file",
      join(parent, name),
      String(parentIdentity.dev),
      String(parentIdentity.ino),
      String(fileIdentity.dev),
      String(fileIdentity.ino),
    ]);
    assert.notEqual(result.code, 0);
    assert.equal(await readFile(join(parent, name), "utf8"), "replacement\n");
    assert.equal(await readFile(join(retired, name), "utf8"), "owned\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("filesystem helper removes an owned child below a standard XDG-style parent", { skip: process.platform !== "linux" }, async () => {
  const root = await temporaryRoot("filesystem helper XDG parent");
  try {
    const helper = join(root, "fm-fs-helper");
    let result = await run("rustc", [helperSource.pathname, "--edition=2021", "-O", "-o", helper]);
    assert.equal(result.code, 0, result.stderr);

    const parent = join(root, "xdg parent");
    const file = join(parent, "owned");
    await mkdir(parent, { mode: 0o700 });
    await chmod(parent, 0o755);
    await writeFile(file, "cache-data\n", { mode: 0o600 });
    const parentIdentity = await stat(parent, { bigint: true });
    const fileIdentity = await stat(file, { bigint: true });

    result = await run(helper, [
      "remove-file",
      file,
      String(parentIdentity.dev),
      String(parentIdentity.ino),
      String(fileIdentity.dev),
      String(fileIdentity.ino),
    ]);
    assert.equal(result.code, 0, result.stderr);
    await assert.rejects(readFile(file, "utf8"), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("filesystem helper removes quarantined files and recovers an interrupted lock holder", { skip: process.platform !== "linux" }, async () => {
  const root = await temporaryRoot("filesystem helper recovery");
  try {
    const helper = join(root, "fm-fs-helper");
    let result = await run("rustc", [helperSource.pathname, "--edition=2021", "-O", "-o", helper]);
    assert.equal(result.code, 0, result.stderr);
    const parentIdentity = await stat(root, { bigint: true });
    const file = join(root, "owned");
    await writeFile(file, "cache-data\n", { mode: 0o600 });
    const fileIdentity = await stat(file, { bigint: true });
    result = await run(helper, [
      "remove-file",
      file,
      String(parentIdentity.dev),
      String(parentIdentity.ino),
      String(fileIdentity.dev),
      String(fileIdentity.ino),
    ]);
    assert.equal(result.code, 0, result.stderr);
    await assert.rejects(readFile(file, "utf8"), { code: "ENOENT" });

    const cache = join(root, "cache");
    const artifacts = join(cache, "artifacts");
    await mkdir(artifacts, { recursive: true, mode: 0o700 });
    await chmod(artifacts, 0o755);
    await writeFile(join(artifacts, "sccache-entry"), "cache-data\n", { mode: 0o644 });
    const cacheIdentity = await stat(cache, { bigint: true });
    result = await run(helper, [
      "remove-tree",
      cache,
      String(parentIdentity.dev),
      String(parentIdentity.ino),
      String(cacheIdentity.dev),
      String(cacheIdentity.ino),
    ]);
    assert.equal(result.code, 0, result.stderr);
    await assert.rejects(stat(cache), { code: "ENOENT" });

    const lock = join(root, "lock");
    const startHolder = () => spawn(helper, [
      "hold-lock",
      lock,
      String(parentIdentity.dev),
      String(parentIdentity.ino),
      "0123456789abcdef0123456789abcdef",
    ], { stdio: ["pipe", "pipe", "pipe"] });
    const first = startHolder();
    await new Promise((resolvePromise) => first.stdout.once("data", resolvePromise));
    first.kill("SIGKILL");
    await new Promise((resolvePromise) => first.once("close", resolvePromise));
    const second = startHolder();
    await new Promise((resolvePromise) => second.stdout.once("data", resolvePromise));
    second.stdin.end();
    const code = await new Promise((resolvePromise) => second.once("close", resolvePromise));
    assert.equal(code, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("filesystem helper hands bootstrap locks to queued holders and removes them quiescently", { skip: process.platform !== "linux" }, async () => {
  const root = await temporaryRoot("filesystem helper bootstrap handoff");
  try {
    const helper = join(root, "fm-fs-helper");
    const compiled = await run("rustc", [helperSource.pathname, "--edition=2021", "-O", "-o", helper]);
    assert.equal(compiled.code, 0, compiled.stderr);

    const lock = join(root, "bootstrap-lock");
    const parentIdentity = await stat(root, { bigint: true });
    const startHolder = (token) => spawn(helper, [
      "hold-bootstrap-lock",
      lock,
      String(parentIdentity.dev),
      String(parentIdentity.ino),
      token,
    ], { stdio: ["pipe", "pipe", "pipe"] });
    const firstToken = "0123456789abcdef0123456789abcdef";
    const secondToken = "fedcba9876543210fedcba9876543210";
    const first = startHolder(firstToken);
    await waitForOutput(first, `locked:${firstToken}\n`);
    const second = startHolder(secondToken);
    await waitForOutput(second, `queued:${secondToken}\n`);

    const secondLocked = waitForOutput(second, `locked:${secondToken}\n`);
    first.stdin.end();
    assert.equal(await waitForClose(first), 0);
    await secondLocked;
    second.stdin.end();
    assert.equal(await waitForClose(second), 0);
    await assert.rejects(stat(lock), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("filesystem helper clears a stale bootstrap participant after PID reuse", { skip: process.platform !== "linux" }, async () => {
  const root = await temporaryRoot("filesystem helper bootstrap incarnation");
  try {
    const helper = join(root, "fm-fs-helper");
    const compiled = await run("rustc", [helperSource.pathname, "--edition=2021", "-O", "-o", helper]);
    assert.equal(compiled.code, 0, compiled.stderr);

    const lock = join(root, "bootstrap-lock");
    const parentIdentity = await stat(root, { bigint: true });
    const staleToken = "0123456789abcdef0123456789abcdef";
    const currentToken = "fedcba9876543210fedcba9876543210";
    await mkdir(lock, { mode: 0o700 });
    await writeFile(join(lock, `participant-${process.pid}-0-${staleToken}`), "", { mode: 0o600 });
    const holder = spawn(helper, [
      "hold-bootstrap-lock",
      lock,
      String(parentIdentity.dev),
      String(parentIdentity.ino),
      currentToken,
    ], { stdio: ["pipe", "pipe", "pipe"] });
    await waitForOutput(holder, `locked:${currentToken}\n`);
    holder.stdin.end();
    assert.equal(await waitForClose(holder), 0);
    await assert.rejects(stat(lock), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
