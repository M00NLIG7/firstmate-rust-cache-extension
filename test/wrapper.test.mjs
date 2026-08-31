import assert from "node:assert/strict";
import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { REPO_ROOT, run, temporaryRoot, writeExecutable } from "./helpers.mjs";

test("a failed compiler invoked through sccache is not replayed", async () => {
  const root = await temporaryRoot("wrapper");
  try {
    const invocations = join(root, "invocations");
    const compiler = join(root, "compiler");
    const backend = join(root, "backend");
    const leases = join(root, "leases");
    await mkdir(leases, { mode: 0o700 });
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
        TEST_INVOCATIONS: invocations,
      },
    });

    assert.equal(result.code, 19, result.stderr);
    assert.equal(result.stderr, "compiler failed\n");
    assert.equal(await readFile(invocations, "utf8"), "backend\ncompiler\n");
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
