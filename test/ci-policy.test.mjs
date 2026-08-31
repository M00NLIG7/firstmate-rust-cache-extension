import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { parse } from "yaml";

import { REPO_ROOT } from "./helpers.mjs";

const workflowPath = join(REPO_ROOT, ".github", "workflows", "ci.yml");
const containerImage = "rust:1.86.0-slim-bookworm@sha256:a044f7ab9a762f95be2ee7eb2c49e4d4a4ec60011210de9f7da01d552cae3a55";
const checkoutAction = "actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683";
const nodeAction = "actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020";
const sccacheAction = "mozilla-actions/sccache-action@7d986dd989559c6ecdb630a3fd2557667be217ad";

function step(job, name) {
  const result = job.steps.find((candidate) => candidate.name === name);
  assert.ok(result, `missing ${name}`);
  return result;
}

function scriptLines(stepValue) {
  return stepValue.run.trim().split("\n").map((line) => line.trim()).filter(Boolean);
}

test("CI workflow uses reviewed immutable execution inputs", async () => {
  const workflow = parse(await readFile(workflowPath, "utf8"));
  const linux = workflow.jobs["linux-test"];
  const macos = workflow.jobs["macos-test"];

  assert.equal(linux["runs-on"], "ubuntu-24.04");
  assert.equal(linux.container.image, containerImage);
  assert.equal(macos["runs-on"], "macos-14");

  for (const job of [linux, macos]) {
    assert.equal(step(job, "Check out source").uses, checkoutAction);
    assert.equal(step(job, "Set up Node.js").uses, nodeAction);
    assert.equal(step(job, "Set up Node.js").with["node-version"], "22.14.0");
    assert.equal(step(job, "Install sccache").uses, sccacheAction);
    assert.equal(step(job, "Install sccache").with.version, "v0.17.0");
  }

  assert.deepEqual(scriptLines(step(linux, "Install alternate Rust")), [
    "rustup toolchain install 1.85.0 --profile minimal",
    "rustup default 1.86.0",
  ]);
  assert.deepEqual(scriptLines(step(macos, "Install reviewed Rust toolchains")), [
    "rustup toolchain install 1.86.0 --profile minimal",
    "rustup toolchain install 1.85.0 --profile minimal",
    "rustup default 1.86.0",
  ]);
});
