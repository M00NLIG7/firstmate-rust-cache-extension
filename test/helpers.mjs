import { spawn } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const CLI = join(REPO_ROOT, "bin", "firstmate-rust-cache.mjs");
const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_RUSTUP = process.env.RUSTUP_HOME || join(ORIGINAL_HOME, ".rustup");

export async function temporaryRoot(label = "suite") {
  return mkdtemp(join(tmpdir(), `firstmate rust cache ${label} `));
}

export async function findSccache() {
  const explicit = process.env.FIRSTMATE_RUST_CACHE_TEST_SCCACHE;
  const localName =
    process.platform === "darwin" && process.arch === "arm64"
      ? "sccache-v0.17.0-aarch64-apple-darwin"
      : process.platform === "darwin"
        ? "sccache-v0.17.0-x86_64-apple-darwin"
        : process.arch === "arm64"
          ? "sccache-v0.17.0-aarch64-unknown-linux-musl"
          : "sccache-v0.17.0-x86_64-unknown-linux-musl";
  const candidates = [explicit, join(REPO_ROOT, ".test-tools", localName, "sccache")].filter(Boolean);
  for (const candidate of candidates) {
    try {
      await access(candidate, fsConstants.X_OK);
      return resolve(candidate);
    } catch {
      // Try the next explicit/local candidate.
    }
  }
  const probe = await run("sh", ["-c", "command -v sccache"], { env: process.env });
  if (probe.code === 0 && probe.stdout.trim()) return probe.stdout.trim();
  return null;
}

export async function makeEnvironment(root, sccache) {
  const home = join(root, "home with spaces");
  const cargoHome = join(home, "cargo home");
  await mkdir(cargoHome, { recursive: true });
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (name.startsWith("SCCACHE_")) delete env[name];
  }
  delete env.RUSTC_WRAPPER;
  delete env.RUSTC_WORKSPACE_WRAPPER;
  delete env.CARGO_INCREMENTAL;
  env.HOME = home;
  env.CARGO_HOME = cargoHome;
  env.RUSTUP_HOME = ORIGINAL_RUSTUP;
  env.FIRSTMATE_RUST_CACHE_CONFIG_DIR = join(home, "configuration with spaces");
  env.FIRSTMATE_RUST_CACHE_CACHE_DIR = join(home, "cache with spaces");
  if (sccache) env.FIRSTMATE_RUST_CACHE_SCCACHE = sccache;
  else env.FIRSTMATE_RUST_CACHE_SCCACHE = join(root, "missing sccache");
  return env;
}

export async function createProject(root, name, remote, options = {}) {
  const project = join(root, name);
  await mkdir(join(project, "src"), { recursive: true });
  await writeFile(
    join(project, "Cargo.toml"),
    `[package]\nname = "${options.crateName || "cache_probe"}"\nversion = "0.1.0"\nedition = "2021"\n\n[features]\nfancy = []\n\n[lib]\npath = "src/lib.rs"\n`,
  );
  await writeFile(
    join(project, "src", "lib.rs"),
    "#[cfg(feature = \"fancy\")]\npub const FLAVOR: &str = \"fancy\";\n#[cfg(not(feature = \"fancy\"))]\npub const FLAVOR: &str = \"plain\";\npub fn answer() -> u64 { (0..1000).sum() }\n",
  );
  let result = await run("git", ["init", "-q"], { cwd: project, env: process.env });
  if (result.code !== 0) throw new Error(result.stderr);
  result = await run("git", ["remote", "add", "origin", remote], { cwd: project, env: process.env });
  if (result.code !== 0) throw new Error(result.stderr);
  return project;
}

export function run(command, args, options = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => resolvePromise({ code: 127, signal: null, stdout, stderr, error }));
    child.on("close", (code, signal) => resolvePromise({ code, signal, stdout, stderr }));
  });
}

export function runStreaming(command, args, options = {}) {
  return spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

export async function cli(args, cwd, env) {
  return run(process.execPath, [CLI, ...args], { cwd, env });
}

export async function status(cwd, env) {
  const result = await cli(["status", "--project", cwd, "--json"], cwd, env);
  if (result.code !== 0) throw new Error(result.stderr);
  return JSON.parse(result.stdout);
}

export async function removeTarget(project) {
  await rm(join(project, "target"), { recursive: true, force: true });
}

export async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

export async function writeExecutable(path, body) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, body, { mode: 0o755 });
  await chmod(path, 0o755);
}
