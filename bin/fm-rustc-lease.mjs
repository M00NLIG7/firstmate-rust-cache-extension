#!/usr/bin/env node
import { constants as fsConstants } from "node:fs";
import { lstat, open, unlink } from "node:fs/promises";
import { basename, join, resolve, sep } from "node:path";

const approvedAncestorSymlinks = new Set(process.platform === "darwin" ? ["/var", "/tmp"] : []);
const tokenPattern = /^[0-9a-f]{32}$/;

async function validateDirectory(path) {
  const pieces = resolve(path).split(sep).filter(Boolean);
  let current = sep;
  for (const piece of pieces) {
    current = join(current, piece);
    let info;
    try {
      info = await lstat(current);
    } catch {
      return false;
    }
    if (info.isSymbolicLink()) {
      if (approvedAncestorSymlinks.has(current)) continue;
      return false;
    }
    if (!info.isDirectory()) return false;
    if (current === resolve(path)) {
      if (typeof process.getuid === "function" && info.uid !== process.getuid()) return false;
      if ((info.mode & 0o077) !== 0) return false;
    }
  }
  return true;
}

async function isRegularLease(path) {
  try {
    const info = await lstat(path);
    return info.isFile() && !info.isSymbolicLink();
  } catch {
    return false;
  }
}

function leaseName(token, pid) {
  if (!tokenPattern.test(token) || !/^[1-9][0-9]*$/.test(pid)) return null;
  return `${token}.${pid}.json`;
}

async function create(directory, token, pid) {
  const name = leaseName(token, pid);
  if (!name || !(await validateDirectory(directory))) return false;
  const path = join(resolve(directory), name);
  let lease;
  try {
    lease = await open(
      path,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
      0o600,
    );
    await lease.writeFile(`${JSON.stringify({ pid: Number(pid), token, created_at: new Date().toISOString() })}\n`);
  } catch {
    return false;
  } finally {
    await lease?.close().catch(() => {});
  }
  if (!(await validateDirectory(directory)) || !(await isRegularLease(path))) return false;
  process.stdout.write(path);
  return true;
}

async function remove(directory, path) {
  const name = basename(path);
  if (!/^[0-9a-f]{32}\.[1-9][0-9]*\.json$/.test(name)) return false;
  if (resolve(path) !== join(resolve(directory), name)) return false;
  if (!(await validateDirectory(directory)) || !(await isRegularLease(path))) return false;
  await unlink(path).catch(() => {});
  return true;
}

const [operation, ...args] = process.argv.slice(2);
const success =
  operation === "create" && args.length === 3
    ? await create(args[0], args[1], args[2])
    : operation === "remove" && args.length === 2
      ? await remove(args[0], args[1])
      : false;
process.exitCode = success ? 0 : 1;
