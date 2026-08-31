#!/usr/bin/env node
import { spawn } from "node:child_process";

const approvedAncestorSymlinks = process.platform === "darwin" ? ["/var", "/tmp"] : [];
const helper = String.raw`
import json
import os
import stat
import sys

APPROVED = set(sys.argv[1].split("\x1f")) if sys.argv[1] else set()
operation, directory, token, pid_or_path = sys.argv[2:]

def open_directory(path):
    resolved = os.path.abspath(path)
    parts = [part for part in resolved.split(os.sep) if part]
    fd = os.open(os.sep, os.O_RDONLY | os.O_DIRECTORY)
    current = ""
    try:
        for part in parts:
            current += os.sep + part
            flags = os.O_RDONLY | os.O_DIRECTORY
            if current not in APPROVED:
                flags |= os.O_NOFOLLOW
            next_fd = os.open(part, flags, dir_fd=fd)
            os.close(fd)
            fd = next_fd
        info = os.fstat(fd)
        if info.st_uid != os.getuid() or info.st_mode & 0o077:
            raise OSError("unsafe directory")
        return fd, resolved
    except:
        os.close(fd)
        raise

def valid_name(name):
    pieces = name.split(".")
    return len(pieces) == 3 and len(pieces[0]) == 32 and all(c in "0123456789abcdef" for c in pieces[0]) and pieces[1].isdigit() and int(pieces[1]) > 0 and pieces[2] == "json"

def create():
    if len(token) != 32 or any(c not in "0123456789abcdef" for c in token) or not pid_or_path.isdigit() or int(pid_or_path) <= 0:
        return False
    name = token + "." + pid_or_path + ".json"
    fd, resolved = open_directory(directory)
    created = False
    try:
        lease_fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=fd)
        created = True
        try:
            payload = (json.dumps({"pid": int(pid_or_path), "token": token}) + "\n").encode()
            if os.write(lease_fd, payload) != len(payload):
                raise OSError("incomplete lease write")
        finally:
            os.close(lease_fd)
        info = os.lstat(name, dir_fd=fd)
        if not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode):
            raise OSError("unsafe lease")
        print(os.path.join(resolved, name), end="")
        return True
    except:
        if created:
            try:
                os.unlink(name, dir_fd=fd)
            except:
                pass
        return False
    finally:
        os.close(fd)

def remove():
    name = os.path.basename(pid_or_path)
    if not valid_name(name) or os.path.abspath(pid_or_path) != os.path.join(os.path.abspath(directory), name):
        return False
    fd, _ = open_directory(directory)
    try:
        info = os.lstat(name, dir_fd=fd)
        if not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode):
            return False
        os.unlink(name, dir_fd=fd)
        return True
    except:
        return False
    finally:
        os.close(fd)

try:
    success = create() if operation == "create" else remove() if operation == "remove" else False
except:
    success = False
sys.exit(0 if success else 1)
`;

function invoke(args) {
  return new Promise((resolvePromise) => {
    const child = spawn("python3", ["-c", helper, approvedAncestorSymlinks.join("\x1f"), ...args], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.on("error", () => resolvePromise(null));
    child.on("close", (code) => resolvePromise(code === 0 ? stdout : null));
  });
}

const [operation, ...args] = process.argv.slice(2);
const output =
  operation === "create" && args.length === 3
    ? await invoke([operation, ...args])
    : operation === "remove" && args.length === 2
      ? await invoke([operation, args[0], "", args[1]])
      : null;
if (output === null) process.exitCode = 1;
else if (operation === "create") process.stdout.write(output);
