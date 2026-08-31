#!/usr/bin/env node

/**
 * Executable mechanics for the public Firstmate Rust Cache contract in README.md.
 * This command never searches a Firstmate home and never mutates a project tree.
 */

import { executeAdmin, HELP } from "../lib/admin.mjs";
import { finishExecution, prepareExecution, spawnInherited } from "../lib/core.mjs";

const SIGNAL_EXIT = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 };

async function runChild(argv) {
  const separator = argv.indexOf("--");
  if (separator < 0 || separator === argv.length - 1) {
    process.stderr.write("error: run requires -- COMMAND [ARG...]\n");
    return 2;
  }
  if (separator !== 0) {
    process.stderr.write(`error: unexpected run argument ${JSON.stringify(argv[0])}\n`);
    return 2;
  }
  const [command, ...args] = argv.slice(1);
  let interrupted = null;
  let child = null;
  let plan = null;
  const handlers = new Map();
  for (const signal of Object.keys(SIGNAL_EXIT)) {
    const handler = () => {
      interrupted = signal;
      child?.kill(signal);
    };
    handlers.set(signal, handler);
    process.on(signal, handler);
  }

  try {
    plan = await prepareExecution(process.cwd(), process.env);
    if (interrupted) return SIGNAL_EXIT[interrupted] || 1;
    const environment = plan.state === "ready" ? plan.environment : process.env;
    if (plan.state === "ready") {
      process.stderr.write(`rust-cache: enabled namespace ${plan.namespace.namespaceId.slice(0, 16)}\n`);
    } else {
      process.stderr.write(`rust-cache: ${plan.state} (${plan.reason}); running ordinary command\n`);
    }

    child = spawnInherited(command, args, { cwd: process.cwd(), env: environment });
    if (interrupted) child.kill(interrupted);
    const result = await new Promise((resolvePromise) => {
      child.on("error", (error) => resolvePromise({ error }));
      child.on("close", (code, signal) => resolvePromise({ code, signal }));
    });
    if (result.error) {
      process.stderr.write(`error: failed to execute ${JSON.stringify(command)}: ${result.error.message}\n`);
      return 127;
    }
    if (interrupted) return SIGNAL_EXIT[interrupted] || 1;
    if (result.signal) return SIGNAL_EXIT[result.signal] || 1;
    return result.code ?? 1;
  } finally {
    for (const [signal, handler] of handlers) process.off(signal, handler);
    await finishExecution(plan);
  }
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === "run") return runChild(argv.slice(1));
  const result = await executeAdmin(argv, process.cwd(), process.env);
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  return result.code;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.stderr.write(`\n${HELP}`);
    process.exitCode = 2;
  });
