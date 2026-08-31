/**
 * Pi integration for Firstmate Rust Cache.
 *
 * The package stays inert until README.md's explicit project/workload selection
 * exists. Only then does it use Pi's supported createBashTool spawnHook to add a
 * local Cargo RUSTC_WRAPPER environment. Every runtime error delegates to Pi's
 * ordinary bash implementation.
 */

import { createBashTool } from "@earendil-works/pi-coding-agent";
import { executeAdmin, tokenizeAdminArgs } from "../lib/admin.mjs";
import {
  cacheEnvironment,
  collectExpired,
  directCargoArguments,
  finishExecution,
  inspectActivation,
  isCargoInvocationWithinProject,
  prepareExecution,
  statusForProject,
} from "../lib/core.mjs";

/** @param {import("@earendil-works/pi-coding-agent").ExtensionAPI} pi */
export default function firstmateRustCache(pi) {
  let bashRegistered = false;

  const updateStatus = async (ctx) => {
    const status = await statusForProject(ctx.cwd, {}, process.env);
    const namespace = status.namespace ? ` ${status.namespace.slice(0, 8)}` : "";
    const text =
      status.state === "ready"
        ? `rust cache: on${namespace}`
        : status.state === "bypass"
          ? `rust cache: bypass (${status.reason})`
          : "rust cache: off";
    ctx.ui.setStatus("firstmate-rust-cache", text);
  };

  const registerCachedBash = (cwd) => {
    if (bashRegistered) return;
    const publicShape = createBashTool(cwd);
    pi.registerTool({
      ...publicShape,
      async execute(toolCallId, params, signal, onUpdate, ctx) {
        const cargo = directCargoArguments(params?.command);
        if (!cargo || !(await isCargoInvocationWithinProject(ctx.cwd, cargo[0], cargo.slice(1), process.env))) {
          const ordinary = createBashTool(ctx.cwd);
          return ordinary.execute(toolCallId, params, signal, onUpdate);
        }
        let plan;
        try {
          plan = await prepareExecution(ctx.cwd, process.env);
        } catch {
          const ordinary = createBashTool(ctx.cwd);
          return ordinary.execute(toolCallId, params, signal, onUpdate);
        }
        if (plan.state !== "ready") {
          const ordinary = createBashTool(ctx.cwd);
          return ordinary.execute(toolCallId, params, signal, onUpdate);
        }

        let cached;
        try {
          cached = createBashTool(ctx.cwd, {
            spawnHook: ({ command, cwd: commandCwd, env }) => ({
              command,
              cwd: commandCwd,
              env: cacheEnvironment(plan, env),
            }),
          });
        } catch {
          await finishExecution(plan).catch(() => {});
          const ordinary = createBashTool(ctx.cwd);
          return ordinary.execute(toolCallId, params, signal, onUpdate);
        }

        try {
          return await cached.execute(toolCallId, params, signal, onUpdate);
        } finally {
          await finishExecution(plan).catch(() => {});
        }
      },
    });
    bashRegistered = true;
  };

  pi.registerCommand("rust-cache", {
    description: "Manage explicitly selected local Rust compiler caching",
    handler: async (args, ctx) => {
      let argv;
      try {
        argv = tokenizeAdminArgs(args || "status");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
        return;
      }
      const result = await executeAdmin(argv, ctx.cwd, process.env);
      const message = (result.stdout || result.stderr).trim();
      if (message) ctx.ui.notify(message, result.code === 0 ? "info" : "error");
      if (result.reload) {
        await ctx.reload();
        return;
      }
      await updateStatus(ctx);
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    const activation = await inspectActivation(ctx.cwd, process.env);
    if (activation.state === "ready") {
      registerCachedBash(ctx.cwd);
      collectExpired(process.env).catch(() => {});
    }
    await updateStatus(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    ctx.ui.setStatus("firstmate-rust-cache", undefined);
  });
}
