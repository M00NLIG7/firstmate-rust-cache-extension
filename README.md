# Firstmate Rust Cache

A **default-off, local-only Pi package** that gives explicitly selected Firstmate
Pi workers a Cargo compiler cache without changing Firstmate core. It uses
[sccache](https://github.com/mozilla/sccache) as the maintained backend and
Cargo's standard `RUSTC_WRAPPER` integration.

This README is the authoritative owner of configuration, cache identity,
lifecycle, correctness, and cleanup contracts. `firstmate-rust-cache --help`
and executable headers own command mechanics.

## Scope

Firstmate's current public external-package capability is only
[`process-event-adapter/1`](https://github.com/kunchenguid/firstmate/blob/main/docs/extension-bindings.md):
it explicitly has no worker-launch grant, hook, instruction injection, or project
discovery, and it never discovers Pi packages. This repository therefore does
**not** pretend to be a `firstmate-extension.json` package. It uses Pi's public
package and `createBashTool(..., { spawnHook })` contracts instead, so its
automatic path reaches only Pi-based workers. Other axes are listed under
[Support matrix](#support-matrix).

Installation only registers `/rust-cache`; it does not override `bash`, create
configuration, start sccache, or create cache directories. A valid selection for
the current Git origin, the `cargo-rustc` workload, and a security context must
exist before the package installs its cached `bash` wrapper for that Pi session.

## Requirements

- macOS or Linux
- Node.js 20 or newer
- Pi 0.84.x (the tested public extension contract)
- Rust/Cargo
- sccache 0.17.0 or newer on `PATH`

sccache 0.17's client-side mode is required so each disposable worktree can use
its own `SCCACHE_BASEDIRS` while a namespace's small backend-owned server shares
stats and cache state. The extension adds no daemon, scheduler, monitor, remote
cache, telemetry, or network service. sccache's server has a 300-second idle
timeout.

## Install and explicitly opt in

Review and pin a release tag or commit, then install it as a Pi package:

```sh
pi install git:github.com/M00NLIG7/firstmate-rust-cache-extension@<reviewed-ref>
```

Install sccache with its maintained release/package-manager instructions. Start
Pi in the repository to select, then run:

```text
/rust-cache status
/rust-cache enable --max-size 1GiB --retention-days 30
/rust-cache status
```

`enable` selects exactly the current worktree's single sanitized `origin` URL,
`cargo-rustc`, and `local-user` security context. Pi reloads after a changed
selection. A non-default context is explicit on both configuration and runtime:

```text
/rust-cache enable --context customer-a
```

Launch that Pi/Firstmate worker with
`FIRSTMATE_RUST_CACHE_CONTEXT=customer-a`. An absent or malformed context does
not fall back to another selection.

The package also ships `firstmate-rust-cache` for source checkouts or ordinary
npm executable installation. Its `run -- COMMAND [ARG...]` path exercises the
same selection and is useful for operator diagnostics; automatic Firstmate
integration remains the Pi `bash` path.

## Inspectable configuration

`/rust-cache config` prints the validated configuration. `/rust-cache status
--show-paths` explicitly reveals its location. Defaults are:

| Platform | Configuration | Cache |
| --- | --- | --- |
| Linux | `${XDG_CONFIG_HOME:-~/.config}/firstmate-rust-cache/config.json` | `${XDG_CACHE_HOME:-~/.cache}/firstmate-rust-cache/` |
| macOS | `~/Library/Application Support/Firstmate Rust Cache/config.json` | `~/Library/Caches/Firstmate Rust Cache/` |

`FIRSTMATE_RUST_CACHE_CONFIG_DIR`, `FIRSTMATE_RUST_CACHE_CACHE_DIR`, and
`FIRSTMATE_RUST_CACHE_RUNTIME_DIR` are specialized/test overrides. The runtime
root contains only short-lived private Unix sockets. Configuration is mode
`0600`; owned directories are mode `0700`. A linked, foreign-owned, overly
permissive, malformed, duplicate, or unknown-version configuration bypasses
caching.

Example (IDs and timestamps abbreviated):

```json
{
  "schema": "firstmate-rust-cache.config.v1",
  "global_max_bytes": 4294967296,
  "projects": [
    {
      "project_id": "<sha256 of sanitized origin identity>",
      "project_label": "github.com/example/project",
      "workload": "cargo-rustc",
      "security_context": "local-user",
      "enabled": true,
      "max_bytes": 1073741824,
      "retention_days": 30,
      "created_at": "<ISO-8601>",
      "updated_at": "<ISO-8601>",
      "disabled_at": null
    }
  ]
}
```

Remote credentials, query strings, source paths, Firstmate task IDs, session
files, and model/provider credentials are never stored. Repositories without
exactly one supported network `origin` are unsupported rather than guessed.

## Cache identity and correctness boundary

Identity has two layers:

1. This package gives each sanitized Git origin + `cargo-rustc` workload +
   explicit security context + OS platform + numeric user a distinct physical
   namespace and private sccache Unix socket. Unrelated repositories and
   same-machine security contexts therefore never share cache storage.
2. Inside that namespace, sccache's Rust key includes source/dependency content,
   the rustc path, host, sysroot and toolchain libraries, parsed rustc arguments,
   and tracked environment. Compiler flags, Cargo features, and targets arrive as
   rustc arguments, so they cannot hit an incompatible entry. See sccache's
   [cache-key documentation](https://github.com/mozilla/sccache/blob/main/docs/Caching.md)
   and [Rust support boundary](https://github.com/mozilla/sccache/blob/main/docs/Rust.md).

`SCCACHE_BASEDIRS` normalizes only the selected worktree root, allowing the same
project namespace to reuse results across disposable paths. The extension forces
local disk storage. It points `SCCACHE_CONF` at an owned empty configuration and supplies
only local-disk environment settings, so a user's default sccache configuration
cannot silently select a remote backend. If `RUSTC_WRAPPER`,
`RUSTC_WORKSPACE_WRAPPER`, any ambient `SCCACHE_*` setting, or a nonzero explicit
`CARGO_INCREMENTAL` already exists, it leaves the command untouched rather than
combining unknown wrappers, remote caches, credentials, or compilation modes.

The fail-open wrapper first asks sccache to run Cargo's exact rustc invocation.
If sccache exits nonzero for any reason, its diagnostics are discarded and the
original rustc command runs directly; cache health cannot block a build or
replace ordinary compiler output. Missing/old/unhealthy backends, unsupported
platforms/projects, unsafe state, lock contention, and overlong socket paths also
run Pi's ordinary bash tool unchanged.

The selected environment sets `CARGO_INCREMENTAL=0`, the standard sccache
requirement; this changes Cargo's compilation strategy but not the requested
rustc outputs. sccache documents important Rust limitations: compiler
invocations outside its supported shape are not cached, and procedural macros
that read undeclared filesystem inputs may not be tracked correctly. Enable only
repositories whose build scripts/procedural macros are
deterministic from declared source and environment. This package does not claim
to sandbox hostile build code or make an unsound upstream cache key sound. A
compiler error may be compiled twice because fail-open cannot safely distinguish
an ordinary rustc failure from backend failure before rerunning rustc directly.

## Limits, retention, status, and cleanup

The default aggregate allocation is 4 GiB and each selection defaults to 1 GiB.
The sum of configured namespace maxima may never exceed the aggregate limit;
manual invalid edits bypass caching. Change the aggregate only when existing
allocations fit:

```text
/rust-cache limits --max-size 8GiB
```

sccache receives each namespace maximum minus a 256 KiB reserve for the owned
state/config files, so backend artifacts plus namespace metadata remain inside
the configured allocation. Retention defaults to 30 days and is
applied without a monitor at Pi session start and by explicit `gc`; an in-use
namespace is skipped. `disable` is idempotent and preserves data:

```text
/rust-cache disable
/rust-cache gc
/rust-cache clean
/rust-cache forget
```

`clean` removes only the current selected namespace (`--all` means every
namespace under this extension's private cache root). It takes an identity lock,
refuses live build leases, stops only that namespace's sccache socket, atomically
retires the directory, then removes it without following links. `forget` requires
the selection to be disabled **and cleaned**; it never strands unallocated cache
data by forgetting a live namespace.

Neither cleanup nor uninstall ever targets Cargo registries, Cargo Git checkouts,
source trees, project `target/` directories, credentials, Firstmate state, or
another extension's state.

`status` is deterministic and concise: enabled/disabled/bypass reason, backend
availability/version, sanitized project, workload/context, namespace prefix,
bytes/limits/retention/last use, and sccache hits/misses when a snapshot exists.
Absolute paths appear only with `--show-paths`; JSON is available with `--json`.

## Uninstall

Prepare removal while the package is still loaded, then remove the Pi package:

```text
/rust-cache uninstall --keep-cache
```

```sh
pi remove git:github.com/M00NLIG7/firstmate-rust-cache-extension
```

`--keep-cache` is the default. It disables every selection and retains the
validated configuration as a cache index alongside the documented cache tree;
that conservative index keeps retained namespace allocations inside the global
bound after reinstall. It cannot activate caching while disabled. To leave no
package-owned data:

```text
/rust-cache uninstall --remove-cache
```

Both flows are idempotent. Cache removal refuses active leases or an unprovable
live backend instead of risking an unrelated process. Reinstalling the same
reviewed package is sufficient to inspect or remove deliberately retained cache.

## Support matrix

### Firstmate worker harness

| Harness | Automatic cache support | Boundary |
| --- | --- | --- |
| Pi 0.84.x | **Supported and tested** | Public Pi package + built-in LLM `bash` override after selection. |
| pi-signed using Pi 0.84.x | **Supported contract; not separately binary-tested here** | Firstmate documents the same Pi engine/extension behavior; install in that host's Pi package home. |
| Claude, Codex, OpenCode, Grok, Kimi, Cursor, Muse | **Unsupported** | Firstmate's public package host exposes no worker hook, and this package does not inject instructions or alter core launch templates. |
| Raw/unverified launch commands | **Unsupported** | No public loading or environment contract is assumed. |

Pi TUI, print, JSON, and RPC agent tool calls use the same registered tool. Pi's
user-entered `!`/`!!` shell, direct RPC `bash` command, SDKs that replace `bash`,
and later third-party `bash` overrides do not pass through this package and are
explicitly unsupported.

### Firstmate session provider

The provider transports the same selected Pi process; this package never calls a
provider API or drives provider lifecycle.

| Provider | Pi worker reach | Evidence boundary |
| --- | --- | --- |
| tmux | Supported | Firstmate reference provider; same Pi process/package home. |
| Herdr | Supported by process boundary | No Herdr lifecycle command is used or tested by this package. |
| Zellij | Supported by process boundary | Session-provider-only; no backend-specific behavior claimed. |
| cmux | Supported by process boundary on macOS | Session-provider-only; no socket access used. |
| Orca | Supported by process boundary on macOS | Orca owns worktree/terminal, while Pi remains the launched harness. |

Remote hosts and separately provisioned secondmate hosts need an independent Pi
package install, sccache install, and explicit project selection. Nothing falls
back to executing a missing remote package locally.

## Development and validation

Tests use disposable homes and repositories and make no provider or LLM calls:

```sh
npm ci
npm run check
npm test
```

The integration suite requires sccache 0.17+ and runs real Cargo/rustc commands.
It covers default inertness, opt-in, repeat hits, project/flag/feature separation,
backend absence, limits and targeted cleanup, idempotence, spaces, concurrency,
interruption, and uninstall preservation.
