# 开发说明

[项目首页](../../README.zh-CN.md) · [参与贡献](contributing.md) · [English](../development.md)

## 环境与启动

使用 Node.js 22、通过 rustup 安装的 Rust、Git，以及对应平台的 [Tauri 开发依赖](https://v2.tauri.app/start/prerequisites/)。`rust-toolchain.toml` 固定 Rust 1.99.0、rustfmt 与 Clippy，CI 使用同一版本。Windows 使用 MSVC 工具链。

```sh
npm ci
npm run desktop
```

`npm run desktop` 启动真实 Tauri 窗口。Vite 服务只用于窗口开发，不是独立浏览器产品。

## 检查

```sh
npm run format:check
npm test
npm run build
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo clippy --manifest-path src-tauri/Cargo.toml --locked --all-targets -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml --locked --tests
```

格式化使用 `npm run format` 和 `cargo fmt --manifest-path src-tauri/Cargo.toml`。测试创建独立临时仓库，覆盖真实 Git 读取、范围区分、冲突、分页、中文路径、请求乱序和只读保证。原生窗口与安装检查另行记录，见[贡献指南](contributing.md#验证)。

开发、测试与构建前自动生成图标和主题 CSS，不提交生成产物。配色位于 `scripts/theme-palettes.json`，文件图标使用锁定的 Material Icon Theme 依赖。

## 打包

在 macOS 构建包含 Apple Silicon 与 Intel 的通用包：

```sh
rustup target add aarch64-apple-darwin x86_64-apple-darwin
npm run package -- --target universal-apple-darwin --bundles app,dmg
```

在 Windows 构建 x64 安装包：

```sh
npm run package -- --target x86_64-pc-windows-msvc --bundles nsis
```

在 Linux 构建 deb、rpm 与 AppImage：

```sh
npm run package -- --target x86_64-unknown-linux-gnu --bundles deb,rpm,appimage
```

Linux 构建需要 Debian 与 Ubuntu 的 Tauri 依赖：`libwebkit2gtk-4.1-dev`、`libgtk-3-dev`、`librsvg2-dev`。deb 与 rpm 将程序安装为 `oil-git`，资源位于 `/usr/lib/oil-git`；AppImage 在自身包内使用相同布局。无需额外安装 `rpmbuild`，也无需挂载 FUSE：rpm 由构建过程直接写出，AppImage 在缺少 FUSE 时可用 `--appimage-extract-and-run` 运行。

产物位于相应 Cargo target 的 `release/bundle` 目录。两种语言、Agent Skill、启动器和许可说明随包提供。已发布安装包对应发布时的提交，不随后续源码变化更新。

## CI

[Desktop CI](https://github.com/oil-oil/oil-git/actions/workflows/build.yml) 在 push、PR 与手动运行时执行：

| 阶段          | 范围                                                                                                                                                   |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Checks        | macOS ARM64、macOS Intel、Windows x64、Ubuntu x64 原生 runner：格式、前端测试和构建、Rust Clippy、真实 Git 集成测试                                    |
| Package       | 所有源码检查通过后，构建 macOS 通用 DMG、Windows x64 NSIS，以及 Linux 的 deb、rpm 与 AppImage                                                          |
| Installed CLI | 同一个通用 DMG 分别在两种 macOS 架构安装，Windows 安装 NSIS，Linux 解包三种安装包；运行已安装程序和启动器，验证资源、CLI、中文路径、LFS 和仓库字节不变 |

安装包与每个平台的 JSON 报告保留 14 天，不自动发布 Release。同一 ref 的新运行会取消未结束的旧运行。报告 CI 状态时关联相应提交的真实结果。

macOS 与 Linux 可本地检查安装包：

```sh
node scripts/ci-install-smoke.mjs --artifact-dir "/安装包所在目录" --report reports/installed.json
```

脚本将应用复制到独立临时目录，检查后删除。Linux 在该目录中解包 deb、rpm 与 AppImage 而不安装，因此不需要 root 权限，也不需要挂载 FUSE。Windows NSIS 会写入安装记录和快捷方式，因此只允许在临时 GitHub Actions runner 执行。Git 写入只用于构造临时夹具，之后逐字节比较读取前后仓库。

## 源码结构

`src/` 包含 React 界面、状态与国际化文案，`src-tauri/src/` 提供只读 Git 接口、文件预览和 LFS 过滤器。配色和文件图标的生成入口位于 `scripts/`。请求归属、渲染和只读访问的完整约束见 [AGENTS.md](../../AGENTS.md)。
