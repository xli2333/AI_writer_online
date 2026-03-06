param(
    [string]$Root = ".",
    [ValidateSet("utf8", "gb18030", "gbk", "unicode", "bigendianunicode", "utf32", "ascii")]
    [string]$SourceEncoding = "gb18030",
    [string[]]$Extensions = @("*.md", "*.json", "*.ts", "*.tsx", "*.js", "*.jsx", "*.yml", "*.yaml"),
    [switch]$WhatIf
)

$ErrorActionPreference = "Stop"

function Get-EncodingObject([string]$name) {
    switch ($name.ToLowerInvariant()) {
        "utf8" { return [System.Text.UTF8Encoding]::new($false) }
        "gb18030" { return [System.Text.Encoding]::GetEncoding("GB18030") }
        "gbk" { return [System.Text.Encoding]::GetEncoding(936) }
        "unicode" { return [System.Text.Encoding]::Unicode }
        "bigendianunicode" { return [System.Text.Encoding]::BigEndianUnicode }
        "utf32" { return [System.Text.Encoding]::UTF32 }
        "ascii" { return [System.Text.Encoding]::ASCII }
        default { throw "Unsupported encoding: $name" }
    }
}

$srcEnc = Get-EncodingObject $SourceEncoding
$dstEnc = [System.Text.UTF8Encoding]::new($false)

$count = 0
Write-Host "Convert to UTF-8 (no BOM) started"
Write-Host "Root: $Root"
Write-Host "SourceEncoding: $SourceEncoding"
Write-Host "WhatIf: $WhatIf"

foreach ($pattern in $Extensions) {
    $files = Get-ChildItem -Path $Root -Recurse -File -Filter $pattern
    foreach ($file in $files) {
        $count++
        if ($WhatIf) {
            Write-Host "WHATIF $($file.FullName)" -ForegroundColor Yellow
            continue
        }
        $bytes = [System.IO.File]::ReadAllBytes($file.FullName)
        $text = $srcEnc.GetString($bytes)
        [System.IO.File]::WriteAllText($file.FullName, $text, $dstEnc)
        Write-Host "DONE   $($file.FullName)" -ForegroundColor Green
    }
}

Write-Host ""
Write-Host "Conversion finished, file count: $count"
Write-Host "Run Check-Utf8.ps1 after conversion to verify."

