---
name: oil-git
description: 用 oil-git 打开本地 Git 项目并查看真实分支、提交、待提交修改和冲突；在用户要求通过 oil-git 查看项目或把 Agent 正在处理的仓库定位到桌面视图时使用。只负责读取与展示，不用于执行 Git 写操作、网站浏览或云端仓库管理。
license: MIT
metadata:
  version: "0.1.0"
---

# oil-git

需要本地 oil-git 应用、系统 Git 和执行本地命令的能力。平台验证范围见项目的 [验证说明](https://github.com/oil-oil/oil-git/blob/main/docs/verification.md)。

先确定用户正在处理的本地项目目录。路径可以来自当前工作区或用户明确指定的目录；有多个候选且无法判断时再询问。

## 发现入口

先检查本机是否有 oil-git 命令。已有命令时直接使用，不重新安装。

macOS 常规安装提供启动器：

    /Applications/oil-git.app/Contents/Resources/bin/oil-git

也可以从用户实际安装的 oil-git.app 中读取同一相对位置。Windows 优先调用应用安装目录中的 oil-git.exe，不依赖 PowerShell 脚本执行策略；默认目录为 %LOCALAPPDATA%\oil-git。下文的 oil-git 代表已发现的完整入口。

Windows 的 bin/oil-git.ps1 是可选启动器。需要使用时按进程调用，不修改用户或机器级执行策略：

    powershell.exe -NoProfile -ExecutionPolicy Bypass -File "安装目录\bin\oil-git.ps1" --version

组织策略仍阻止脚本时，使用原生 exe。

对已发现的入口运行 --version。找不到应用或不能启动时，说明缺少的依赖并停止；安装应用或修改宿主的 Skill 配置需要用户授权。

## 读取与打开

1. 调用 inspect 读取真实仓库快照。路径作为独立参数传入，包含空格时加引号。

       oil-git inspect "/项目路径" --json

   成功返回 status=ready 和 data；失败返回 status=error、kind、message，并以非零状态退出。失败时先处理提示，不编造提交或分支信息。未初始化项目的初始化由正常开发流程另行处理。

2. 根据用户任务打开视图。检查 Agent 的修改或冲突时使用 changes；看提交和分支关系时使用 history。

       oil-git open "/项目路径" --view changes
       oil-git open "/项目路径" --view history

   启动器会复用正在运行的窗口。打开命令只表示已发送打开请求，不代表已经完成视觉验证或修改仓库。

3. 用快照解释当前状态。data.branch 是当前分支，data.head 是提交位置；data.files 中 staged 和 unstaged 分别表示暂存与工作区的变化，conflict 取自 Git 的未解决记录。同一文件可能同时存在两类变化。

   分析具体代码时，可用宿主已有的只读 Git 读取能力，或查看应用中的对应文件。未暂存差异比较工作区与暂存区；已暂存差异比较暂存区与 HEAD。inspect 不返回完整代码差异。

4. 完成读取后，说明实际看到的变更及打开的视图。没有读取真实结果时，不声称“工作区干净”“冲突已解决”或“已提交”。

## 状态边界

- 所有数据保留在本机，不需要账号或云同步。
- 领先与落后数量来自本地已有的远程跟踪记录，不代表已经向远程执行 fetch。
- 分支筛选和工作树选择只切换观察对象，不执行 checkout。
- 标准 Git LFS 仓库由应用自带的只读过滤器识别，不需要安装 git-lfs；差异显示指针对象信息，不自动下载内容。自定义过滤器或 LFS 扩展不受支持时，按真实错误处理。
- 清除文本冲突标记不等于 Git 已标记解决；以文件的 conflict 状态为准。
- 此 Skill 不授权提交、暂存、合并、重置或推送。用户另行要求这些操作时，交给正常开发流程处理。

完整入口说明可用 oil-git --help 获取；oil-git skill 返回这份说明，oil-git skill --path 返回随应用安装的 Skill 文件位置。
