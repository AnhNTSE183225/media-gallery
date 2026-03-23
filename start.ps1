# Run backend and frontend in a single terminal with prefixed logs.
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$normalizedRoot = $root.ToLower()

function Get-ProcessCommandLine {
	param([int]$ProcessId)

	$proc = Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction SilentlyContinue
	if ($proc) {
		return [string]$proc.CommandLine
	}

	return ""
}

function Stop-ProcessTree {
	param(
		[int]$ProcessId,
		[string]$Label
	)

	if (-not $ProcessId) {
		return
	}

	try {
		taskkill /PID $ProcessId /T /F | Out-Null
		Write-Host "Stopped stale $Label process (PID $ProcessId)." -ForegroundColor Yellow
	} catch {
		Write-Host "Could not stop stale $Label process (PID $ProcessId): $($_.Exception.Message)" -ForegroundColor Yellow
	}
}

function Remove-StaleDevProcesses {
	param([string]$WorkspaceRoot)

	$portRules = @(
		@{ Port = 3001; Label = 'Backend'; Match = @('server.js') },
		@{ Port = 5173; Label = 'Frontend'; Match = @('vite') }
	)

	foreach ($rule in $portRules) {
		$listeners = Get-NetTCPConnection -State Listen -LocalPort $rule.Port -ErrorAction SilentlyContinue |
			Select-Object -ExpandProperty OwningProcess -Unique

		foreach ($listenerProcessId in $listeners) {
			$commandLine = (Get-ProcessCommandLine -ProcessId $listenerProcessId).ToLower()
			$isExpected = $true

			foreach ($token in $rule.Match) {
				if ($commandLine -notlike "*$token*") {
					$isExpected = $false
					break
				}
			}

			if ($isExpected) {
				Stop-ProcessTree -ProcessId $listenerProcessId -Label $rule.Label
			} else {
				throw "Port $($rule.Port) is in use by PID $listenerProcessId ($commandLine). Resolve this conflict and run the script again."
			}
		}
	}
}

function Get-NpmExecutable {
	$npmCommand = Get-Command npm.cmd -CommandType Application -ErrorAction SilentlyContinue |
		Select-Object -First 1

	if ($npmCommand -and $npmCommand.Source) {
		return $npmCommand.Source
	}

	throw "Could not locate npm.cmd in PATH. Ensure Node.js is installed and available in PATH."
}

function Start-ManagedProcess {
	param(
		[string]$Name,
		[string]$Prefix,
		[string]$Color,
		[string]$WorkingDirectory,
		[string]$FileName,
		[string]$Arguments
	)

	$psi = New-Object System.Diagnostics.ProcessStartInfo
	$psi.FileName = $FileName
	$psi.Arguments = $Arguments
	$psi.WorkingDirectory = $WorkingDirectory
	$psi.UseShellExecute = $false
	$psi.RedirectStandardOutput = $true
	$psi.RedirectStandardError = $true
	$psi.CreateNoWindow = $true

	$process = New-Object System.Diagnostics.Process
	$process.StartInfo = $psi
	$process.EnableRaisingEvents = $true

	if (-not $process.Start()) {
		throw "Failed to start $Name"
	}

	$outEvent = Register-ObjectEvent -InputObject $process -EventName OutputDataReceived -Action {
		if ($EventArgs.Data) {
			Write-Host "[$($Event.MessageData.Prefix)] $($EventArgs.Data)" -ForegroundColor $Event.MessageData.Color
		}
	} -MessageData @{ Prefix = $Prefix; Color = $Color }

	$errEvent = Register-ObjectEvent -InputObject $process -EventName ErrorDataReceived -Action {
		if ($EventArgs.Data) {
			Write-Host "[$($Event.MessageData.Prefix)] $($EventArgs.Data)" -ForegroundColor Red
		}
	} -MessageData @{ Prefix = $Prefix; Color = $Color }

	$process.BeginOutputReadLine()
	$process.BeginErrorReadLine()

	return [PSCustomObject]@{
		Name = $Name
		Pid = $process.Id
		Process = $process
		OutputEvent = $outEvent
		ErrorEvent = $errEvent
	}
}

