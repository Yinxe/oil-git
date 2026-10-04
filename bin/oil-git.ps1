param([Parameter(ValueFromRemainingArguments = $true)][string[]]$LaunchArguments)
# Windows Agent 入口，参数作为独立数组传给应用。
$TaskAppPath = Join-Path (Split-Path $PSScriptRoot -Parent) 'oil-git.exe'
if (-not (Test-Path $TaskAppPath)) { $TaskAppPath = Join-Path $env:LOCALAPPDATA 'oil-git\oil-git.exe' }
if (-not (Test-Path $TaskAppPath)) {
    throw '没有找到 oil-git，请先安装应用。'
}
if ($LaunchArguments.Count -ge 2 -and $LaunchArguments[0] -eq 'open' -and -not [IO.Path]::IsPathRooted($LaunchArguments[1])) {
    $LaunchArguments[1] = Join-Path (Get-Location).ProviderPath $LaunchArguments[1]
}
$TaskPreviousEncoding = [Console]::OutputEncoding
try {
    [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
    if ($LaunchArguments.Count -eq 0 -or $LaunchArguments[0] -eq 'open') {
        # 桌面启动保持异步；返回码仅表示请求已发出。
        & $TaskAppPath @LaunchArguments
        $TaskExitCode = 0
    } else {
        # GUI 子系统程序须接入管道，PowerShell 才会等待并更新退出码。
        # 原样写出每行，避免格式化 JSON 或改变参数传递方式。
        & $TaskAppPath @LaunchArguments | ForEach-Object { [Console]::Out.WriteLine($_) }
        $TaskExitCode = $LASTEXITCODE
    }
} finally {
    [Console]::OutputEncoding = $TaskPreviousEncoding
}
exit $TaskExitCode
