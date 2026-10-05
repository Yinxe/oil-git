# 使用说明

[返回项目首页](../README.md)

## 打开与浏览

Mac 使用 DMG 安装包，将 oil-git 拖入 Applications。Windows 使用 setup.exe 安装包。当前版本为测试版。macOS 首次访问桌面等目录时可能询问文件访问权限；处理系统询问后，如页面提示读取超时，点击重试。

电脑需要已有 Git。应用会自动检测 PATH 和常见安装位置；缺失时提供官方安装入口与重新检测。运行应用不需要安装 Python、Node 或 Rust。Windows 缺少系统 WebView2 时，安装程序会下载微软运行组件。

点击左上角打开项目，或使用 ⌘ O / Ctrl O。选到项目子目录也会识别所属仓库。最近打开的目录保存在本机，重新启动时恢复上次项目。

- 提交图展示真实父子关系、分支、标签和 HEAD。筛选只改变视图，返回 HEAD 定位到当前提交。
- 左侧常驻“更改”“暂存的更改”和出现时的“合并的更改”。同一文件可分别出现在暂存与工作区两组。组内按目录分类，连续的单目录合并展示，可展开与折叠。
- 右侧切换“源码”和“分支”。点击左侧文件自动进入源码；切换视图保留文件选择、历史筛选和滚动位置。
- 右上角可切换浅色、深色和绿色主题，选择保存在本机；深色与浅色参考 One Dark / One Light，默认深色。文字、分支图与差异颜色随主题一起切换。
- 文件类型图标来自现成的 [Material Icon Theme](https://github.com/material-extensions/vscode-material-icon-theme)，按文件名和扩展名识别，资源随应用离线提供。
- 标准 Git LFS 仓库可直接查看，无需另外安装 Git LFS。指针文件和已展开的文件内容按真实暂存范围识别；差异展示对象 ID 与大小，不自动下载文件。
- 点击提交查看变更文件；普通与合并提交默认比较第一个父提交，首次提交展示新增内容。
- 普通文本冲突展示实际冲突段及文件行号，LFS 冲突展示双方对象 ID 与大小。清除文本标记不等于 Git 已解决冲突。
- 工作树选择器只切换观察目录。临时保存列表来自实际 stash。
- 代码差异默认自动换行，保留原始行号。左右对照的对应行按较高的一侧对齐，不需要横向滚动。
- 侧栏、提交图与详情、左右代码对照的分界都可拖动；也支持方向键调整。宽度偏好保存在本机，窄窗口临时压缩后会恢复；取消拖拽不保存临时位置。
- 方向键选择提交，回车查看；Esc 关闭详情或取消拖拽；⌘ R / Ctrl R 刷新。

应用只读取 Git，不执行提交、checkout、fetch、合并或撤销。CLI 快照中的领先与落后数量基于本地远程跟踪记录；远程记录更新后自动重新读取。图片支持可视化对照，其他二进制按文件类型预览或展示字节差异；文本差异超过 240 KB 时标明截断。裸仓库、需要按需下载 Git 对象的部分克隆仓库暂不支持。

## AI Agent 与 CLI

Mac 可将 bin/oil-git 放进自己的 PATH，或直接运行这个入口。它立即返回，由桌面应用接收打开请求；应用已经运行时复用现有窗口。

    oil-git open "/项目路径" --view changes
    oil-git open "/项目路径" --view history

开发或安装在其他目录时，可用 OIL_GIT_APP 指定完整的 oil-git.app 路径。Windows 优先调用安装目录中的 oil-git.exe；可选启动器是 bin/oil-git.ps1，参数相同。需要调用脚本时使用 powershell.exe -NoProfile -ExecutionPolicy Bypass -File "安装目录\bin\oil-git.ps1"，后接应用参数；无需修改用户或机器级执行策略。带空格的路径需要加引号。CLI 只读取与展示，不执行 Git 写操作。

Agent 可以直接读取真实快照和配套 Skill：

    oil-git inspect "/项目路径" --json
    oil-git skill
    oil-git skill --path

inspect 成功返回 status=ready 和 data；失败返回 status=error、kind、message，并以非零状态退出。它不启动窗口，也不返回完整代码差异。Skill 和启动器随安装包提供；Mac 位于应用的 Contents/Resources 中，Windows 位于安装目录中。用户可将完整的 skills/oil-git 目录交给 Agent 按宿主规则安装；安装应用不会自动修改其他宿主的 Skill 设置。

## 只读范围

标准 Git LFS 转换由应用自带的只读过滤器处理，不运行仓库配置的 LFS 程序，不下载内容，也不向 LFS 对象库写入文件。自定义 LFS 转换命令和扩展转换暂不支持。

其他会运行外部 `clean`／`process` 转换程序的活动 Git 过滤器仍显示 `unsafeFilter` 及原因；未被文件属性使用的过滤器配置可正常读取。读取不会运行分页器或签名校验 helper，仓库路由环境不会覆盖用户选择的目录。
