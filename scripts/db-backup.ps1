<#
  .SYNOPSIS
    CockroachDB SQL dump backup for Visa Compass (small-footprint fallback to
    BACKUP). Prefer streaming `BACKUP INTO` for production scale.

  .PARAMETER DatabaseUrl
    Prisma/Cockroach connection string, e.g.
    postgresql://user:pass@host:26257/visa_compass?sslmode=disable

  .PARAMETER BackupDir
    Directory to write timestamped dumps into (default ./db-backups).

  .PARAMETER Retention
    Number of most recent dumps to keep (default 14).
#>
param(
  [Parameter(Mandatory = $true)]
  [string]$DatabaseUrl,
  [string]$BackupDir = "./db-backups",
  [int]$Retention = 14
)

$ErrorActionPreference = "Stop"

if (-not (Get-Command cockroach -ErrorAction SilentlyContinue)) {
  Write-Error "cockroach binary not found on PATH. Install CockroachDB first."
}

$uri = [System.Uri]::new($DatabaseUrl -replace "postgresql://", "http://")
$hostAndPort = $uri.Host + ":" + $uri.Port
$dbName = $uri.AbsolutePath.TrimStart("/")
$user = $uri.UserInfo.Split(":")[0]

New-Item -ItemType Directory -Force -Path $BackupDir | Out-Null
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$out = Join-Path $BackupDir "visa_compass_$stamp.sql"

Write-Host "Dumping database '$dbName' from $hostAndPort as '$user' -> $out"
& cockroach dump $dbName --host $hostAndPort --user $user --insecure --file $out
if ($LASTEXITCODE -ne 0) { Write-Error "cockroach dump failed with exit code $LASTEXITCODE" }

if ((Get-Item $out).Length -eq 0) {
  Write-Error "Backup file is empty; aborting. No rotation performed."
}

Write-Host "Backup complete: $((Get-Item $out).Length) bytes"

$all = Get-ChildItem -Path $BackupDir -Filter "visa_compass_*.sql" | Sort-Object LastWriteTime -Descending
if ($all.Count -gt $Retention) {
  $all | Select-Object -Skip $Retention | ForEach-Object {
    Write-Host "Removing old backup $($_.Name)"
    Remove-Item -LiteralPath $_.FullName
  }
}

Write-Host "Done. $($all.Count) backup(s) retained."
