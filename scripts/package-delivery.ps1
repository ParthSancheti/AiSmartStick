param([ValidatePattern('^[a-zA-Z0-9-]+$')][string]$ReleaseTag = '2026-10-18')
$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$deliveryRoot = Join-Path $projectRoot 'deliverables'
New-Item -ItemType Directory -Force -Path $deliveryRoot | Out-Null
$zipPath = Join-Path $deliveryRoot "AI-SmartStick-source-$ReleaseTag.zip"
if (Test-Path -LiteralPath $zipPath) { throw "Delivery already exists: $zipPath" }
$tracked = & git -C $projectRoot ls-files
$newSource = & git -C $projectRoot ls-files --others --exclude-standard -- src shared functions/src tests scripts docs android/app/src/main/java android/app/src/test android-typecheck/stubs '*.md'
$files = @($tracked + $newSource) | Sort-Object -Unique | Where-Object {
    $_ -notmatch '^(validation|deliverables|\.vscode|\.git|node_modules|dist|\.build-tmp)/' -and
    $_ -notmatch '(^|/)(\.env(?!\.example$)|google-services\.json$|local\.properties$)' -and
    $_ -notmatch '\.(zip|apk|jks|keystore|p12|pfx)$'
}
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [IO.Compression.ZipFile]::Open($zipPath, [IO.Compression.ZipArchiveMode]::Create)
try {
    foreach ($relative in $files) {
        $full = [IO.Path]::GetFullPath((Join-Path $projectRoot $relative))
        if (-not $full.StartsWith($projectRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Path escaped project' }
        if (-not (Test-Path -LiteralPath $full -PathType Leaf)) { continue }
        [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, $full, ('AI-SmartStick/' + $relative.Replace('\','/')), [IO.Compression.CompressionLevel]::Optimal) | Out-Null
    }
} finally { $archive.Dispose() }
$apkPaths = @()
foreach ($role in @('user', 'guardian')) {
    $source = Join-Path $deliveryRoot "AI-SmartStick-$role-debug.apk"
    if (-not (Test-Path -LiteralPath $source)) { throw "Build the $role app first: npm run apk:$role" }
    $apkPath = Join-Path $deliveryRoot "AI-SmartStick-$role-debug-$ReleaseTag.apk"
    Copy-Item -LiteralPath $source -Destination $apkPath
    $apkPaths += $apkPath
}
$verify = [IO.Compression.ZipFile]::OpenRead($zipPath)
try {
    if ($verify.Entries.Count -lt 400) { throw 'Unexpectedly small source archive' }
    if (-not $verify.GetEntry('AI-SmartStick/android/app/src/main/java/in/aismartstick/app/NativeWalkingTracker.java')) { throw 'Native walking source missing' }
    foreach ($entry in $verify.Entries) {
        if ($entry.FullName -match '(^|/)(\.env$|google-services\.json$)|/validation/') { throw 'Excluded file entered archive' }
    }
    Write-Output "Verified source archive: $($verify.Entries.Count) entries"
} finally { $verify.Dispose() }
Get-FileHash -Algorithm SHA256 -LiteralPath (@($zipPath) + $apkPaths) | ForEach-Object {
    "$($_.Hash)  $([IO.Path]::GetFileName($_.Path))"
} | Set-Content -LiteralPath (Join-Path $deliveryRoot "SHA256SUMS-$ReleaseTag.txt")
Get-Item -LiteralPath (@($zipPath) + $apkPaths) | Select-Object Name, Length
