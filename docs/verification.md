# 验证与平台范围

## 本机已完成

- 前端类型、格式、构建及组件测试。
- Rust 格式、Clippy 和真实临时仓库集成测试，覆盖提交、分支、合并、冲突、stash、reset、rebase、工作树、外部 fetch、分页与只读检查。
- macOS Apple Silicon 测试包安装、窗口打开、文件变化、长行差异、目录折叠和提交查看。
- Windows x64 交叉编译与测试安装器生成；这不代表 Windows 原生运行验收。

## GitHub Actions

[桌面测试与安装包](https://github.com/oil-oil/oil-git/actions/workflows/build.yml) 在 Mac ARM、Mac Intel、Windows x64 上进行源码检查、安装包构建与安装后 CLI 检查。

每次运行的结果以 Actions 中该提交的实际记录为准。安装检查会读取中文及空格路径、识别子目录、核对 Skill 和启动器，验证 LFS 指针与已展开内容的状态，并比较测试仓库查看前后的文件、暂存区、引用、配置及 LFS 对象字节。

## 仍需人工确认

原生窗口的交互、缩放、文件通知与阅读体验应在目标机器走查；CI 的 CLI 检查不能替代它们。测试包尚未配置自动更新。

本阶段不新增性能测量。差异有 240 KB 截断提示，历史分页和代码采用可见区域渲染。
