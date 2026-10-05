# 开发、打包与验证

[返回项目首页](../README.md)

## 开发与检查

开发需要 Node 22、Rust 和对应平台的 Tauri 开发依赖。

    npm ci
    npm run desktop

    npm test
    npm run build
    cargo test --manifest-path src-tauri/Cargo.toml --tests

测试使用独立临时仓库，不修改录制项目。覆盖真实 Git 操作、只读保证、差异范围、历史分页、中文路径及前端请求乱序。

    npm run format
    npm run format:check
    cargo fmt --manifest-path src-tauri/Cargo.toml --check

具体测试、实际桌面检查和平台限制见 [验证与平台范围](verification.md)。

## 构建

Mac 通用安装包同时包含 Apple Silicon 和 Intel：

    rustup target add aarch64-apple-darwin x86_64-apple-darwin
    npm run package -- --target universal-apple-darwin --bundles app,dmg

Windows x64：

    npm run package -- --target x86_64-pc-windows-msvc --bundles nsis

安装包位于对应 Cargo target 下的 release/bundle。

### CI 测试与打包

将本工程作为 GitHub 仓库根目录，工作流 [.github/workflows/build.yml](../.github/workflows/build.yml) 在 push、PR 和手动运行时执行：

| 阶段       | 检查内容                                                                                                                                     |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| 原生检查   | Mac ARM、Mac Intel、Windows x64 分别运行前端测试、类型与构建检查、格式检查、Rust Clippy 和真实 Git 仓库测试                                  |
| 打包       | Mac 通用 DMG、Windows x64 NSIS；测试失败时不打包                                                                                             |
| 安装后检查 | 同一个 Mac 通用包分别在两种架构安装，Windows 静默安装；运行已安装程序及随包启动器，验证 CLI、Skill、中文路径、子目录识别、LFS 状态和只读保证 |

在 GitHub 的 Actions 页面打开“桌面测试与安装包”，可下载安装包及每个平台的 JSON 检查记录。安装包与报告保留 14 天，不自动发布 Release；并行的新运行会取消同一分支上尚未结束的旧运行。

Mac 安装后检查也可以在本地执行：

    node scripts/ci-install-smoke.mjs --artifact-dir "安装包所在目录" --report "reports/installed.json"

Mac 脚本将应用复制到独立临时目录，检查完成后删除测试目录，不替换已有的应用。Windows NSIS 会写入安装记录与快捷方式，因此脚本只允许在临时 GitHub runner 中运行。Git 写入只用于创建临时测试仓库，随后逐字节比较读取前后的文件、暂存区、引用和配置。CI 报告不代表原生窗口、文件通知或视觉交互已经验收，这些仍按验证说明完成桌面走查。

## 工程

React 负责图、文件列表和详情；Rust 调用标准 Git 命令。桌面内部接口以仓库会话为范围，不开放本地 HTTP 服务。变化通知经过合并后刷新；窗口处于前台时每三秒补查，恢复焦点时立即检查。

仓库打开、快照、历史和详情分别管理请求归属；历史变化后重建分页。提交图与详情面板是本项目自绘组件，动画仅呈现真实数据变化，并尊重系统减少动态效果设置。

短请求不显示骨架屏，超过 200 毫秒后才就近显示读取提示。提交详情与默认文件差异用一次内部读取返回，完整内容准备好后再展开面板；同一比较范围刷新时保留内容。切换提交文件保留代码视窗，读完再整体替换；提交信息可展开为独立信息区。最近查看的提交结果有数量与 6 MB 内存上限，工作区差异缓存最多保留 12 项。

自动换行使用变高虚拟列表，只测量可见代码行；左右对照共享行高。拖拽由动画帧合并尺寸更新，展开收起可从当前高度反向过渡。尊重系统减少动态效果设置；变化通知和后台补查仅针对当前仓库。
