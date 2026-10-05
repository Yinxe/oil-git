# 第三方资源

[English](../../THIRD-PARTY-NOTICES.md)

文件类型图标采用 [Material Icon Theme](https://github.com/material-extensions/vscode-material-icon-theme)，当前依赖版本由 package-lock.json 固定。构建时从官方 npm 包复制文件图标及 LICENSE，运行时只加载本机资源。

界面布局、功能图标、主题和交互由本工程实现。主题配置统一维护在 scripts/theme-palettes.json，构建时生成配色样式。

深色与浅色配色参考 Atom 的 [One Dark](https://github.com/atom/one-dark-syntax/blob/master/styles/colors.less) 与 [One Light](https://github.com/atom/one-light-syntax/blob/master/styles/colors.less)，对文字对比、选中态和 Git 差异背景作了工具界面的适配。绿色沿用相同的强调色，使用更中性的背景。

## Atom One Dark / One Light 许可

两份上游使用相同的 MIT 许可，原文如下：

```text
Copyright (c) 2016 GitHub Inc.

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
"Software"), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE
LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION
WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```
