# Contributing to oil-git

[简体中文](docs/zh-CN/contributing.md)

oil-git is a read-only desktop viewer for real Git repositories. Contributions should help people understand branches, commits, and changes without altering the repository they are viewing.

## Issues and proposals

For bugs, include your operating system and architecture, application version or commit, reproduction steps, and expected behavior. A small temporary repository is especially helpful for Git edge cases. Remove private paths, email addresses, and source code from logs or screenshots before sharing them.

For larger changes, describe the user need in an issue first. Keep pull requests focused and explain the resulting behavior and the checks you actually ran.

## Development

Follow the setup and checks in [Development](docs/development.md). [AGENTS.md](AGENTS.md) contains the repository's engineering constraints, including read-only access, request ownership, and rendering behavior. Use independent temporary repositories for tests.

Keep generated icons, theme CSS, build outputs, and local verification reports out of commits. Edit theme colors in `scripts/theme-palettes.json`; use the existing Material Icon Theme assets for file icons.

## Language and documentation

The application supports English and Simplified Chinese. Update both entries in `src/i18n.tsx` when adding user-facing text, including tooltips, accessible names, and errors. Git paths, commit messages, branch names, and author names are repository data and must retain their original text.

Update English and Chinese documentation together when behavior changes. The English README is the default entry point; `README.zh-CN.md` and `docs/zh-CN/` provide Chinese counterparts. Prefer durable usage and contribution guidance over dated test logs. Store local evidence outside the public documentation.

## Verification

Run the checks relevant to your change and describe any limits in the pull request. Changes to desktop behavior also need native-window verification; CLI checks alone cannot establish that the interface works. Changes to packaging need checks of the installed program and bundled launcher, not only the build-directory binary. See [Verification](docs/verification.md).

GitHub Actions checks macOS ARM64, macOS Intel, and Windows x64. A workflow definition or a local cross-compilation is not evidence that a platform passed; link the actual run when reporting results.

## License

By contributing, you agree that your contributions are available under the project's [MIT license](LICENSE). Preserve applicable third-party notices when adding or updating dependencies or assets.
