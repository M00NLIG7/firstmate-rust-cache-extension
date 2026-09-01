import {
  ContractError,
  cleanProject,
  collectExpired,
  disableProject,
  enableProject,
  forgetProject,
  formatBytes,
  formatStatus,
  parseSize,
  readConfig,
  setGlobalLimit,
  statusForProject,
  uninstall,
} from "./core.mjs";

export const HELP = `Firstmate Rust Cache

Usage:
  firstmate-rust-cache status [--project DIR] [--json] [--show-paths]
  firstmate-rust-cache enable [--project DIR] [--context NAME] [--max-size SIZE] [--retention-days N]
  firstmate-rust-cache disable [--project DIR] [--context NAME]
  firstmate-rust-cache limits --max-size SIZE
  firstmate-rust-cache clean [--project DIR] [--context NAME] [--all]
  firstmate-rust-cache forget [--project DIR] [--context NAME]
  firstmate-rust-cache gc
  firstmate-rust-cache config [--json]
  firstmate-rust-cache uninstall [--keep-cache | --remove-cache]
  firstmate-rust-cache run -- COMMAND [ARG...]

SIZE uses binary units, for example 512MiB or 4GiB. enable selects only the
current Git origin, cargo-rustc workload, and named security context. Installation
without enablement is inert. clean is targeted to this extension's namespace;
uninstall preserves cache data unless --remove-cache is explicit.
`;

function parseInteger(value, label) {
  if (!/^\d+$/.test(value || "")) throw new ContractError("invalid-argument", `${label} must be an integer`);
  const result = Number(value);
  if (!Number.isSafeInteger(result)) throw new ContractError("invalid-argument", `${label} is too large`);
  return result;
}

export function tokenizeAdminArgs(text) {
  const tokens = [];
  let token = "";
  let quote = null;
  let escaped = false;
  let started = false;
  for (const character of text) {
    if (escaped) {
      token += character;
      escaped = false;
      started = true;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      started = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = null;
      else token += character;
      started = true;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      started = true;
      continue;
    }
    if (/\s/.test(character)) {
      if (started) {
        tokens.push(token);
        token = "";
        started = false;
      }
      continue;
    }
    token += character;
    started = true;
  }
  if (escaped || quote) throw new ContractError("invalid-argument", "unterminated quote or escape");
  if (started) tokens.push(token);
  return tokens;
}

function parseOptions(argv) {
  const options = {
    project: null,
    context: null,
    maxBytes: null,
    retentionDays: null,
    json: false,
    showPaths: false,
    all: false,
    removeCache: false,
    keepCache: false,
  };
  const positionals = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const take = (label) => {
      index += 1;
      if (index >= argv.length) throw new ContractError("invalid-argument", `${label} requires a value`);
      return argv[index];
    };
    switch (argument) {
      case "--project":
        options.project = take("--project");
        break;
      case "--context":
        options.context = take("--context");
        break;
      case "--max-size":
        options.maxBytes = parseSize(take("--max-size"));
        break;
      case "--retention-days":
        options.retentionDays = parseInteger(take("--retention-days"), "--retention-days");
        break;
      case "--json":
        options.json = true;
        break;
      case "--show-paths":
        options.showPaths = true;
        break;
      case "--all":
        options.all = true;
        break;
      case "--remove-cache":
        options.removeCache = true;
        break;
      case "--keep-cache":
        options.keepCache = true;
        break;
      default:
        if (argument.startsWith("--")) throw new ContractError("invalid-argument", `unknown option ${argument}`);
        positionals.push(argument);
    }
  }
  return { options, positionals };
}

