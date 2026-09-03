<#
.SYNOPSIS
Collect repeatable Windows release-sidecar latency and peak-working-set data.

.DESCRIPTION
Runs one fixed sidecar operation repeatedly against a caller-supplied test
save and request JSON. The script records every sample plus p50/p95/max and
Windows PeakWorkingSet64. It requires PowerShell 7 and never copies, modifies
or uploads the save.

Run cold and warm series as separate invocations and give each an explicit
RunClass. The script does not pretend it can clear the Windows filesystem
cache; preparing a genuinely cold environment remains a release-test step.

.EXAMPLE
pwsh -File build/measureSaveParserPerformance.ps1 `
  -Operation extract `
  -InputPath C:\votc-test\fixture.ck3 `
  -RequestJsonPath C:\votc-test\extract-request.json `
  -Runs 20 -RunClass warm `
  -OutputPath test-output\save-parser-warm.json
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('probe', 'extract', 'verify')]
    [string]$Operation,

    [Parameter(Mandatory = $true)]
    [string]$InputPath,

    [Parameter(Mandatory = $true)]
    [string]$RequestJsonPath,

    [string]$ExecutablePath = (Join-Path $PSScriptRoot '..\tools\votc-save-facts\target\release\votc-save-facts.exe'),

    [ValidateRange(1, 200)]
    [int]$Runs = 20,

    [ValidatePattern('^[A-Za-z0-9._-]{1,32}$')]
    [string]$RunClass = 'warm',

    [string]$OutputPath = (Join-Path (Get-Location) "save-parser-performance-$RunClass.json"),

    [ValidateRange(65536, 2097152)]
    [int]$MaxOutputBytes = 2097152
)

$ErrorActionPreference = 'Stop'

$resolvedExecutable = (Resolve-Path -LiteralPath $ExecutablePath).Path
$resolvedInput = (Resolve-Path -LiteralPath $InputPath).Path
$resolvedRequest = (Resolve-Path -LiteralPath $RequestJsonPath).Path
$allowedRoot = Split-Path -Parent $resolvedInput
$requestJson = [System.IO.File]::ReadAllText($resolvedRequest, [System.Text.Encoding]::UTF8)
[void]($requestJson | ConvertFrom-Json -Depth 100)

function Get-Percentile {
    param(
        [Parameter(Mandatory = $true)][double[]]$Values,
        [Parameter(Mandatory = $true)][ValidateRange(0, 100)][double]$Percentile
    )
    $sorted = @($Values | Sort-Object)
    if ($sorted.Count -eq 1) { return $sorted[0] }
    $rank = [Math]::Ceiling(($Percentile / 100.0) * $sorted.Count) - 1
    return $sorted[[Math]::Max(0, [Math]::Min($rank, $sorted.Count - 1))]
}

$samples = [System.Collections.Generic.List[object]]::new()
for ($run = 1; $run -le $Runs; $run++) {
    $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $resolvedExecutable
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardInput = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    foreach ($argument in @(
        $Operation,
        '--input', $resolvedInput,
        '--allowed-root', $allowedRoot,
        '--max-output-bytes', [string]$MaxOutputBytes
    )) {
        [void]$startInfo.ArgumentList.Add($argument)
    }

    $process = [System.Diagnostics.Process]::new()
    $process.StartInfo = $startInfo
    $stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
    if (-not $process.Start()) { throw "Failed to start $resolvedExecutable" }
    $stdoutTask = $process.StandardOutput.ReadToEndAsync()
    $stderrTask = $process.StandardError.ReadToEndAsync()
    $process.StandardInput.Write($requestJson)
    $process.StandardInput.Close()

    [int64]$peakWorkingSetBytes = 0
    while (-not $process.HasExited) {
        try {
            $process.Refresh()
            $peakWorkingSetBytes = [Math]::Max($peakWorkingSetBytes, $process.PeakWorkingSet64)
        } catch {
            # A very short process can exit between HasExited and Refresh.
        }
        Start-Sleep -Milliseconds 5
    }
    $process.WaitForExit()
    $stopwatch.Stop()
    $stdout = $stdoutTask.GetAwaiter().GetResult()
    $stderr = $stderrTask.GetAwaiter().GetResult()
    try {
        $process.Refresh()
        $peakWorkingSetBytes = [Math]::Max($peakWorkingSetBytes, $process.PeakWorkingSet64)
    } catch {
        # The sampled value remains valid.
    }

    if ($process.ExitCode -ne 0) {
        throw "Run $run failed with exit code $($process.ExitCode): $stderr"
    }
    $response = $stdout | ConvertFrom-Json -Depth 100
    if ($response.operation -ne $Operation -or $response.status -notin @('ok', 'partial')) {
        throw "Run $run returned an unusable response (operation=$($response.operation), status=$($response.status))"
    }
    $samples.Add([ordered]@{
        run = $run
        elapsedMs = [Math]::Round($stopwatch.Elapsed.TotalMilliseconds, 3)
        peakWorkingSetBytes = $peakWorkingSetBytes
        status = $response.status
        parserDurationMs = $response.metrics.durationMs
        inputBytes = $response.metrics.inputBytes
        decompressedBytes = $response.metrics.decompressedBytes
        emittedFacts = $response.metrics.emittedFacts
        emittedEntities = $response.metrics.emittedEntities
        stdoutBytes = [System.Text.Encoding]::UTF8.GetByteCount($stdout)
    })
}

[double[]]$elapsedValues = @($samples | ForEach-Object { [double]$_.elapsedMs })
[double[]]$workingSetValues = @($samples | ForEach-Object { [double]$_.peakWorkingSetBytes })
$report = [ordered]@{
    schemaVersion = 1
    measuredAt = (Get-Date).ToUniversalTime().ToString('o')
    runClass = $RunClass
    operation = $Operation
    executable = $resolvedExecutable
    inputFileName = [System.IO.Path]::GetFileName($resolvedInput)
    inputBytes = (Get-Item -LiteralPath $resolvedInput).Length
    runs = $Runs
    machine = [ordered]@{
        os = [System.Environment]::OSVersion.VersionString
        processors = [System.Environment]::ProcessorCount
        architecture = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()
    }
    aggregate = [ordered]@{
        elapsedP50Ms = Get-Percentile -Values $elapsedValues -Percentile 50
        elapsedP95Ms = Get-Percentile -Values $elapsedValues -Percentile 95
        elapsedMaxMs = ($elapsedValues | Measure-Object -Maximum).Maximum
        peakWorkingSetP95Bytes = Get-Percentile -Values $workingSetValues -Percentile 95
        peakWorkingSetMaxBytes = ($workingSetValues | Measure-Object -Maximum).Maximum
    }
    samples = $samples
}

$resolvedOutput = [System.IO.Path]::GetFullPath($OutputPath)
[System.IO.Directory]::CreateDirectory([System.IO.Path]::GetDirectoryName($resolvedOutput)) | Out-Null
[System.IO.File]::WriteAllText(
    $resolvedOutput,
    ($report | ConvertTo-Json -Depth 100),
    [System.Text.UTF8Encoding]::new($false)
)
Write-Output $resolvedOutput
