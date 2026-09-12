#Requires -Version 7.0
# Requires PostgreSQL binaries, Azurite, pnpm, uv, and Clerk development keys.
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$PgBinDirectory,
    [Parameter(Mandatory)][string]$AzuriteEntryPoint,
    [string]$StateDirectory = (Join-Path ([IO.Path]::GetTempPath()) ('jams-pipeline-e2e-' + [guid]::NewGuid())),
    [int]$DatabasePort = 55432,
    [int]$BlobPort = 11000,
    [int]$QueuePort = 11001,
    [int]$TablePort = 11002,
    [int]$WebPort = 3100
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
$savedEnvironment = @{}
$ownedProcesses = @()
$postgresStarted = $false
function Set-TestEnvironment([string]$Name, [string]$Value) {
    if (!$savedEnvironment.ContainsKey($Name)) {
        $savedEnvironment[$Name] = [Environment]::GetEnvironmentVariable($Name, 'Process')
    }
    [Environment]::SetEnvironmentVariable($Name, $Value, 'Process')
}
function Assert-Success([string]$Step) {
    if ($LASTEXITCODE -ne 0) { throw "$Step failed (exit $LASTEXITCODE)" }
}
function Wait-Port([int]$Port) {
    $deadline = [DateTime]::UtcNow.AddSeconds(30)
    do {
        $client = [Net.Sockets.TcpClient]::new()
        try { $client.Connect('127.0.0.1', $Port); return }
        catch { Start-Sleep -Milliseconds 250 }
        finally { $client.Dispose() }
    } while ([DateTime]::UtcNow -lt $deadline)
    throw "Local service on port $Port did not start; inspect $StateDirectory"
}
foreach ($binary in @('initdb.exe', 'pg_ctl.exe', 'psql.exe')) {
    if (!(Test-Path -LiteralPath (Join-Path $PgBinDirectory $binary))) { throw "Missing $binary" }
}
if (!(Test-Path -LiteralPath $AzuriteEntryPoint)) { throw 'Missing Azurite entry point' }
if (Test-Path -LiteralPath $StateDirectory) { throw 'StateDirectory must be a new directory' }
$ports = @($DatabasePort, $BlobPort, $QueuePort, $TablePort, $WebPort)
if (($ports | Select-Object -Unique).Count -ne 5) { throw 'Ports must be distinct' }
foreach ($port in $ports) {
    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, $port)
    try { $listener.Start() } finally { $listener.Stop() }
}
New-Item -ItemType Directory -Path $StateDirectory | Out-Null
$StateDirectory = (Resolve-Path -LiteralPath $StateDirectory).Path
$pgData = Join-Path $StateDirectory 'pgdata'
Push-Location $repo
try {
    # Only load missing variables, without displaying credentials.
    foreach ($envFile in @('apps/web/.env.local', '.env')) {
        if (!(Test-Path -LiteralPath $envFile)) { continue }
        foreach ($line in Get-Content -LiteralPath $envFile) {
            if ($line -match '^([A-Za-z_][A-Za-z0-9_]*)=(.*)$') {
                $name = $Matches[1]
                $value = $Matches[2].Trim('"', "'")
                if (![Environment]::GetEnvironmentVariable($name, 'Process')) { Set-TestEnvironment $name $value }
            }
        }
    }
    if ($env:CLERK_SECRET_KEY -notlike 'sk_test_*' -or $env:NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY -notlike 'pk_test_*') {
        throw 'Clerk development-instance keys are required'
    }
    Set-TestEnvironment 'DATABASE_URL' "postgresql://jams:jams@127.0.0.1:$DatabasePort/jams"
    Set-TestEnvironment 'DATABASE_URL_WEB' "postgresql://jams_web:jams_web@127.0.0.1:$DatabasePort/jams"
    Set-TestEnvironment 'AZURE_STORAGE_CONNECTION_STRING' "DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==;BlobEndpoint=http://127.0.0.1:$BlobPort/devstoreaccount1;QueueEndpoint=http://127.0.0.1:$QueuePort/devstoreaccount1;TableEndpoint=http://127.0.0.1:$TablePort/devstoreaccount1;"
    Set-TestEnvironment 'PLAYWRIGHT_BASE_URL' "http://localhost:$WebPort"
    Set-TestEnvironment 'JAMS_RUN_PIPELINE_E2E' '1'
    Set-TestEnvironment 'HF_HUB_OFFLINE' '1'
    Set-TestEnvironment 'OPENROUTER_API_KEY' ''
    Set-TestEnvironment 'E2E_PIPELINE_FIXTURE' (Join-Path $StateDirectory 'e2e-pipeline.mp4')
    & (Join-Path $PgBinDirectory 'initdb.exe') -D $pgData -U jams --auth=trust --encoding=UTF8 --locale=C
    Assert-Success 'Initialize isolated database'
    & (Join-Path $PgBinDirectory 'pg_ctl.exe') -D $pgData -l (Join-Path $StateDirectory 'postgres.log') -o "-p $DatabasePort -h 127.0.0.1" -w start
    Assert-Success 'Start isolated database'
    $postgresStarted = $true
    & (Join-Path $PgBinDirectory 'psql.exe') -h 127.0.0.1 -p $DatabasePort -U jams -d postgres -v ON_ERROR_STOP=1 -c 'CREATE DATABASE jams'
    Assert-Success 'Create database'
    pnpm --dir apps/web db:migrate
    Assert-Success 'Migrate database'
    uv sync --project worker --locked
    Assert-Success 'Install worker dependencies'
    uv run --project worker python worker/scripts/make_pipeline_e2e_fixture.py --output $env:E2E_PIPELINE_FIXTURE
    Assert-Success 'Generate fixture'
    $azArgs = @('"' + $AzuriteEntryPoint + '"', '--blobHost', '127.0.0.1', '--blobPort', $BlobPort,
        '--queueHost', '127.0.0.1', '--queuePort', $QueuePort, '--tableHost', '127.0.0.1', '--tablePort', $TablePort,
        '--location', ('"' + (Join-Path $StateDirectory 'azurite') + '"'), '--skipApiVersionCheck')
    $ownedProcesses += Start-Process -FilePath (Get-Command node).Source -ArgumentList $azArgs -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $StateDirectory 'azurite.log') -RedirectStandardError (Join-Path $StateDirectory 'azurite-error.log')
    Wait-Port $BlobPort
    Wait-Port $QueuePort
    $adminUrl = $env:DATABASE_URL
    Set-TestEnvironment 'DATABASE_URL' "postgresql://jams_worker:jams_worker@127.0.0.1:$DatabasePort/jams"
    $ownedProcesses += Start-Process -FilePath (Join-Path $repo 'worker/.venv/Scripts/python.exe') -ArgumentList '-m', 'jams_worker.main' -WorkingDirectory (Join-Path $repo 'worker') -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $StateDirectory 'worker.log') -RedirectStandardError (Join-Path $StateDirectory 'worker-error.log')
    Set-TestEnvironment 'DATABASE_URL' $adminUrl
    pnpm --dir apps/web exec playwright test pipeline-report.spec.ts --project chromium
    Assert-Success 'Pipeline browser test'
} finally {
    foreach ($process in $ownedProcesses) {
        try {
            if (!$process.HasExited) { $process.Kill($true); $process.WaitForExit(10000) | Out-Null }
        } catch { Write-Warning "Could not stop owned process $($process.Id): $($_.Exception.Message)" }
    }
    if ($postgresStarted) {
        try { & (Join-Path $PgBinDirectory 'pg_ctl.exe') -D $pgData -m fast -w stop }
        catch { Write-Warning "Could not stop isolated PostgreSQL: $($_.Exception.Message)" }
    }
    foreach ($name in $savedEnvironment.Keys) { [Environment]::SetEnvironmentVariable($name, $savedEnvironment[$name], 'Process') }
    Pop-Location
    Write-Host "Pipeline E2E state and logs retained at $StateDirectory"
}
