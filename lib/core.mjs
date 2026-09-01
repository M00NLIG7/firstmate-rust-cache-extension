import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import {
  access,
  chmod,
  mkdir,
  lstat,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rmdir,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const CONFIG_SCHEMA = "firstmate-rust-cache.config.v1";
export const NAMESPACE_STATE_SCHEMA = "firstmate-rust-cache.namespace-state.v1";
export const WORKLOAD = "cargo-rustc";
export const DEFAULT_CONTEXT = "local-user";
export const DEFAULT_GLOBAL_MAX_BYTES = 4 * 1024 ** 3;
export const DEFAULT_NAMESPACE_MAX_BYTES = 1024 ** 3;
export const DEFAULT_RETENTION_DAYS = 30;
export const MIN_SCCACHE_VERSION = [0, 17, 0];

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RUSTC_WRAPPER = join(PACKAGE_ROOT, "bin", "fm-rustc-wrapper");
const FILESYSTEM_HELPER_SOURCE = join(PACKAGE_ROOT, "bin", "fm-fs-helper.rs");
let filesystemHelperPromise;
const LOCK_WAIT_MS = 5_000;
const SOCKET_PATH_LIMIT = 96;
const NAMESPACE_METADATA_RESERVE = 256 * 1024;
const LEASE_METADATA_BUDGET = NAMESPACE_METADATA_RESERVE / 2;
const LEASE_FILESYSTEM_BLOCK_BYTES = 4 * 1024;
const MAX_COMPILER_LEASE_SLOTS = 4;
const MAX_ACTIVE_LEASE_FAMILIES = Math.floor(
  LEASE_METADATA_BUDGET / (LEASE_FILESYSTEM_BLOCK_BYTES * (MAX_COMPILER_LEASE_SLOTS + 1)),
);
const CACHE_ROOT_MARKER_SCHEMA = "firstmate-rust-cache.root.v1";
const CACHE_ROOT_MARKER = ".firstmate-rust-cache-root.json";
const CONFIG_ROOT_MARKER_SCHEMA = "firstmate-rust-cache.config-root.v1";
const CONFIG_ROOT_MARKER = ".firstmate-rust-cache-config-root.json";
const APPROVED_ANCESTOR_SYMLINKS = new Set(process.platform === "darwin" ? ["/var", "/tmp"] : []);
const CACHEABLE_CARGO_SUBCOMMANDS = new Set(["build", "check", "doc", "rustc"]);
const KNOWN_CONFIG_KEYS = new Set(["schema", "global_max_bytes", "projects"]);
const KNOWN_PROJECT_KEYS = new Set([
  "project_id",
  "project_label",
  "workload",
  "security_context",
  "enabled",
  "max_bytes",
  "retention_days",
  "created_at",
  "updated_at",
  "disabled_at",
]);

export async function supportsPinnedCompilerLeases(platform = process.platform, procFdPath = "/proc/self/fd") {
  if (platform !== "linux") return false;
  let anchor;
  let throughProcfs;
  try {
    anchor = await open("/", fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
    const expected = await anchor.stat();
    // /proc/self/fd is intentionally a kernel-managed symlink. Prove the
    // capability by following one descriptor link and comparing its identity;
    // ordinary user-controlled paths remain no-follow throughout the product.
    throughProcfs = await open(
      join(procFdPath, String(anchor.fd)),
      fsConstants.O_RDONLY | fsConstants.O_DIRECTORY,
    );
    const observed = await throughProcfs.stat();
    return (
      expected.isDirectory() &&
      observed.isDirectory() &&
      expected.dev === observed.dev &&
      expected.ino === observed.ino
    );
  } catch {
    return false;
  } finally {
    await throughProcfs?.close().catch(() => {});
    await anchor?.close().catch(() => {});
  }
}

export function supportsDescriptorBoundCacheOperations() {
  return process.platform === "linux";
}

export class ContractError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ContractError";
    this.code = code;
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function nowIso() {
  return new Date().toISOString();
}

function exactKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new ContractError("invalid-config", `${label} contains unknown field ${JSON.stringify(key)}`);
    }
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function integerInRange(value, minimum, maximum, label) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new ContractError("invalid-config", `${label} must be an integer from ${minimum} through ${maximum}`);
  }
  return value;
}

function validateIso(value, label, nullable = false) {
  if (nullable && value === null) return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(value) || Number.isNaN(Date.parse(value))) {
    throw new ContractError("invalid-config", `${label} must be an ISO-8601 timestamp${nullable ? " or null" : ""}`);
  }
  return value;
}

function validateContext(value) {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(value)) {
    throw new ContractError(
      "invalid-context",
      "security context must be a lower-case token of at most 64 characters",
    );
  }
  return value;
}

export function defaultConfig() {
  return {
    schema: CONFIG_SCHEMA,
    global_max_bytes: DEFAULT_GLOBAL_MAX_BYTES,
    projects: [],
  };
}

export function validateConfig(value) {
  if (!isPlainObject(value)) throw new ContractError("invalid-config", "configuration must be a JSON object");
  exactKeys(value, KNOWN_CONFIG_KEYS, "configuration");
  if (value.schema !== CONFIG_SCHEMA) {
    throw new ContractError("invalid-config", `unsupported configuration schema ${JSON.stringify(value.schema)}`);
  }
  integerInRange(value.global_max_bytes, 1024 ** 2, 1024 ** 4, "global_max_bytes");
  if (!Array.isArray(value.projects)) throw new ContractError("invalid-config", "projects must be an array");
  if (value.projects.length > 128) throw new ContractError("invalid-config", "projects exceeds the 128-entry bound");

  const seen = new Set();
  let allocated = 0;
  const projects = value.projects.map((entry, index) => {
    if (!isPlainObject(entry)) throw new ContractError("invalid-config", `projects[${index}] must be an object`);
    exactKeys(entry, KNOWN_PROJECT_KEYS, `projects[${index}]`);
    if (typeof entry.project_id !== "string" || !/^[a-f0-9]{64}$/.test(entry.project_id)) {
      throw new ContractError("invalid-config", `projects[${index}].project_id must be 64 lower-case hex characters`);
    }
    if (
      typeof entry.project_label !== "string" ||
      entry.project_label.length < 1 ||
      entry.project_label.length > 256 ||
      /[\u0000-\u001f\u007f]/.test(entry.project_label)
    ) {
      throw new ContractError("invalid-config", `projects[${index}].project_label is invalid`);
    }
    if (entry.workload !== WORKLOAD) {
      throw new ContractError("invalid-config", `projects[${index}].workload must be ${WORKLOAD}`);
    }
    validateContext(entry.security_context);
    if (typeof entry.enabled !== "boolean") {
      throw new ContractError("invalid-config", `projects[${index}].enabled must be boolean`);
    }
    integerInRange(entry.max_bytes, 1024 ** 2, value.global_max_bytes, `projects[${index}].max_bytes`);
    integerInRange(entry.retention_days, 1, 365, `projects[${index}].retention_days`);
    validateIso(entry.created_at, `projects[${index}].created_at`);
    validateIso(entry.updated_at, `projects[${index}].updated_at`);
    validateIso(entry.disabled_at, `projects[${index}].disabled_at`, true);
    if (entry.enabled && entry.disabled_at !== null) {
      throw new ContractError("invalid-config", `projects[${index}].disabled_at must be null while enabled`);
    }
    const key = entryKey(entry.project_id, entry.workload, entry.security_context);
    if (seen.has(key)) throw new ContractError("invalid-config", `duplicate project/workload/context entry ${key}`);
    seen.add(key);
    allocated += entry.max_bytes;
    return { ...entry };
  });

  if (allocated > value.global_max_bytes) {
    throw new ContractError(
      "invalid-config",
      `configured namespace limits total ${allocated} bytes, above global_max_bytes ${value.global_max_bytes}`,
    );
  }

  projects.sort(compareEntries);
  return {
    schema: CONFIG_SCHEMA,
    global_max_bytes: value.global_max_bytes,
    projects,
  };
}

function compareEntries(a, b) {
  return entryKey(a.project_id, a.workload, a.security_context).localeCompare(
    entryKey(b.project_id, b.workload, b.security_context),
  );
}

function entryKey(projectId, workload, context) {
  return `${projectId}\u0000${workload}\u0000${context}`;
}

