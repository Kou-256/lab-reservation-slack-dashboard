param([string]$ArchivePath = (Join-Path $PSScriptRoot 'hiragino.zip'))
$ErrorActionPreference = 'Stop'
# 提供されたフォントを現在のWindowsユーザーだけに登録する。管理者権限は不要。
# フォントのダウンロード、Web配信、Gitへの追加は行わない。
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [System.IO.Compression.ZipFile]::OpenRead((Resolve-Path -LiteralPath $ArchivePath).Path)
$fontDirectory = Join-Path $env:LOCALAPPDATA 'Microsoft\Windows\Fonts'
$fontRegistry = 'HKCU:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Fonts'
New-Item -ItemType Directory -Path $fontDirectory -Force | Out-Null
New-Item -Path $fontRegistry -Force | Out-Null
$fontNames = @('HiraKakuProN-W3.ttf', 'HiraKakuProN-W6.ttf')
try {
    foreach ($fontName in $fontNames) {
        # ZIP内の既知の2ファイルだけを読み、任意のパスには展開しない。
        $entry = $archive.GetEntry('hiragino/' + $fontName)
        if (-not $entry) { throw "フォントが見つかりません: $fontName" }
        $destination = Join-Path $fontDirectory $fontName
        $source = $entry.Open()
        $target = [System.IO.File]::Create($destination)
        try { $source.CopyTo($target) } finally { $target.Dispose(); $source.Dispose() }
        $weight = if ($fontName -match 'W3') { 'W3' } else { 'W6' }
        New-ItemProperty -Path $fontRegistry -Name "Hiragino Sans $weight (TrueType)" -Value $destination -PropertyType String -Force | Out-Null
    }
} finally { $archive.Dispose() }
Write-Host 'ヒラギノ角ゴシックを登録しました。Windowsからサインアウトして再サインインし、Edgeを開き直してください。'
