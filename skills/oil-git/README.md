# oil-git Agent Skill

This folder contains the oil-git Skill for agents that need to open the user's local Git project or inspect its real repository state. The desktop app is also available directly to people who do not use an agent.

The package includes both language versions. Use [SKILL.md](SKILL.md) for English or [SKILL.zh-CN.md](SKILL.zh-CN.md) for Simplified Chinese. The app package installs the files with the application resources; `oil-git skill --path` prints the selected file's installed path, and `oil-git skill` prints its contents. `--lang en` and `--lang zh-CN` select the CLI and Skill language.

The Skill only reads a repository selected by the user. It does not stage, commit, switch branches, merge, reset, fetch, push, or upload repository data. It requires the desktop application, system Git, and a way to run local commands. Installing the app does not change an agent host's Skill settings.

See the [usage guide](https://github.com/oil-oil/oil-git/blob/main/docs/usage.md#cli-and-ai-agents) for CLI integration and the [verification guide](https://github.com/oil-oil/oil-git/blob/main/docs/verification.md) for platform evidence. For the translated overview, see [简体中文](README.zh-CN.md).
