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
    & $TaskAppPath @LaunchArguments
    $TaskExitCode = $LASTEXITCODE
} finally {
    [Console]::OutputEncoding = $TaskPreviousEncoding
}
exit $TaskExitCode