export function getStoragePaths(env = process.env, platform = process.platform) {
  const home = env.HOME || homedir();
  const configBase =
    env.FIRSTMATE_RUST_CACHE_CONFIG_DIR ||
    (platform === "darwin"
      ? join(home, "Library", "Application Support", "Firstmate Rust Cache")
      : join(env.XDG_CONFIG_HOME || join(home, ".config"), "firstmate-rust-cache"));
  const cacheBase =
    env.FIRSTMATE_RUST_CACHE_CACHE_DIR ||
    (platform === "darwin"
      ? join(home, "Library", "Caches", "Firstmate Rust Cache")
      : join(env.XDG_CACHE_HOME || join(home, ".cache"), "firstmate-rust-cache"));
  const uid = typeof process.getuid === "function" ? process.getuid() : "unknown";
  // Keep filesystem Unix sockets below the conservative macOS path bound even
  // when HOME or a disposable worktree contains long names and spaces.
  const runtimeBase =
    env.FIRSTMATE_RUST_CACHE_RUNTIME_DIR || join("/tmp", `firstmate-rust-cache-${uid}`);
  return {
    configDir: resolve(configBase),
    configFile: resolve(configBase, "config.json"),
    configLock: resolve(configBase, ".config.lock"),
    cacheRoot: resolve(cacheBase),
    cacheLock: resolve(cacheBase, ".cache.lock"),
    namespacesDir: resolve(cacheBase, "namespaces"),
    runtimeRoot: resolve(runtimeBase),
    socketsDir: resolve(runtimeBase),
    trashDir: resolve(cacheBase, "trash"),
  };
}

async function validatePrivateDirectory(path) {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new ContractError("unsafe-state", `refusing non-directory state root ${path}`);
  }
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
    throw new ContractError("unsafe-state", `refusing state root owned by uid ${info.uid}`);
  }
  if ((info.mode & 0o077) !== 0) {
    throw new ContractError("unsafe-state", `state root must not be group- or world-accessible: ${path}`);
  }
}

async function ensureDirectoryChain(path) {
  const pieces = resolve(path).split(sep).filter(Boolean);
  let current = sep;
  for (const piece of pieces) {
    current = join(current, piece);
    let info;
    try {
      info = await lstat(current);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      await mkdir(current, { mode: 0o700 });
      info = await lstat(current);
    }
    if (info.isSymbolicLink()) {
      if (APPROVED_ANCESTOR_SYMLINKS.has(current)) continue;
      throw new ContractError("unsafe-state", `refusing symlinked or non-directory state path ${current}`);
    }
    if (!info.isDirectory()) {
      throw new ContractError("unsafe-state", `refusing symlinked or non-directory state path ${current}`);
    }
  }
}

async function ensurePrivateDirectory(path) {
  await ensureDirectoryChain(path);
  await validatePrivateDirectory(path);
}

async function validateExistingDirectoryChain(path) {
  const pieces = resolve(path).split(sep).filter(Boolean);
  let current = sep;
  for (const piece of pieces) {
    current = join(current, piece);
    let info;
    try {
      info = await lstat(current);
    } catch (error) {
      if (error?.code === "ENOENT") return false;
      throw error;
    }
    if (info.isSymbolicLink()) {
      if (APPROVED_ANCESTOR_SYMLINKS.has(current)) continue;
      throw new ContractError("unsafe-state", `refusing symlinked or non-directory state path ${current}`);
    }
    if (!info.isDirectory()) {
      throw new ContractError("unsafe-state", `refusing symlinked or non-directory state path ${current}`);
    }
  }
  return true;
}

async function validateLeaseDirectory(leasesDir) {
  if (!(await validateExistingDirectoryChain(leasesDir))) return false;
  await validatePrivateDirectory(leasesDir);
  return true;
}

function isLeaseDirectoryIdentity(value) {
  return isDirectoryIdentity(value);
}

function isDirectoryIdentity(value) {
  return (
    isPlainObject(value) &&
    typeof value.device === "string" &&
    /^\d+$/.test(value.device) &&
    typeof value.inode === "string" &&
    /^\d+$/.test(value.inode)
  );
}

function sameLeaseDirectoryIdentity(first, second) {
  return sameDirectoryIdentity(first, second);
}

function sameDirectoryIdentity(first, second) {
  return isDirectoryIdentity(first) &&
    isDirectoryIdentity(second) &&
    first.device === second.device &&
    first.inode === second.inode;
}

async function readLeaseDirectoryIdentity(leasesDir) {
  if (!(await validateLeaseDirectory(leasesDir))) {
    throw new ContractError("unsafe-state", "namespace leases directory is unavailable");
  }
  const info = await lstat(leasesDir, { bigint: true });
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new ContractError("unsafe-state", "namespace leases directory is not a real directory");
  }
  return directoryIdentity(info);
}

function directoryIdentity(info) {
  return { device: String(info.dev), inode: String(info.ino) };
}

async function readDirectoryIdentity(path) {
  const info = await lstat(path, { bigint: true });
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new ContractError("unsafe-state", `refusing non-directory cleanup path ${path}`);
  }
  return directoryIdentity(info);
}

async function requireDirectoryIdentity(path, expected, label) {
  if (!isDirectoryIdentity(expected)) {
    throw new ContractError("unsafe-state", `${label} identity is missing or invalid`);
  }
  const actual = await readDirectoryIdentity(path);
  if (!sameDirectoryIdentity(actual, expected)) {
    throw new ContractError("unsafe-state", `${label} identity changed`);
  }
  return actual;
}

async function requireLeaseDirectoryIdentity(namespace, expected) {
  if (!isLeaseDirectoryIdentity(expected)) {
    throw new ContractError("unsafe-state", "namespace leases directory identity is missing or invalid");
  }
  const actual = await readLeaseDirectoryIdentity(namespace.leasesDir);
  if (!sameLeaseDirectoryIdentity(actual, expected)) {
    throw new ContractError("unsafe-state", "namespace leases directory identity changed");
  }
  return actual;
}

async function validateRuntimeDirectory(runtimeRoot) {
  if (!(await validateExistingDirectoryChain(runtimeRoot))) return false;
  await validatePrivateDirectory(runtimeRoot);
  return true;
}

