import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
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
