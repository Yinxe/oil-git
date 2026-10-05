# Verification

[Home](../README.md) · [Development](development.md) · [简体中文](zh-CN/verification.md)

Verification has three separate parts: source checks, checks of an installed package, and native desktop/visual checks. Record each result against its commit or package; a successful CLI read does not establish that the window works.

## Source checks

Run the commands in [Development](development.md) on the changed source. Git tests use independent temporary repositories and compare observed files, the index, refs, configuration, and LFS object storage before and after reads. Do not use a personal repository to construct test changes.

## Installed package

Use [Desktop CI](https://github.com/oil-oil/oil-git/actions/workflows/build.yml) for native macOS ARM64, macOS Intel, and Windows x64 installation checks. Results belong to the actual workflow run; a configured job, skipped job, or local cross-build is not a pass.

`scripts/ci-install-smoke.mjs` installs or copies the artifact and runs its actual binary and bundled launcher. It checks help/version, Skill discovery, Unicode and space-containing paths, staged/unstaged separation, LFS behavior, error exit codes, and byte-for-byte repository immutability. Its JSON report records platform, architecture, installer SHA-256, completed checks, and limitations. Reports and installers are uploaded together for inspection.

## Native desktop walkthrough

On each target platform, open the installed application and a temporary real repository. Check the following when relevant to the change:

- Open through the picker and launcher; repeated requests reuse the window. Test recent-project removal and startup restoration.
- Verify file notifications and foreground refreshes preserve readable content; synchronization appears below the toolbar and stops when idle.
- Navigate commit history, filters, pagination, details, and staged/unstaged/conflict files. Compare displayed data to local Git output.
- Check wrapped long lines, variable row heights, original line numbers, pane resizing, keyboard selection, and scroll retention.
- Inspect added, removed, and modified images, 100% vertical layout, audio/video, byte fallback, truncation, and line authorship using real fixtures.
- Switch English/Chinese and all themes without losing repository or view state. Check dialogs, tooltips, accessible labels, copy feedback, and long translations.
- Check reduced-motion behavior and inactive views. Copy controls should fade into a reserved space without shifting commit titles.

Capture representative screenshots and note the operating system, architecture, application commit, and package digest. Record unchecked areas explicitly. Keep machine-specific logs and screenshots outside the public documentation; a PR can link relevant evidence.

## Platform limits

macOS packages are universal builds; the same DMG must be installed and exercised on both Apple Silicon and Intel. Windows uses an x64 NSIS installer. CI installation checks cover CLI behavior and bundled resources, not WebView rendering, file notifications, window interaction, or visual quality. These require a native walkthrough on the target machine.

Released test packages may predate features on the default branch. Consult the release commit and notes when reproducing an issue, and do not apply current source-check results to an older downloaded package.
