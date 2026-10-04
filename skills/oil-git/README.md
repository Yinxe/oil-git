# oil-git 配套 Skill

让 Agent 打开正确的本地项目、定位到提交历史或待提交修改，并读取真实 Git 状态。普通用户可以直接使用桌面应用；需要 Agent 协作时再由宿主加载这份 Skill。

Skill 随安装包放在应用资源目录，也可以把完整的 oil-git Skill 文件夹交给 Agent 按宿主规则安装。首次发现应用后运行 oil-git --version，再用 oil-git skill --path 定位文件。安装 App 不会自动修改所有 Agent 宿主的设置。

无需账号、API Key 或网络服务。仓库信息只在本机读取，应用和 Skill 均不执行 Git 写操作。Mac 提供启动器，Windows 提供 PowerShell 入口和原生可执行文件；Windows 当前仅完成构建，仍需实机验收。

## 数据与权限

只读取用户指定的本地仓库，并打开桌面视图；不提交、暂存、合并、重置、推送或上传数据。需要执行 Git 写操作时，应由用户授权的开发流程处理。