function jsonLine(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function noUnexpected(positionals) {
  if (positionals.length > 0) {
    throw new ContractError("invalid-argument", `unexpected argument ${JSON.stringify(positionals[0])}`);
  }
}

export async function executeAdmin(argv, cwd = process.cwd(), env = process.env) {
  const command = argv[0] || "status";
  if (new Set(["help", "--help", "-h"]).has(command)) {
    return { code: 0, stdout: HELP, stderr: "", reload: false };
  }
  let options = { json: false };

  try {
    const parsed = parseOptions(argv.slice(1));
    options = parsed.options;
    const { positionals } = parsed;
    const project = options.project || cwd;
    switch (command) {
      case "status": {
        noUnexpected(positionals);
        const status = await statusForProject(project, { showPaths: options.showPaths }, env);
        return { code: 0, stdout: options.json ? jsonLine(status) : formatStatus(status), stderr: "", reload: false };
      }
      case "enable": {
        noUnexpected(positionals);
        const result = await enableProject(
          project,
          {
            context: options.context || undefined,
            maxBytes: options.maxBytes ?? undefined,
            retentionDays: options.retentionDays ?? undefined,
          },
          env,
        );
        const output = {
          state: "enabled",
          changed: result.changed,
          project: result.project.label,
          project_id: result.project.projectId,
          workload: result.entry.workload,
          security_context: result.entry.security_context,
          max_bytes: result.entry.max_bytes,
          retention_days: result.entry.retention_days,
        };
        return {
          code: 0,
          stdout: options.json
            ? jsonLine(output)
            : `enabled: ${output.project} (${output.workload}/${output.security_context}); limit ${formatBytes(output.max_bytes)}, retention ${output.retention_days} days${output.changed ? "" : " (unchanged)"}\n`,
          stderr: "",
          reload: result.changed,
        };
      }
      case "disable": {
        noUnexpected(positionals);
        const result = await disableProject(project, { context: options.context || undefined }, env);
        const output = {
          state: "disabled",
          changed: result.changed,
          project: result.project.label,
          cache_preserved: true,
        };
        return {
          code: 0,
          stdout: options.json
            ? jsonLine(output)
            : `disabled: ${output.project}; cache preserved${output.changed ? "" : " (unchanged)"}\n`,
          stderr: "",
          reload: result.changed,
        };
      }
      case "limits": {
        noUnexpected(positionals);
        if (options.maxBytes === null) throw new ContractError("invalid-argument", "limits requires --max-size SIZE");
        const result = await setGlobalLimit(options.maxBytes, env);
        const output = { global_max_bytes: result.maxBytes, changed: result.changed };
        return {
          code: 0,
          stdout: options.json
            ? jsonLine(output)
            : `global limit: ${formatBytes(result.maxBytes)}${result.changed ? "" : " (unchanged)"}\n`,
          stderr: "",
          reload: false,
        };
      }
      case "clean": {
        noUnexpected(positionals);
        const result = await cleanProject(
          project,
          { all: options.all, context: options.context || undefined },
          env,
        );
        const output = {
          outcome: "cleaned",
          namespaces: result.cleaned.length,
          removed_bytes: result.total.bytes,
          removed_files: result.total.files,
        };
        return {
          code: 0,
          stdout: options.json
            ? jsonLine(output)
            : `cleanup: ${output.namespaces} namespace(s), ${formatBytes(output.removed_bytes)}, ${output.removed_files} file(s) removed\n`,
          stderr: "",
          reload: false,
        };
      }
      case "forget": {
        noUnexpected(positionals);
        const result = await forgetProject(project, { context: options.context || undefined }, env);
        const output = { outcome: "forgotten", changed: result.changed, project: result.project.label };
        return {
          code: 0,
          stdout: options.json
            ? jsonLine(output)
            : `forgotten: ${output.project}${output.changed ? "" : " (unchanged)"}\n`,
          stderr: "",
          reload: result.changed,
        };
      }
      case "gc": {
        noUnexpected(positionals);
        const result = await collectExpired(env);
        const output = {
          outcome: "collected",
          namespaces: result.cleaned.length,
          removed_bytes: result.total.bytes,
          removed_files: result.total.files,
        };
        return {
          code: 0,
          stdout: options.json
            ? jsonLine(output)
            : `retention cleanup: ${output.namespaces} namespace(s), ${formatBytes(output.removed_bytes)} removed\n`,
          stderr: "",
          reload: false,
        };
      }
      case "config": {
        noUnexpected(positionals);
        const loaded = await readConfig(env);
        const output = { exists: loaded.exists, ...loaded.config };
        return {
          code: 0,
          stdout: jsonLine(output),
          stderr: "",
          reload: false,
        };
      }
      case "uninstall": {
        noUnexpected(positionals);
        if (options.keepCache && options.removeCache) {
          throw new ContractError("invalid-argument", "choose only one of --keep-cache and --remove-cache");
        }
        const result = await uninstall({ removeCache: options.removeCache }, env);
        const output = {
          outcome: "uninstalled",
          cache: result.cacheRemoved ? "removed" : "preserved",
          configuration: result.configRetained ? "retained-cache-index" : "removed",
          removed_bytes: result.removed.bytes,
          removed_files: result.removed.files,
        };
        return {
          code: 0,
          stdout: options.json
            ? jsonLine(output)
            : `uninstall preparation: configuration ${output.configuration}; cache ${output.cache}${result.cacheRemoved ? ` (${formatBytes(output.removed_bytes)})` : ""}\n`,
          stderr: "",
          reload: true,
        };
      }
      default:
        throw new ContractError("invalid-command", `unknown command ${JSON.stringify(command)}; run --help`);
    }
  } catch (error) {
    const code = error instanceof ContractError ? error.code : "internal-error";
    const message = error instanceof Error ? error.message : String(error);
    return {
      code: 2,
      stdout: "",
      stderr: options.json ? jsonLine({ error: code, diagnostic: message }) : `error: ${message}\n`,
      reload: false,
    };
  }
}