async function ensureOwnedConfigRoot(storage, create = false) {
  let existed = true;
  try {
    await lstat(storage.configDir);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    existed = false;
  }
  if (!existed && !create) return false;
  await ensurePrivateDirectory(storage.configDir);
  const markerPath = join(storage.configDir, CONFIG_ROOT_MARKER);
  if (!existed) {
    try {
      await writeFile(
        markerPath,
        `${JSON.stringify({ schema: CONFIG_ROOT_MARKER_SCHEMA, root_id: sha256(resolve(storage.configDir)) })}\n`,
        { encoding: "utf8", mode: 0o600, flag: "wx" },
      );
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
  }
  let marker;
  try {
    await validatePrivateFile(markerPath);
    marker = JSON.parse(await readFile(markerPath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new ContractError("unsafe-state", "configuration root has no Firstmate Rust Cache ownership marker");
    }
    throw error;
  }
  if (
    !isPlainObject(marker) ||
    marker.schema !== CONFIG_ROOT_MARKER_SCHEMA ||
    marker.root_id !== sha256(resolve(storage.configDir)) ||
    Object.keys(marker).sort().join(",") !== "root_id,schema"
  ) {
    throw new ContractError("unsafe-state", "configuration root ownership marker is invalid");
  }
  return true;
}

async function ensureOwnedCacheRoot(storage, create = false) {
  let existed = true;
  try {
    await lstat(storage.cacheRoot);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    existed = false;
  }
  if (!existed && !create) return false;
  await ensurePrivateDirectory(storage.cacheRoot);
  const rootIdentity = await readDirectoryIdentity(storage.cacheRoot);
  const markerPath = join(storage.cacheRoot, CACHE_ROOT_MARKER);
  if (!existed) {
    try {
      await writeFile(
        markerPath,
        `${JSON.stringify({
          schema: CACHE_ROOT_MARKER_SCHEMA,
          root_id: sha256(resolve(storage.cacheRoot)),
          directory: rootIdentity,
        })}\n`,
        { encoding: "utf8", mode: 0o600, flag: "wx" },
      );
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
  }
  let marker;
  try {
    await validatePrivateFile(markerPath);
    marker = JSON.parse(await readFile(markerPath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new ContractError("unsafe-state", "cache root has no Firstmate Rust Cache ownership marker");
    }
    throw error;
  }
  if (
    !isPlainObject(marker) ||
    marker.schema !== CACHE_ROOT_MARKER_SCHEMA ||
    marker.root_id !== sha256(resolve(storage.cacheRoot)) ||
    !sameDirectoryIdentity(marker.directory, rootIdentity) ||
    Object.keys(marker).sort().join(",") !== "directory,root_id,schema"
  ) {
    throw new ContractError("unsafe-state", "cache root ownership marker is invalid");
  }
  return rootIdentity;
}

async function validatePrivateFile(path) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new ContractError("unsafe-state", "configuration is not a regular file");
  }
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
    throw new ContractError("unsafe-state", "configuration is owned by another user");
  }
  if ((info.mode & 0o077) !== 0) {
    throw new ContractError("unsafe-state", "configuration must not be group- or world-accessible");
  }
}

async function readPrivateFileIdentity(path) {
  await validatePrivateFile(path);
  const info = await lstat(path, { bigint: true });
  return directoryIdentity(info);
}

export async function readConfig(env = process.env) {
  const paths = getStoragePaths(env);
  try {
    if (!(await ensureOwnedConfigRoot(paths, false))) {
      return { config: defaultConfig(), exists: false, paths };
    }
    await validatePrivateFile(paths.configFile);
    const text = await readFile(paths.configFile, "utf8");
    if (Buffer.byteLength(text) > 1024 * 1024) {
      throw new ContractError("invalid-config", "configuration exceeds 1 MiB");
    }
    return { config: validateConfig(JSON.parse(text)), exists: true, paths };
  } catch (error) {
    if (error?.code === "ENOENT") return { config: defaultConfig(), exists: false, paths };
    if (error instanceof SyntaxError) throw new ContractError("invalid-config", "configuration is not valid JSON");
    throw error;
  }
}

async function writeConfig(config, env = process.env) {
  const validated = validateConfig(config);
  const paths = getStoragePaths(env);
  await ensureOwnedConfigRoot(paths, true);
  const temporary = join(paths.configDir, `.config.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
  const body = `${JSON.stringify(validated, null, 2)}\n`;
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(body, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, paths.configFile);
    await chmod(paths.configFile, 0o600);
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

function pidIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function invokeFilesystemHelper(args) {
  if (process.platform !== "linux") return null;
  if (!filesystemHelperPromise) {
    filesystemHelperPromise = (async () => {
      const source = await readFile(FILESYSTEM_HELPER_SOURCE);
      const toolchain = await collectProcess("rustc", ["--version"], {
        env: { PATH: process.env.PATH || "", HOME: process.env.HOME || homedir() },
        timeoutMs: 3_000,
        maxBytes: 64 * 1024,
      });
      if (toolchain.code !== 0) return null;
      const digest = sha256(Buffer.concat([source, Buffer.from(toolchain.stdout)]));
      const directory = join(tmpdir(), "firstmate-rust-cache-fs-helper");
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await validatePrivateDirectory(directory);
      const executable = join(directory, `fm-fs-helper-${digest}`);
      try {
        await access(executable, fsConstants.X_OK);
      } catch {
        const staging = `${executable}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
        const compile = await collectProcess("rustc", [FILESYSTEM_HELPER_SOURCE, "--edition=2021", "-O", "-o", staging], {
          env: { PATH: process.env.PATH || "", HOME: process.env.HOME || homedir() },
          timeoutMs: 30_000,
          maxBytes: 256 * 1024,
        });
        if (compile.code !== 0) return null;
        await chmod(staging, 0o700);
        try {
          await rename(staging, executable);
        } catch (error) {
          if (error?.code !== "EEXIST") throw error;
        }
      }
      await validatePrivateFile(executable);
      const probe = await collectProcess(executable, ["probe"], {
        env: { PATH: process.env.PATH || "", HOME: process.env.HOME || homedir() },
        timeoutMs: 3_000,
        maxBytes: 64 * 1024,
      });
      return probe.code === 0 ? executable : null;
    })().catch(() => null);
  }
  const executable = await filesystemHelperPromise;
  if (!executable) return false;
  try {
    const result = await collectProcess(executable, args, {
      env: { PATH: process.env.PATH || "", HOME: process.env.HOME || homedir() },
      timeoutMs: 3_000,
      maxBytes: 64 * 1024,
    });
    return result.code === 0;
  } catch {
    return false;
  }
}

async function filesystemHelperExecutable() {
  await invokeFilesystemHelper(["probe"]);
  return filesystemHelperPromise ? await filesystemHelperPromise : null;
}

async function supportsDescriptorBoundCacheOperationsHere() {
  return (await invokeFilesystemHelper(["probe"])) === true;
}

async function removeOwnedTree(path, identity, expectedParent) {
  const parent = expectedParent || await readDirectoryIdentity(dirname(path));
  const removed = await invokeFilesystemHelper(["remove-tree", path, parent.device, parent.inode, identity.device, identity.inode]);
  if (removed !== true) {
    throw new ContractError("cleanup-unsupported", "descriptor-bound cleanup is unavailable; preserving cache data");
  }
}

async function removeOwnedFile(path, identity, expectedParent) {
  const parent = expectedParent || await readDirectoryIdentity(dirname(path));
  const removed = await invokeFilesystemHelper(["remove-file", path, parent.device, parent.inode, identity.device, identity.inode]);
  if (removed !== true) {
    throw new ContractError("cleanup-unsupported", "descriptor-bound cleanup is unavailable; preserving cache data");
  }
}

async function acquireDirectoryLock(lockPath, waitMs) {
  const executable = await filesystemHelperExecutable();
  if (!executable) {
    throw new ContractError("lock-unsupported", "descriptor-bound locking is unavailable; refusing configuration mutation");
  }
  await ensureDirectoryChain(dirname(lockPath));
  const parent = await readDirectoryIdentity(dirname(lockPath));
  const token = randomBytes(16).toString("hex");
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executable, ["hold-lock", lockPath, parent.device, parent.inode, token], {
      env: { PATH: process.env.PATH || "", HOME: process.env.HOME || homedir() },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let settled = false;
    let output = "";
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      if (!settled) {
        settled = true;
        reject(new ContractError("busy", `state is busy (lock ${basename(lockPath)})`));
      }
    }, waitMs);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      output += chunk;
      if (!settled && output.includes(`locked:${token}\n`)) {
        settled = true;
        clearTimeout(timeout);
        resolvePromise(child);
      }
    });
    child.once("error", () => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        reject(new ContractError("lock-unsupported", "descriptor-bound locking is unavailable; refusing configuration mutation"));
      }
    });
    child.once("close", (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        reject(new ContractError("lock-unsupported", `descriptor-bound lock acquisition failed (${code ?? "signal"})`));
      }
    });
  });
}

async function releaseDirectoryLock(child) {
  return new Promise((resolvePromise, reject) => {
    child.once("close", (code) => {
      if (code === 0) resolvePromise();
      else reject(new ContractError("lock-release-failed", "descriptor-bound lock release failed; refusing further mutations"));
    });
    child.stdin.end();
  });
}

async function withDirectoryLock(lockPath, callback, waitMs = LOCK_WAIT_MS) {
  if (!(await supportsDescriptorBoundCacheOperationsHere())) {
    throw new ContractError("lock-unsupported", "descriptor-bound locking is unavailable; refusing configuration mutation");
  }
  const holder = await acquireDirectoryLock(lockPath, waitMs);
  try {
    return await callback();
  } finally {
    await releaseDirectoryLock(holder);
  }
}

async function mutateConfig(env, callback) {
  const paths = getStoragePaths(env);
  await ensureOwnedConfigRoot(paths, true);
  const mutate = async () => {
    const current = await readConfig(env);
    const result = await callback(current.config, current.exists);
    if (result.changed) await writeConfig(result.config, env);
    return result.value;
  };
  if (!(await supportsDescriptorBoundCacheOperationsHere())) return mutate();
  return withDirectoryLock(paths.configLock, mutate);
}

