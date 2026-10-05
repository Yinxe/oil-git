# Development

[Home](../README.md) · [Contributing](../CONTRIBUTING.md) · [简体中文](zh-CN/development.md)

## Setup

Use Node.js 22, Rust through rustup, Git, and the native [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for your platform. `rust-toolchain.toml` pins Rust 1.99.0 with rustfmt and Clippy; CI uses the same version. On Windows, use the MSVC toolchain.

```sh
npm ci
npm run desktop
```

`npm run desktop` starts the actual Tauri window. The Vite server is a development resource for that window, not a supported browser product.

## Checks

```sh
npm run format:check
npm test
npm run build
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo clippy --manifest-path src-tauri/Cargo.toml --locked --all-targets -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml --locked --tests
```

Use `npm run format` and `cargo fmt --manifest-path src-tauri/Cargo.toml` to format changes. Tests create independent temporary repositories. They cover real Git reads, scope separation, conflicts, history pagination, Unicode paths, request races, and read-only guarantees. Native-window and installation checks are separate; see [Verification](verification.md).

Icons and theme CSS are generated before development, tests, and builds. Do not commit these outputs. Palette definitions live in `scripts/theme-palettes.json`; file icons come from the locked Material Icon Theme dependency.

## Package

Build a macOS universal application and DMG on macOS:

```sh
rustup target add aarch64-apple-darwin x86_64-apple-darwin
npm run package -- --target universal-apple-darwin --bundles app,dmg
```

Build a Windows x64 installer on Windows:

```sh
npm run package -- --target x86_64-pc-windows-msvc --bundles nsis
```

Outputs are under the selected Cargo target's `release/bundle` directory. Both languages, the Agent Skill, launchers, and license notices ship with the application. Published release assets are snapshots of their release commits, not automatically updated by subsequent source changes.

## Continuous integration

[Desktop CI](https://github.com/oil-oil/oil-git/actions/workflows/build.yml) runs on pushes, pull requests, and manual dispatch:

| Stage         | Scope                                                                                                                                                                                                                              |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Checks        | Native macOS ARM64, macOS Intel, and Windows x64 runners: formatting, frontend tests/build, Rust Clippy, and real-Git integration tests                                                                                            |
| Package       | Universal macOS DMG and Windows x64 NSIS installer, only after all source checks pass                                                                                                                                              |
| Installed CLI | Install the universal DMG on both macOS architectures and the NSIS package on Windows; run the installed binary and launcher and verify bundled resources, CLI snapshots, Unicode paths, LFS behavior, and repository immutability |

Artifacts and per-platform JSON reports are retained for 14 days. This workflow does not publish a Release. A newer run cancels an unfinished run on the same ref. Use the actual run result for a specific commit when reporting CI status.

The macOS installer check can also run locally:

```sh
node scripts/ci-install-smoke.mjs --artifact-dir "/path/to/installer-directory" --report reports/installed.json
```

It copies the application into an independent temporary directory and removes that directory afterwards. Windows NSIS changes installation records and shortcuts, so this check is restricted to disposable GitHub Actions runners. Fixture creation is the only phase that writes Git data; subsequent checks compare the repository bytes before and after reads.

## Architecture and behavior

React renders the graph, file lists, and details. Rust calls standard Git commands through repository-scoped desktop interfaces; there is no local HTTP service. File notifications are coalesced. The foreground window also polls every three seconds and checks immediately when focus returns.

Open, snapshot, history, and detail requests have explicit ownership. History changes invalidate pagination. Commit details and the default diff share an effective history version and appear together. Refreshes retain the displayed content while the next result is read. Reads shorter than 200 ms do not show a loading hint; slower hints stay in the relevant region.

Commit results have a count limit and a 6 MB cache budget; working changes retain at most 12 diffs and 24 MiB. Code and history render only visible rows. Wrapped code measures natural row heights, and side-by-side rows use the greater height. Drag updates are combined with animation frames. Hidden views and reduced-motion preferences stop presentation animations.

User-facing English and Chinese text lives in `src/i18n.tsx`. Preserve original repository data, stable JSON fields, error kinds, and message keys across languages. Test language changes without resetting the selected repository, file, or view. The detailed engineering constraints are in [AGENTS.md](../AGENTS.md).
