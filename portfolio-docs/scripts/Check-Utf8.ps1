param(
    [string]$Root = ".",
    [string[]]$Extensions = @("*.md", "*.json", "*.ts", "*.tsx", "*.js", "*.jsx", "*.yml", "*.yaml")
)

$ErrorActionPreference = "Stop"

$utf8Strict = New-Object System.Text.UTF8Encoding($false, $true)
$total = 0
$ok = 0
$warn = 0
$errorCount = 0

Write-Host "UTF-8 check started: $Root"

foreach ($pattern in $Extensions) {
    $files = Get-ChildItem -Path $Root -Recurse -File -Filter $pattern
    foreach ($file in $files) {
        $total++
        try {
            $bytes = [System.IO.File]::ReadAllBytes($file.FullName)
            $text = $utf8Strict.GetString($bytes)
            if ($text.Contains([char]0xFFFD)) {
                $warn++
                Write-Host "WARN  $($file.FullName)  (contains replacement char)" -ForegroundColor Yellow
            } else {
                $ok++
                Write-Host "OK    $($file.FullName)" -ForegroundColor Green
            }
        } catch {
            $errorCount++
            Write-Host "ERROR $($file.FullName)  (cannot decode as strict UTF-8)" -ForegroundColor Red
        }
    }
}

Write-Host ""
Write-Host "Check finished"
Write-Host "Total : $total"
Write-Host "OK    : $ok" -ForegroundColor Green
Write-Host "WARN  : $warn" -ForegroundColor Yellow
Write-Host "ERROR : $errorCount" -ForegroundColor Red

if ($errorCount -gt 0) {
    exit 1
}