function Test-ProcessRunning {
	param([int]$ProcessId)

	if (-not $ProcessId) {
		return $false
	}

	$existing = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
	return $null -ne $existing
}

function Stop-ManagedProcess {
	param($ManagedProcess)

	if ($null -eq $ManagedProcess) {
		return
	}

	if ($ManagedProcess.OutputEvent) {
		Unregister-Event -SubscriptionId $ManagedProcess.OutputEvent.Id -ErrorAction SilentlyContinue
	}

	if ($ManagedProcess.ErrorEvent) {
		Unregister-Event -SubscriptionId $ManagedProcess.ErrorEvent.Id -ErrorAction SilentlyContinue
	}

	if ($ManagedProcess.Pid) {
		Write-Host "Stopping $($ManagedProcess.Name)..." -ForegroundColor Yellow
		$processId = $ManagedProcess.Pid
		try {
			# Kill whole process tree on Windows to avoid orphaned npm/node children.
			taskkill /PID $processId /T /F 2>&1 | Out-Null
		} catch {
			try {
				Stop-Process -Id $processId -Force -ErrorAction Stop
			} catch {
				# Ignore if process is already gone due to Ctrl+C race timing.
			}
		}

		try {
			if (-not $ManagedProcess.Process.HasExited) {
				$null = $ManagedProcess.Process.WaitForExit(3000)
			}
		} catch {
			Write-Host "Timed out waiting for $($ManagedProcess.Name) to stop." -ForegroundColor Yellow
		}
	}

	if ($ManagedProcess.Process) {
		$ManagedProcess.Process.Dispose()
	}
}

Write-Host "Starting backend and frontend in one terminal..." -ForegroundColor Green

Remove-StaleDevProcesses -WorkspaceRoot $normalizedRoot

$backend = $null
$frontend = $null
$script:shutdownRequested = $false

try {
	trap [System.Management.Automation.PipelineStoppedException] {
		$script:shutdownRequested = $true
		Write-Host "`nCtrl+C interrupt detected. Shutting down services..." -ForegroundColor Yellow
		continue
	}

	$backend = Start-ManagedProcess `
		-Name "Backend" `
		-Prefix "Backend" `
		-Color "Cyan" `
		-WorkingDirectory (Join-Path $root "server") `
		-FileName "node" `
		-Arguments "server.js"

	$npmExecutable = Get-NpmExecutable

	$frontend = Start-ManagedProcess `
		-Name "Frontend" `
		-Prefix "Frontend" `
		-Color "Magenta" `
		-WorkingDirectory (Join-Path $root "client") `
		-FileName $npmExecutable `
		-Arguments "run dev"

	Start-Sleep -Seconds 3
	Write-Host "Opening browser to http://localhost:5173" -ForegroundColor Green
	Start-Process "http://localhost:5173"

	Write-Host "Press Ctrl+C to stop both services." -ForegroundColor Yellow
	Write-Host "Backend PID: $($backend.Pid) | Frontend PID: $($frontend.Pid)" -ForegroundColor DarkGray

	while (-not $script:shutdownRequested) {
		if (-not (Test-ProcessRunning -ProcessId $backend.Pid)) {
			$exitCode = if ($backend.Process.HasExited) { $backend.Process.ExitCode } else { 'unknown' }
			Write-Host "Backend exited with code $exitCode." -ForegroundColor Red
			break
		}

		if (-not (Test-ProcessRunning -ProcessId $frontend.Pid)) {
			$exitCode = if ($frontend.Process.HasExited) { $frontend.Process.ExitCode } else { 'unknown' }
			Write-Host "Frontend exited with code $exitCode." -ForegroundColor Red
			break
		}

		Start-Sleep -Milliseconds 250
	}
} finally {
	Stop-ManagedProcess -ManagedProcess $frontend
	Stop-ManagedProcess -ManagedProcess $backend
	Write-Host "Cleaning up lingering dev processes..." -ForegroundColor Yellow
	try {
		Remove-StaleDevProcesses -WorkspaceRoot $normalizedRoot
	} catch {
		Write-Host "Cleanup warning: $($_.Exception.Message)" -ForegroundColor Yellow
	}
	Write-Host "All services stopped cleanly." -ForegroundColor Green
}