function collectProcess(command, args, options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const maxBytes = options.maxBytes ?? 1024 * 1024;
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 250).unref();
    }, options.timeoutMs ?? 5_000);
    timer.unref();

    const append = (kind, chunk) => {
      const next = kind === "stdout" ? stdout + chunk : stderr + chunk;
      if (Buffer.byteLength(next) > maxBytes) {
        child.kill("SIGTERM");
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          rejectPromise(new ContractError("command-output", `${command} output exceeded ${maxBytes} bytes`));
        }
        return;
      }
      if (kind === "stdout") stdout = next;
      else stderr = next;
    };
    child.stdout.on("data", (chunk) => append("stdout", chunk));
    child.stderr.on("data", (chunk) => append("stderr", chunk));
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rejectPromise(error);
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({ code, signal, stdout, stderr });
    });
  });
}

export function normalizeRemote(raw) {
  if (typeof raw !== "string" || raw.length < 1 || raw.length > 4096 || /[\u0000-\u001f\u007f]/.test(raw)) {
    throw new ContractError("unsupported-project", "origin remote is empty or malformed");
  }
  const trimmed = raw.trim();
  let host;
  let port = "";
  let path;

  const scp = trimmed.includes("://")
    ? null
    : trimmed.match(/^(?:[^@/:]+@)?([A-Za-z0-9.-]+):(.+)$/);
  if (scp && !/^[A-Za-z]:[\\/]/.test(trimmed)) {
    host = scp[1].toLowerCase();
    path = scp[2];
  } else {
    let url;
    try {
      url = new URL(trimmed);
    } catch {
      throw new ContractError("unsupported-project", "origin must be an ssh, https, http, or git network remote");
    }
    if (!new Set(["ssh:", "https:", "http:", "git:"]).has(url.protocol)) {
      throw new ContractError("unsupported-project", `origin protocol ${url.protocol} is unsupported`);
    }
    host = url.hostname.toLowerCase();
    port = url.port ? `:${url.port}` : "";
    path = url.pathname;
  }

  path = path.replace(/^\/+/, "").replace(/\/+$/, "").replace(/\.git$/i, "");
  const pieces = path.split("/");
  if (!host || pieces.length < 2 || pieces.some((piece) => !piece || piece === "." || piece === "..")) {
    throw new ContractError("unsupported-project", "origin does not have an unambiguous host/owner/repository identity");
  }
  const canonical = `${host}${port}/${pieces.join("/")}`;
  return {
    canonical,
    label: canonical,
    projectId: sha256(`git-remote-v1\u0000${canonical}`),
  };
}

export async function discoverProject(cwd, env = process.env) {
  const rootResult = await collectProcess("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
    env,
    timeoutMs: 3_000,
  });
  if (rootResult.code !== 0) throw new ContractError("unsupported-project", "current directory is not a Git worktree");
  const rootText = rootResult.stdout.trim();
  if (!rootText || !isAbsolute(rootText)) {
    throw new ContractError("unsupported-project", "Git did not return an absolute worktree root");
  }
  const root = await realpath(rootText);
  const remoteResult = await collectProcess("git", ["-C", root, "config", "--get-all", "remote.origin.url"], {
    env,
    timeoutMs: 3_000,
  });
  if (remoteResult.code !== 0) throw new ContractError("unsupported-project", "project has no origin remote");
  const remotes = remoteResult.stdout.split(/\r?\n/).filter((line) => line.length > 0);
  if (remotes.length !== 1) {
    throw new ContractError("unsupported-project", "project must have exactly one origin URL");
  }
  return { root, ...normalizeRemote(remotes[0]) };
}

