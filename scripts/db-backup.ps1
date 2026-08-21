<# PostgreSQL custom-format backup for Supabase, AWS RDS, or standard PostgreSQL. #>
param(
  [Parameter(Mandatory = $true)] [string]$DirectDatabaseUrl,
  [string]$BackupDir = "./db-backups",
  [int]$Retention = 14
)

$ErrorActionPreference = "Stop"
if (-not (Get-Command pg_dump -ErrorAction SilentlyContinue)) {
  Write-Error "pg_dump not found on PATH. Install PostgreSQL client tools first."
}
New-Item -ItemType Directory -Force -Path $BackupDir | Out-Null
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$out = Join-Path $BackupDir "visa_compass_$stamp.dump"
Write-Host "Creating PostgreSQL backup -> $out"
& pg_dump --format=custom --verbose --no-owner --no-acl --schema=visa_compass --file=$out $DirectDatabaseUrl
if ($LASTEXITCODE -ne 0) { Write-Error "pg_dump failed with exit code $LASTEXITCODE" }
if ((Get-Item $out).Length -eq 0) { Write-Error "Backup file is empty; no rotation performed." }

$all = Get-ChildItem -Path $BackupDir -Filter "visa_compass_*.dump" | Sort-Object LastWriteTime -Descending
if ($all.Count -gt $Retention) {
  $all | Select-Object -Skip $Retention | ForEach-Object {
    Write-Host "Removing old backup $($_.Name)"
    Remove-Item -LiteralPath $_.FullName
  }
}
Write-Host "Done. Keeping up to $Retention backups."
