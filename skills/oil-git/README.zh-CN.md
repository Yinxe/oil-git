# oil-git Agent Skill

此目录包含供 Agent 使用的 oil-git Skill，可在用户要求时打开其本地 Git 项目或读取真实仓库状态。不使用 Agent 的普通用户也可以直接使用桌面应用。

安装包同时提供两种语言：[英文 SKILL.md](SKILL.md) 和[简体中文 SKILL](SKILL.zh-CN.md)。应用会将文件放在资源目录；`oil-git skill --path` 输出当前语言 Skill 的安装路径，`oil-git skill` 输出其内容。可使用 `--lang en` 或 `--lang zh-CN` 选择 CLI 与 Skill 语言。

Skill 只读取用户指定的仓库，不执行暂存、提交、切换分支、合并、重置、fetch、push，也不上传仓库数据。使用它需要桌面应用、系统 Git 和本地命令执行能力。安装应用不会修改 Agent 宿主的 Skill 设置。

CLI 接入见[使用说明](https://github.com/oil-oil/oil-git/blob/main/docs/zh-CN/usage.md#cli-与-ai-agent)，平台验证记录见[验证说明](https://github.com/oil-oil/oil-git/blob/main/docs/zh-CN/verification.md)。英文概览见 [README](README.md)。