export function directCargoArguments(command) {
  if (typeof command !== "string" || !/^cargo(?:[ \t]+[^\s;&|`$()<>\\'"#]+)*[ \t]*$/.test(command)) return null;
  return command.trim().split(/[ \t]+/);
}

export async function isCargoInvocationWithinProject(cwd, command, args, env = process.env) {
  if (command !== "cargo" || !Array.isArray(args) || args.some((argument) => typeof argument !== "string")) return false;
  let commandIndex = 0;
  if (args[0]?.startsWith("+")) {
    if (!/^\+[A-Za-z0-9._-]+$/.test(args[0])) return false;
    commandIndex = 1;
  }
  if (!CACHEABLE_CARGO_SUBCOMMANDS.has(args[commandIndex])) return false;
  try {
    await discoverProject(cwd, env);
  } catch {
    return false;
  }
  for (let index = commandIndex + 1; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--manifest-path") {
      return false;
    } else if (argument.startsWith("--manifest-path=")) {
      return false;
    } else if (
      argument === "-C" ||
      argument.startsWith("-C") ||
      argument === "--cwd" ||
      argument.startsWith("--cwd=") ||
      argument === "--current-dir" ||
      argument.startsWith("--current-dir=") ||
      argument === "--project-dir" ||
      argument.startsWith("--project-dir=") ||
      argument.startsWith("@")
    ) {
      return false;
    }
  }
  return true;
}

async function resolveExecutable(candidate, env) {
  const candidates = [];
  if (candidate.includes(sep) || (sep === "\\" && candidate.includes("/"))) {
    candidates.push(resolve(candidate));
  } else {
    for (const directory of (env.PATH || "").split(delimiter)) {
      if (directory) candidates.push(resolve(directory, candidate));
    }
  }
  for (const path of candidates) {
    try {
      await access(path, fsConstants.X_OK);
      const info = await stat(path);
      if (!info.isFile()) continue;
      return await realpath(path);
    } catch {
      // Continue searching PATH.
    }
  }
  return null;
}

function compareVersion(version, minimum) {
  for (let index = 0; index < 3; index += 1) {
    if (version[index] > minimum[index]) return 1;
    if (version[index] < minimum[index]) return -1;
  }
  return 0;
}

export async function checkBackend(env = process.env) {
  if (!new Set(["darwin", "linux"]).has(process.platform)) {
    return { available: false, reason: "unsupported-platform", diagnostic: "only macOS and Linux are supported" };
  }
  const requested = env.FIRSTMATE_RUST_CACHE_SCCACHE || "sccache";
  const executable = await resolveExecutable(requested, env);
  if (!executable) {
    return { available: false, reason: "backend-unavailable", diagnostic: "sccache was not found" };
  }
  try {
    const result = await collectProcess(executable, ["--version"], { env, timeoutMs: 3_000, maxBytes: 16_384 });
    if (result.code !== 0) {
      return { available: false, reason: "backend-unhealthy", diagnostic: "sccache --version failed" };
    }
    const match = `${result.stdout}\n${result.stderr}`.match(/(?:^|\s)(\d+)\.(\d+)\.(\d+)(?:\s|$)/);
    if (!match) {
      return { available: false, reason: "backend-unhealthy", diagnostic: "sccache version was not parseable" };
    }
    const tuple = match.slice(1, 4).map(Number);
    const version = tuple.join(".");
    if (compareVersion(tuple, MIN_SCCACHE_VERSION) < 0) {
      return {
        available: false,
        reason: "backend-unsupported",
        diagnostic: `sccache ${version} is older than ${MIN_SCCACHE_VERSION.join(".")}`,
        executable,
        version,
      };
    }
    return { available: true, executable, version };
  } catch {
    return { available: false, reason: "backend-unhealthy", diagnostic: "sccache health probe failed" };
  }
}

function ambientConflict(env) {
  for (const name of ["RUSTC_WRAPPER", "RUSTC_WORKSPACE_WRAPPER"]) {
    if (env[name]) return name;
  }
  if (env.CARGO_INCREMENTAL && env.CARGO_INCREMENTAL !== "0") return "CARGO_INCREMENTAL";
  for (const [name, value] of Object.entries(env)) {
    if (name.startsWith("SCCACHE_") && value) return name;
  }
  return null;
}

function namespaceIdFor(entry, storage) {
  const uid = typeof process.getuid === "function" ? String(process.getuid()) : "unknown";
  return sha256(
    [
      "namespace-v1",
      entry.project_id,
      entry.workload,
      entry.security_context,
      process.platform,
      uid,
      sha256(resolve(storage.cacheRoot)),
    ].join("\u0000"),
  );
}

function namespacePaths(storage, namespaceId) {
  return {
    namespaceId,
    namespaceDir: join(storage.namespacesDir, namespaceId),
    artifactsDir: join(storage.namespacesDir, namespaceId, "artifacts"),
    leasesDir: join(storage.namespacesDir, namespaceId, "leases"),
    stateFile: join(storage.namespacesDir, namespaceId, "state.json"),
    backendConfigFile: join(storage.namespacesDir, namespaceId, "sccache.toml"),
    socketPath: join(storage.socketsDir, `${namespaceId.slice(0, 24)}.sock`),
  };
}

export async function inspectActivation(cwd, env = process.env) {
  let loaded;
  try {
    loaded = await readConfig(env);
  } catch (error) {
    return {
      state: "bypass",
      reason: error.code || "invalid-config",
      diagnostic: error.message,
      backend: null,
      storage: getStoragePaths(env),
    };
  }
  if (!loaded.exists) {
    return { state: "disabled", reason: "not-configured", backend: null, storage: loaded.paths };
  }

  let project;
  try {
    project = await discoverProject(cwd, env);
  } catch (error) {
    return {
      state: "disabled",
      reason: error.code || "unsupported-project",
      diagnostic: error.message,
      backend: null,
      storage: loaded.paths,
      config: loaded.config,
    };
  }
  const context = env.FIRSTMATE_RUST_CACHE_CONTEXT || DEFAULT_CONTEXT;
  let validatedContext;
  try {
    validatedContext = validateContext(context);
  } catch (error) {
    return {
      state: "bypass",
      reason: error.code,
      diagnostic: error.message,
      backend: null,
      project,
      config: loaded.config,
      storage: loaded.paths,
    };
  }
  const matches = loaded.config.projects.filter(
    (entry) =>
      entry.project_id === project.projectId &&
      entry.workload === WORKLOAD &&
      entry.security_context === validatedContext,
  );
  if (matches.length !== 1 || !matches[0].enabled) {
    return {
      state: "disabled",
      reason: matches.length === 1 ? "selection-disabled" : "selection-absent",
      backend: null,
      project,
      config: loaded.config,
      entry: matches[0],
      storage: loaded.paths,
    };
  }
  const entry = matches[0];
  const namespace = namespacePaths(loaded.paths, namespaceIdFor(entry, loaded.paths));
  if (!(await supportsPinnedCompilerLeases()) || !(await supportsDescriptorBoundCacheOperationsHere())) {
    return {
      state: "bypass",
      reason: "unsupported-platform",
      diagnostic: "cacheable compiler launches require descriptor-bound namespace operations",
      backend: null,
      project,
      config: loaded.config,
      entry,
      namespace,
      storage: loaded.paths,
    };
  }
  const backend = await checkBackend(env);
  const conflict = ambientConflict(env);
  if (conflict) {
    return {
      state: "bypass",
      reason: "ambient-wrapper-conflict",
      diagnostic: `${conflict} is already set`,
      backend,
      project,
      config: loaded.config,
      entry,
      namespace,
      storage: loaded.paths,
    };
  }
  if (!backend.available) {
    return {
      state: "bypass",
      reason: backend.reason,
      diagnostic: backend.diagnostic,
      backend,
      project,
      config: loaded.config,
      entry,
      namespace,
      storage: loaded.paths,
    };
  }
  if (Buffer.byteLength(namespace.socketPath) >= SOCKET_PATH_LIMIT) {
    return {
      state: "bypass",
      reason: "runtime-path-too-long",
      diagnostic: "the private sccache socket path is too long for a portable Unix socket",
      backend,
      project,
      config: loaded.config,
      entry,
      namespace,
      storage: loaded.paths,
    };
  }
  return {
    state: "ready",
    reason: "enabled",
    backend,
    project,
    config: loaded.config,
    entry,
    namespace,
    storage: loaded.paths,
  };
}

async function readNamespaceState(path) {
  try {
    const value = JSON.parse(await readFile(path, "utf8"));
    if (!isPlainObject(value) || value.schema !== NAMESPACE_STATE_SCHEMA) return null;
    return value;
  } catch {
    return null;
  }
}

async function writeNamespaceState(plan, patch = {}) {
  const current = (await readNamespaceState(plan.namespace.stateFile)) || {};
  const leaseDirectory = patch.lease_directory || current.lease_directory || plan.leaseDirectoryIdentity;
  const namespaceDirectory = patch.namespace_directory || current.namespace_directory || plan.namespaceDirectoryIdentity;
  if (!isLeaseDirectoryIdentity(leaseDirectory)) {
    throw new ContractError("unsafe-state", "namespace leases directory identity is missing or invalid");
  }
  if (!isDirectoryIdentity(namespaceDirectory)) {
    throw new ContractError("unsafe-state", "namespace directory identity is missing or invalid");
  }
  if (
    current.lease_directory &&
    plan.leaseDirectoryIdentity &&
    !sameLeaseDirectoryIdentity(current.lease_directory, plan.leaseDirectoryIdentity)
  ) {
    throw new ContractError("unsafe-state", "namespace leases directory identity changed");
  }
  const value = {
    schema: NAMESPACE_STATE_SCHEMA,
    namespace: plan.namespace.namespaceId,
    project_id: plan.entry.project_id,
    project_label: plan.entry.project_label,
    workload: plan.entry.workload,
    security_context: plan.entry.security_context,
    max_bytes: plan.entry.max_bytes,
    retention_days: plan.entry.retention_days,
    lease_directory: leaseDirectory,
    namespace_directory: namespaceDirectory,
    last_used_at: patch.last_used_at || current.last_used_at || null,
    backend_version: patch.backend_version || current.backend_version || plan.backend.version || null,
    stats: patch.stats ?? current.stats ?? null,
  };
  const temporary = `${plan.namespace.stateFile}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporary, plan.namespace.stateFile);
    await chmod(plan.namespace.stateFile, 0o600);
  } finally {
  }
}

async function pruneStaleLeases(namespace, identity) {
  await requireLeaseDirectoryIdentity(namespace, identity);
  const leasesDir = namespace.leasesDir;
  let names;
  try {
    names = await readdir(leasesDir);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const live = [];
  for (const name of names.sort()) {
    if (!/^[a-f0-9]{32}(?:\.[1-9][0-9]*)?\.json$/.test(name)) {
      live.push({ path: join(leasesDir, name), lease: null });
      continue;
    }
    const path = join(leasesDir, name);
    try {
      const contents = await readFile(path, "utf8");
      if (contents === "") {
        await removeOwnedFile(path, await readPrivateFileIdentity(path), identity);
        continue;
      }
      const lease = JSON.parse(contents);
      if (isPlainObject(lease) && pidIsAlive(lease.pid)) live.push({ path, lease });
      else await removeOwnedFile(path, await readPrivateFileIdentity(path), identity);
    } catch {
      live.push({ path, lease: null });
    }
  }
  return live;
}

function activeLeaseFamilies(live) {
  const families = new Set();
  for (const { path } of live) {
    const match = /^([a-f0-9]{32})(?:\.[1-9][0-9]*)?\.json$/.exec(basename(path));
    if (!match) throw new ContractError("unsafe-state", "namespace contains an unrecognized active lease");
    families.add(match[1]);
  }
  return families;
}

async function removeLease(plan) {
  if (!plan?.leasePath) return;
  await requireLeaseDirectoryIdentity(plan.namespace, plan.leaseDirectoryIdentity);
  if (
    resolve(dirname(plan.leasePath)) !== resolve(plan.namespace.leasesDir) ||
    !/^[a-f0-9]{32}(?:\.[1-9][0-9]*)?\.json$/.test(basename(plan.leasePath))
  ) {
    throw new ContractError("unsafe-state", "refusing invalid lease path");
  }
  try {
    await removeOwnedFile(plan.leasePath, await readPrivateFileIdentity(plan.leasePath), plan.leaseDirectoryIdentity);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function backendCacheSize(entry) {
  return Math.max(1, entry.max_bytes - NAMESPACE_METADATA_RESERVE);
}

export function cacheEnvironment(plan, baseEnv = process.env) {
  return {
    ...baseEnv,
    RUSTC_WRAPPER,
    FIRSTMATE_RUST_CACHE_BACKEND: plan.backend.executable,
    SCCACHE_CONF: plan.namespace.backendConfigFile,
    SCCACHE_DIR: plan.namespace.artifactsDir,
    SCCACHE_CACHE_SIZE: String(backendCacheSize(plan.entry)),
    SCCACHE_SERVER_UDS: plan.namespace.socketPath,
    SCCACHE_IDLE_TIMEOUT: "300",
    SCCACHE_CLIENT_SIDE: "1",
    SCCACHE_BASEDIRS: plan.project.root,
    FIRSTMATE_RUST_CACHE_LEASE_DIR: plan.namespace.leasesDir,
    FIRSTMATE_RUST_CACHE_LEASE_TOKEN: plan.leaseToken,
    FIRSTMATE_RUST_CACHE_LEASE_DEVICE: plan.leaseDirectoryIdentity.device,
    FIRSTMATE_RUST_CACHE_LEASE_INODE: plan.leaseDirectoryIdentity.inode,
    FIRSTMATE_RUST_CACHE_LEASE_SLOT_LIMIT: String(MAX_COMPILER_LEASE_SLOTS),
    FIRSTMATE_RUST_CACHE_FS_HELPER: plan.filesystemHelper,
    // Cargo's incremental artifacts are not cacheable by sccache. This standard
    // integration switch changes only the compilation strategy, not rustc's
    // requested outputs; an explicit conflicting value bypasses above.
    CARGO_INCREMENTAL: "0",
  };
}

async function reserveExecution(plan, env) {
  if (!(await supportsDescriptorBoundCacheOperationsHere())) {
    throw new ContractError("unsupported-platform", "descriptor-bound namespace operations are unavailable");
  }
  const filesystemHelper = await filesystemHelperExecutable();
  if (!filesystemHelper) {
    throw new ContractError("unsupported-platform", "descriptor-bound namespace operations are unavailable");
  }
  await ensureOwnedCacheRoot(plan.storage, true);
  await ensurePrivateDirectory(plan.storage.namespacesDir);
  await ensurePrivateDirectory(plan.storage.runtimeRoot);
  await ensurePrivateDirectory(plan.storage.trashDir);
  return withDirectoryLock(plan.storage.cacheLock, async () => {
    await ensurePrivateDirectory(plan.namespace.namespaceDir);
    await ensurePrivateDirectory(plan.namespace.artifactsDir);
    await ensurePrivateDirectory(plan.namespace.leasesDir);
    const namespaceDirectoryIdentity = await readDirectoryIdentity(plan.namespace.namespaceDir);
    const leaseDirectoryIdentity = await readLeaseDirectoryIdentity(plan.namespace.leasesDir);
    const executionPlan = { ...plan, namespaceDirectoryIdentity, leaseDirectoryIdentity, filesystemHelper };
    try {
      await writeFile(plan.namespace.backendConfigFile, "", { encoding: "utf8", mode: 0o600, flag: "wx" });
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
    await validatePrivateFile(plan.namespace.backendConfigFile);
    if ((await readFile(plan.namespace.backendConfigFile, "utf8")) !== "") {
      throw new ContractError("unsafe-state", "namespace sccache configuration changed unexpectedly");
    }
    await writeNamespaceState(executionPlan, { last_used_at: nowIso(), backend_version: plan.backend.version });
    const activeLeases = await pruneStaleLeases(plan.namespace, leaseDirectoryIdentity);
    await requireLeaseDirectoryIdentity(plan.namespace, leaseDirectoryIdentity);
    if (activeLeaseFamilies(activeLeases).size >= MAX_ACTIVE_LEASE_FAMILIES) {
      throw new ContractError("lease-capacity-exhausted", "namespace active lease capacity is exhausted");
    }
    const token = randomBytes(16).toString("hex");
    const leasePath = join(plan.namespace.leasesDir, `${token}.json`);
    await writeFile(
      leasePath,
      `${JSON.stringify({ pid: process.pid, token, created_at: nowIso() })}\n`,
      { encoding: "utf8", mode: 0o600, flag: "wx" },
    );
    const reservedPlan = {
      ...executionPlan,
      leasePath,
      leaseToken: token,
    };
    return { ...reservedPlan, environment: cacheEnvironment(reservedPlan, env) };
  });
}

export async function prepareExecution(cwd, env = process.env) {
  const initial = await inspectActivation(cwd, env);
  if (initial.state !== "ready") return initial;
  try {
    return await withDirectoryLock(initial.storage.configLock, async () => {
      const plan = await inspectActivation(cwd, env);
      if (plan.state !== "ready") return plan;
      return reserveExecution(plan, env);
    });
  } catch (error) {
    return {
      ...initial,
      state: "bypass",
      reason: error.code || "cache-state-unavailable",
      diagnostic: error.message,
    };
  }
}

function sumNumbers(value) {
  if (Number.isFinite(value)) return Number(value);
  if (Array.isArray(value)) return value.reduce((sum, child) => sum + sumNumbers(child), 0);
  if (isPlainObject(value)) return Object.values(value).reduce((sum, child) => sum + sumNumbers(child), 0);
  return 0;
}

function numericField(value, names) {
  if (!isPlainObject(value)) return null;
  for (const name of names) {
    if (Object.hasOwn(value, name)) {
      const metric = value[name];
      if (isPlainObject(metric) && Object.hasOwn(metric, "counts")) return sumNumbers(metric.counts);
      return sumNumbers(metric);
    }
  }
  for (const child of Object.values(value)) {
    const found = numericField(child, names);
    if (found !== null) return found;
  }
  return null;
}

async function queryStats(plan) {
  try {
    await lstat(plan.namespace.socketPath);
  } catch {
    return null;
  }
  const env = {
    ...process.env,
    SCCACHE_CONF: plan.namespace.backendConfigFile,
    SCCACHE_DIR: plan.namespace.artifactsDir,
    SCCACHE_CACHE_SIZE: String(backendCacheSize(plan.entry)),
    SCCACHE_SERVER_UDS: plan.namespace.socketPath,
    SCCACHE_CLIENT_SIDE: "1",
  };
  for (const name of Object.keys(env)) {
    if (name.startsWith("SCCACHE_") && !new Set([
      "SCCACHE_CONF",
      "SCCACHE_DIR",
      "SCCACHE_CACHE_SIZE",
      "SCCACHE_SERVER_UDS",
      "SCCACHE_CLIENT_SIDE",
    ]).has(name)) delete env[name];
  }
  try {
    const result = await collectProcess(plan.backend.executable, ["--show-stats", "--stats-format", "json"], {
      env,
      timeoutMs: 3_000,
      maxBytes: 256 * 1024,
    });
    if (result.code !== 0) return null;
    const raw = JSON.parse(result.stdout);
    return {
      compile_requests: numericField(raw, ["compile_requests", "compile requests"]),
      cache_hits: numericField(raw, ["cache_hits", "cache hits"]),
      cache_misses: numericField(raw, ["cache_misses", "cache misses"]),
      cache_timeouts: numericField(raw, ["cache_timeouts", "cache timeouts"]),
      cache_errors: numericField(raw, ["cache_errors", "cache errors"]),
      not_cached: numericField(raw, ["not_cached", "not cached"]),
    };
  } catch {
    return null;
  }
}

export async function finishExecution(plan) {
  if (!plan?.leasePath) return;
  try {
    await withDirectoryLock(plan.storage.cacheLock, async () => {
      await requireLeaseDirectoryIdentity(plan.namespace, plan.leaseDirectoryIdentity);
      const stats = await queryStats(plan);
      await requireLeaseDirectoryIdentity(plan.namespace, plan.leaseDirectoryIdentity);
      await writeNamespaceState(plan, { last_used_at: nowIso(), stats });
      await removeLease(plan);
    });
  } catch {
    await removeLease(plan).catch(() => {});
  }
}

async function directorySize(path) {
  let total = 0;
  let files = 0;
  async function walk(current) {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const child = join(current, entry.name);
      if (entry.isSymbolicLink()) {
        const info = await lstat(child);
        total += info.size;
        files += 1;
      } else if (entry.isDirectory()) {
        await walk(child);
      } else if (entry.isFile()) {
        const info = await stat(child);
        total += info.size;
        files += 1;
      }
    }
  }
  await walk(path);
  return { bytes: total, files };
}

async function stopServer(namespace, backend) {
  let socketExists = false;
  try {
    const info = await lstat(namespace.socketPath);
    socketExists = info.isSocket() || info.isFile();
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  if (!socketExists) return;
  if (!backend?.available) {
    throw new ContractError("backend-unavailable", "cannot prove the namespace server stopped without sccache");
  }
  const env = {
    PATH: process.env.PATH || "",
    HOME: process.env.HOME || homedir(),
    SCCACHE_SERVER_UDS: namespace.socketPath,
  };
  const result = await collectProcess(backend.executable, ["--stop-server"], {
    env,
    timeoutMs: 3_000,
    maxBytes: 64 * 1024,
  });
  if (result.code !== 0) {
    throw new ContractError("backend-unhealthy", "sccache server did not stop cleanly");
  }
}

async function cleanNamespaceById(storage, namespaceId, backend) {
  const namespace = namespacePaths(storage, namespaceId);
  if (!(await ensureOwnedCacheRoot(storage, false))) {
    try {
      if (!(await validateRuntimeDirectory(storage.runtimeRoot))) return { bytes: 0, files: 0 };
    } catch (error) {
      if (error?.code === "ENOENT") return { bytes: 0, files: 0 };
      throw error;
    }
    await stopServer(namespace, backend);
    await unlink(namespace.socketPath).catch(() => {});
    return { bytes: 0, files: 0 };
  }
  if (!(await supportsDescriptorBoundCacheOperationsHere())) {
    throw new ContractError("cleanup-unsupported", "descriptor-bound cleanup is unavailable; preserving cache data");
  }
  let before = { bytes: 0, files: 0 };
  await withDirectoryLock(storage.cacheLock, async () => {
    const namespacesIdentity = await readDirectoryIdentity(storage.namespacesDir);
    let info;
    try {
      info = await lstat(namespace.namespaceDir);
    } catch (error) {
      if (error?.code === "ENOENT") {
        await stopServer(namespace, backend);
        await unlink(namespace.socketPath).catch(() => {});
        return;
      }
      throw error;
    }
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new ContractError("unsafe-state", "namespace path is not a real directory");
    }
    const state = await readNamespaceState(namespace.stateFile);
    const namespaceDirectoryIdentity = state?.namespace_directory;
    const leaseDirectoryIdentity = state?.lease_directory;
    await requireDirectoryIdentity(namespace.namespaceDir, namespaceDirectoryIdentity, "namespace directory");
    await requireLeaseDirectoryIdentity(namespace, leaseDirectoryIdentity);
    const live = await pruneStaleLeases(namespace, leaseDirectoryIdentity);
    if (live.length > 0) throw new ContractError("cache-in-use", "namespace has active build leases");
    await requireDirectoryIdentity(namespace.namespaceDir, namespaceDirectoryIdentity, "namespace directory");
    await stopServer(namespace, backend);
    await requireDirectoryIdentity(namespace.namespaceDir, namespaceDirectoryIdentity, "namespace directory");
    before = await directorySize(namespace.namespaceDir);
    await removeOwnedTree(namespace.namespaceDir, namespaceDirectoryIdentity, namespacesIdentity);
    await unlink(namespace.socketPath).catch(() => {});
  });
  return before;
}

export async function enableProject(cwd, options = {}, env = process.env) {
  const project = await discoverProject(cwd, env);
  const context = validateContext(options.context || env.FIRSTMATE_RUST_CACHE_CONTEXT || DEFAULT_CONTEXT);
  const maxBytes = options.maxBytes ?? DEFAULT_NAMESPACE_MAX_BYTES;
  const retentionDays = options.retentionDays ?? DEFAULT_RETENTION_DAYS;
  integerInRange(maxBytes, 1024 ** 2, 1024 ** 4, "max size");
  integerInRange(retentionDays, 1, 365, "retention days");
  return mutateConfig(env, async (config) => {
    const key = entryKey(project.projectId, WORKLOAD, context);
    const index = config.projects.findIndex(
      (entry) => entryKey(entry.project_id, entry.workload, entry.security_context) === key,
    );
    const previous = index >= 0 ? config.projects[index] : null;
    if (previous && maxBytes < previous.max_bytes) {
      const previousPlan = planForEntry(previous, getStoragePaths(env));
      try {
        await lstat(previousPlan.namespace.namespaceDir);
        throw new ContractError("cache-present", "clean the selection before lowering its namespace limit");
      } catch (error) {
        if (error instanceof ContractError) throw error;
        if (error?.code !== "ENOENT") throw error;
      }
    }
    if (
      previous?.enabled &&
      previous.max_bytes === maxBytes &&
      previous.retention_days === retentionDays &&
      previous.project_label === project.label
    ) {
      return { changed: false, config, value: { changed: false, project, entry: previous } };
    }
    const timestamp = nowIso();
    const next = {
      project_id: project.projectId,
      project_label: project.label,
      workload: WORKLOAD,
      security_context: context,
      enabled: true,
      max_bytes: maxBytes,
      retention_days: retentionDays,
      created_at: previous?.created_at || timestamp,
      updated_at: timestamp,
      disabled_at: null,
    };
    const projects = [...config.projects];
    if (index >= 0) projects[index] = next;
    else projects.push(next);
    const candidate = validateConfig({ ...config, projects });
    return { changed: true, config: candidate, value: { changed: true, project, entry: next } };
  });
}

export async function disableProject(cwd, options = {}, env = process.env) {
  const project = await discoverProject(cwd, env);
  const context = validateContext(options.context || env.FIRSTMATE_RUST_CACHE_CONTEXT || DEFAULT_CONTEXT);
  const loaded = await readConfig(env);
  if (!loaded.exists) return { changed: false, project, entry: null };
  return mutateConfig(env, async (config) => {
    const index = config.projects.findIndex(
      (entry) =>
        entry.project_id === project.projectId &&
        entry.workload === WORKLOAD &&
        entry.security_context === context,
    );
    if (index < 0 || !config.projects[index].enabled) {
      return { changed: false, config, value: { changed: false, project, entry: config.projects[index] || null } };
    }
    const timestamp = nowIso();
    const projects = [...config.projects];
    projects[index] = { ...projects[index], enabled: false, updated_at: timestamp, disabled_at: timestamp };
    return {
      changed: true,
      config: { ...config, projects },
      value: { changed: true, project, entry: projects[index] },
    };
  });
}

export async function setGlobalLimit(maxBytes, env = process.env) {
  integerInRange(maxBytes, 1024 ** 2, 1024 ** 4, "global max size");
  return mutateConfig(env, async (config) => {
    if (config.global_max_bytes === maxBytes) {
      return { changed: false, config, value: { changed: false, maxBytes } };
    }
    const candidate = validateConfig({ ...config, global_max_bytes: maxBytes });
    return { changed: true, config: candidate, value: { changed: true, maxBytes } };
  });
}

function planForEntry(entry, storage) {
  return { entry, storage, namespace: namespacePaths(storage, namespaceIdFor(entry, storage)) };
}

export async function cleanProject(cwd, options = {}, env = process.env) {
  const loaded = await readConfig(env);
  if (!loaded.exists) return { cleaned: [], total: { bytes: 0, files: 0 } };
  let entries;
  if (options.all) {
    entries = [...loaded.config.projects];
  } else {
    const project = await discoverProject(cwd, env);
    const context = validateContext(options.context || env.FIRSTMATE_RUST_CACHE_CONTEXT || DEFAULT_CONTEXT);
    entries = loaded.config.projects.filter(
      (entry) =>
        entry.project_id === project.projectId &&
        entry.workload === WORKLOAD &&
      entry.security_context === context,
    );
  }
  const backend = entries.length > 0 ? await checkBackend(env) : null;
  const cleaned = [];
  const total = { bytes: 0, files: 0 };
  for (const entry of entries.sort(compareEntries)) {
    const plan = planForEntry(entry, loaded.paths);
    const removed = await cleanNamespaceById(loaded.paths, plan.namespace.namespaceId, backend);
    total.bytes += removed.bytes;
    total.files += removed.files;
    cleaned.push({ namespace: plan.namespace.namespaceId, project: entry.project_label, ...removed });
  }
  return { cleaned, total };
}

export async function forgetProject(cwd, options = {}, env = process.env) {
  const project = await discoverProject(cwd, env);
  const context = validateContext(options.context || env.FIRSTMATE_RUST_CACHE_CONTEXT || DEFAULT_CONTEXT);
  return mutateConfig(env, async (config) => {
    const matching = config.projects.filter(
      (entry) =>
        entry.project_id === project.projectId &&
        entry.workload === WORKLOAD &&
        entry.security_context === context,
    );
    if (matching.some((entry) => entry.enabled)) {
      throw new ContractError("selection-enabled", "disable the selection before forgetting it");
    }
    for (const entry of matching) {
      const plan = planForEntry(entry, getStoragePaths(env));
      try {
        await lstat(plan.namespace.namespaceDir);
        throw new ContractError("cache-present", "clean the selection before forgetting its identity");
      } catch (error) {
        if (error instanceof ContractError) throw error;
        if (error?.code !== "ENOENT") throw error;
      }
    }
    const projects = config.projects.filter((entry) => !matching.includes(entry));
    return {
      changed: projects.length !== config.projects.length,
      config: { ...config, projects },
      value: { changed: projects.length !== config.projects.length, project },
    };
  });
}

async function removeConfigFile(env) {
  const paths = getStoragePaths(env);
  if (!(await ensureOwnedConfigRoot(paths, false))) return;
  const configDirectoryIdentity = await readDirectoryIdentity(paths.configDir);
  if (!(await supportsDescriptorBoundCacheOperationsHere())) return;
  const configParentIdentity = await readDirectoryIdentity(dirname(paths.configDir));
  await requireDirectoryIdentity(paths.configDir, configDirectoryIdentity, "configuration directory");
  await removeOwnedTree(paths.configDir, configDirectoryIdentity, configParentIdentity);
}

export async function collectExpired(env = process.env) {
  const loaded = await readConfig(env);
  if (!loaded.exists) return { cleaned: [], total: { bytes: 0, files: 0 } };
  const backend = await checkBackend(env);
  const now = Date.now();
  const expired = [];
  for (const entry of loaded.config.projects) {
    const plan = planForEntry(entry, loaded.paths);
    const state = await readNamespaceState(plan.namespace.stateFile);
    if (!state?.last_used_at) continue;
    if (now - Date.parse(state.last_used_at) >= entry.retention_days * 86_400_000) expired.push(plan);
  }
  const cleaned = [];
  const total = { bytes: 0, files: 0 };
  for (const plan of expired) {
    try {
      const removed = await cleanNamespaceById(loaded.paths, plan.namespace.namespaceId, backend);
      total.bytes += removed.bytes;
      total.files += removed.files;
      cleaned.push({ namespace: plan.namespace.namespaceId, project: plan.entry.project_label, ...removed });
    } catch (error) {
      if (error.code !== "cache-in-use") throw error;
    }
  }
  return { cleaned, total };
}

export async function uninstall(options = {}, env = process.env) {
  const paths = getStoragePaths(env);
  let removed = { bytes: 0, files: 0 };
  if (!options.removeCache) {
    const loaded = await readConfig(env);
    if (loaded.exists) {
      await mutateConfig(env, async (config) => {
        const timestamp = nowIso();
        const projects = config.projects.map((entry) =>
          entry.enabled
            ? { ...entry, enabled: false, updated_at: timestamp, disabled_at: timestamp }
            : entry,
        );
        const changed = projects.some((entry, index) => entry !== config.projects[index]);
        return { changed, config: { ...config, projects }, value: null };
      });
    }
    return { cacheRemoved: false, configRetained: loaded.exists, removed };
  }
  if (options.removeCache) {
    if (!(await supportsDescriptorBoundCacheOperationsHere())) {
      throw new ContractError("cleanup-unsupported", "descriptor-bound cleanup is unavailable; preserving cache data");
    }
    await ensureDirectoryChain(dirname(paths.configLock));
    return withDirectoryLock(paths.configLock, async () => {
      const backend = await checkBackend(env);
      const configured = await readConfig(env);
      let namespaceNames = configured.config.projects.map(
        (entry) => planForEntry(entry, paths).namespace.namespaceId,
      );
      const cacheRootIdentity = await ensureOwnedCacheRoot(paths, false);
      const cacheExists = Boolean(cacheRootIdentity);
      try {
        namespaceNames.push(...(cacheExists ? await readdir(paths.namespacesDir) : []));
        namespaceNames = [...new Set(namespaceNames)];
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      for (const namespaceId of namespaceNames.sort()) {
        if (!/^[a-f0-9]{64}$/.test(namespaceId)) {
          throw new ContractError("unsafe-state", "cache root contains an unknown namespace entry");
        }
        const result = await cleanNamespaceById(paths, namespaceId, backend);
        removed.bytes += result.bytes;
        removed.files += result.files;
      }
      if (cacheExists) {
        await removeOwnedTree(paths.cacheRoot, cacheRootIdentity);
      }
      await removeConfigFile(env);
      return { cacheRemoved: true, configRetained: false, removed };
    });
  }
  return { cacheRemoved: false, configRetained: false, removed };
}

export async function statusForProject(cwd, options = {}, env = process.env) {
  let activation;
  try {
    activation = await inspectActivation(cwd, env);
  } catch (error) {
    activation = {
      state: "bypass",
      reason: error.code || "status-failed",
      diagnostic: error.message,
      backend: null,
      storage: getStoragePaths(env),
    };
  }
  let size = { bytes: 0, files: 0 };
  let state = null;
  if (activation.namespace) {
    size = await directorySize(activation.namespace.namespaceDir).catch(() => ({ bytes: 0, files: 0 }));
    state = await readNamespaceState(activation.namespace.stateFile);
  }
  const result = {
    schema: "firstmate-rust-cache.status.v1",
    state: activation.state,
    reason: activation.reason,
    backend: activation.backend?.available
      ? { available: true, name: "sccache", version: activation.backend.version }
      : { available: false, name: "sccache", reason: activation.backend?.reason || "backend-unavailable" },
    project: activation.project
      ? { id: activation.project.projectId, label: activation.project.label }
      : null,
    workload: activation.entry?.workload || WORKLOAD,
    security_context: activation.entry?.security_context || env.FIRSTMATE_RUST_CACHE_CONTEXT || DEFAULT_CONTEXT,
    namespace: activation.namespace?.namespaceId || null,
    cache: {
      bytes: size.bytes,
      files: size.files,
      max_bytes: activation.entry?.max_bytes || null,
      global_max_bytes: activation.config?.global_max_bytes || DEFAULT_GLOBAL_MAX_BYTES,
      retention_days: activation.entry?.retention_days || null,
      last_used_at: state?.last_used_at || null,
    },
    stats: state?.stats || null,
  };
  if (options.showPaths) {
    result.paths = {
      config: activation.storage.configFile,
      cache: activation.storage.cacheRoot,
    };
  }
  return result;
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return "unknown";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  const precision = index === 0 || value >= 10 ? 0 : 1;
  return `${value.toFixed(precision)} ${units[index]}`;
}

export function formatStatus(status) {
  const lines = [
    `state: ${status.state}${status.reason ? ` (${status.reason})` : ""}`,
    `backend: ${status.backend.available ? `sccache ${status.backend.version}` : `unavailable (${status.backend.reason})`}`,
    `project: ${status.project ? `${status.project.label} [${status.project.id.slice(0, 12)}]` : "unselected"}`,
    `workload: ${status.workload}; context: ${status.security_context}`,
    `namespace: ${status.namespace ? status.namespace.slice(0, 16) : "none"}`,
    `cache: ${formatBytes(status.cache.bytes)}${status.cache.max_bytes ? ` / ${formatBytes(status.cache.max_bytes)}` : ""}; global limit: ${formatBytes(status.cache.global_max_bytes)}`,
    `retention: ${status.cache.retention_days ? `${status.cache.retention_days} days` : "not configured"}; last use: ${status.cache.last_used_at || "never"}`,
  ];
  if (status.stats) {
    lines.push(
      `hits/misses: ${status.stats.cache_hits ?? "unsupported"}/${status.stats.cache_misses ?? "unsupported"}; requests: ${status.stats.compile_requests ?? "unsupported"}`,
    );
  } else {
    lines.push("hits/misses: unavailable (no backend snapshot)");
  }
  if (status.paths) {
    lines.push(`config path: ${status.paths.config}`, `cache path: ${status.paths.cache}`);
  }
  return `${lines.join("\n")}\n`;
}

export function parseSize(value) {
  if (typeof value !== "string") throw new ContractError("invalid-size", "size is required");
  const match = value.trim().match(/^(\d+)(B|KiB|MiB|GiB|TiB)?$/i);
  if (!match) throw new ContractError("invalid-size", "size must look like 512MiB, 1GiB, or an integer byte count");
  const powers = { b: 0, kib: 1, mib: 2, gib: 3, tib: 4 };
  const multiplier = 1024 ** powers[(match[2] || "B").toLowerCase()];
  const result = Number(match[1]) * multiplier;
  if (!Number.isSafeInteger(result)) throw new ContractError("invalid-size", "size is too large");
  return result;
}

export function spawnInherited(command, args, options = {}) {
  return spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: "inherit",
  });
}
