param(
    [string]$ExePath,
    [string[]]$Arguments,
    [int]$MemoryLimitMB = 5120
)

$proc = Start-Process -FilePath $ExePath -ArgumentList $Arguments -NoNewWindow -PassThru

$timeout = 60
$elapsed = 0
while (-not $proc.HasExited -and $elapsed -lt $timeout) {
    Start-Sleep -Milliseconds 200
    $elapsed += 0.2
    try {
        $ws = (Get-Process -Id $proc.Id -ErrorAction Stop).WorkingSet64 / 1MB
        if ($ws -gt $MemoryLimitMB) {
            Write-Host "FATAL: 进程内存 ${ws:N0}MB 超过限制 ${MemoryLimitMB}MB，强制终止"
            $proc.Kill()
            exit 137
        }
    } catch {
        break
    }
}

if (-not $proc.HasExited) {
    Write-Host "TIMEOUT: 进程超过 ${timeout}s 未退出，强制终止"
    $proc.Kill()
    exit 138
}

exit $proc.ExitCode
