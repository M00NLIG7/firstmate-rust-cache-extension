import assert from "node:assert/strict";
import { mkdir, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { REPO_ROOT, run, temporaryRoot, writeExecutable } from "./helpers.mjs";

const supportsPinnedLeases = process.platform === "linux";
const helperSource = new URL("../bin/fm-fs-helper.rs", import.meta.url);

async function leaseIdentity(path) {
  const info = await stat(path, { bigint: true });
  return {
    FIRSTMATE_RUST_CACHE_LEASE_DEVICE: String(info.dev),
    FIRSTMATE_RUST_CACHE_LEASE_INODE: String(info.ino),
  };
}

async function compileFilesystemHelper(root) {
  const helper = join(root, "fm-fs-helper");
  const result = await run("rustc", [helperSource.pathname, "--edition=2021", "-O", "-o", helper]);
  assert.equal(result.code, 0, result.stderr);
  return helper;
}

test("a failed compiler invoked through sccache is not replayed", async () => {
  const root = await temporaryRoot("wrapper");
  try {
    const invocations = join(root, "invocations");
    const compiler = join(root, "compiler");
    const backend = join(root, "backend");
    const leases = join(root, "leases");
    await mkdir(leases, { mode: 0o700 });
    const helper = await compileFilesystemHelper(root);
    await writeExecutable(
      compiler,
      "#!/bin/sh\nprintf 'compiler\\n' >> \"$TEST_INVOCATIONS\"\nprintf 'compiler failed\\n' >&2\nexit 19\n",
    );
    await writeExecutable(
      backend,
      "#!/bin/sh\n[ -f \"$FIRSTMATE_RUST_CACHE_LEASE_DIR\"/*.json ] || exit 31\nprintf 'backend\\n' >> \"$TEST_INVOCATIONS\"\nexec \"$@\"\n",
    );

    const result = await run(join(REPO_ROOT, "bin", "fm-rustc-wrapper"), [compiler], {
      cwd: root,
      env: {
        ...process.env,
        FIRSTMATE_RUST_CACHE_BACKEND: backend,
        FIRSTMATE_RUST_CACHE_LEASE_DIR: leases,
        FIRSTMATE_RUST_CACHE_LEASE_TOKEN: "0123456789abcdef0123456789abcdef",
        FIRSTMATE_RUST_CACHE_FS_HELPER: helper,
        ...(await leaseIdentity(leases)),
        TEST_INVOCATIONS: invocations,
      },
    });

    assert.equal(result.code, 19, result.stderr);
    assert.equal(result.stderr, "compiler failed\n");
    assert.equal(await readFile(invocations, "utf8"), supportsPinnedLeases ? "backend\ncompiler\n" : "compiler\n");
    const releasedLeases = await readdir(leases);
    if (supportsPinnedLeases) {
      assert.equal(releasedLeases.length, 1);
      assert.equal(await readFile(join(leases, releasedLeases[0]), "utf8"), "");
    } else {
      assert.deepEqual(releasedLeases, []);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a mismatched compiler lease identity falls open before sccache starts", async () => {
  const root = await temporaryRoot("wrapper lease identity");
  try {
    const invocations = join(root, "invocations");
    const compiler = join(root, "compiler");
    const backend = join(root, "backend");
    const leases = join(root, "leases");
    await mkdir(leases, { mode: 0o700 });
    await writeExecutable(compiler, "#!/bin/sh\nprintf 'compiler\\n' >> \"$TEST_INVOCATIONS\"\nexit 29\n");
    await writeExecutable(backend, "#!/bin/sh\nprintf 'backend\\n' >> \"$TEST_INVOCATIONS\"\nexit 31\n");

    const result = await run(join(REPO_ROOT, "bin", "fm-rustc-wrapper"), [compiler], {
      cwd: root,
      env: {
        ...process.env,
        FIRSTMATE_RUST_CACHE_BACKEND: backend,
        FIRSTMATE_RUST_CACHE_LEASE_DIR: leases,
        FIRSTMATE_RUST_CACHE_LEASE_TOKEN: "0123456789abcdef0123456789abcdef",
        FIRSTMATE_RUST_CACHE_LEASE_DEVICE: "0",
        FIRSTMATE_RUST_CACHE_LEASE_INODE: "0",
        TEST_INVOCATIONS: invocations,
      },
    });

    assert.equal(result.code, 29, result.stderr);
    assert.equal(await readFile(invocations, "utf8"), "compiler\n");
    assert.deepEqual(await readdir(leases), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a missing compiler lease falls open before sccache starts", async () => {
  const root = await temporaryRoot("wrapper missing lease");
  try {
    const invocations = join(root, "invocations");
    const compiler = join(root, "compiler");
    const backend = join(root, "backend");
    await writeExecutable(compiler, "#!/bin/sh\nprintf 'compiler\\n' >> \"$TEST_INVOCATIONS\"\nexit 23\n");
    await writeExecutable(backend, "#!/bin/sh\nprintf 'backend\\n' >> \"$TEST_INVOCATIONS\"\nexit 31\n");

    const result = await run(join(REPO_ROOT, "bin", "fm-rustc-wrapper"), [compiler], {
      cwd: root,
      env: {
        ...process.env,
        FIRSTMATE_RUST_CACHE_BACKEND: backend,
        FIRSTMATE_RUST_CACHE_LEASE_DIR: join(root, "missing leases"),
        FIRSTMATE_RUST_CACHE_LEASE_TOKEN: "0123456789abcdef0123456789abcdef",
        TEST_INVOCATIONS: invocations,
      },
    });

    assert.equal(result.code, 23, result.stderr);
    assert.equal(await readFile(invocations, "utf8"), "compiler\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a symlinked compiler lease directory falls open without foreign writes", async () => {
  const root = await temporaryRoot("wrapper lease symlink");
  try {
    const invocations = join(root, "invocations");
    const compiler = join(root, "compiler");
    const backend = join(root, "backend");
    const foreign = join(root, "foreign leases");
    const leases = join(root, "leases");
    await mkdir(foreign, { mode: 0o700 });
    await writeFile(join(foreign, "must-survive"), "sentinel\n", { mode: 0o600 });
    await symlink(foreign, leases);
    await writeExecutable(compiler, "#!/bin/sh\nprintf 'compiler\\n' >> \"$TEST_INVOCATIONS\"\nexit 29\n");
    await writeExecutable(backend, "#!/bin/sh\nprintf 'backend\\n' >> \"$TEST_INVOCATIONS\"\nexit 31\n");

    const result = await run(join(REPO_ROOT, "bin", "fm-rustc-wrapper"), [compiler], {
      cwd: root,
      env: {
        ...process.env,
        FIRSTMATE_RUST_CACHE_BACKEND: backend,
        FIRSTMATE_RUST_CACHE_LEASE_DIR: leases,
        FIRSTMATE_RUST_CACHE_LEASE_TOKEN: "0123456789abcdef0123456789abcdef",
        TEST_INVOCATIONS: invocations,
      },
    });

    assert.equal(result.code, 29, result.stderr);
    assert.equal(await readFile(invocations, "utf8"), "compiler\n");
    assert.equal(await readFile(join(foreign, "must-survive"), "utf8"), "sentinel\n");
    assert.deepEqual(await readdir(foreign), ["must-survive"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
