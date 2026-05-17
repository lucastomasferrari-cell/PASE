# Diagnostico-Freezes.ps1
# CORRER COMO ADMINISTRADOR.
# Habilita minidumps + sfc + DISM + memory diagnostic programado.

$ErrorActionPreference = 'Continue'

Write-Host ""
Write-Host "==============================================================="
Write-Host " DIAGNOSTICO DE FREEZES - HP EliteBook x360 1040 G8"
Write-Host "==============================================================="
Write-Host ""

# 1. Verificar que somos admin
$current = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($current)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltinRole]::Administrator)) {
    Write-Host "ERROR: este script NECESITA admin. Cerrar y reabrir PowerShell como administrador."
    pause
    exit 1
}
Write-Host "OK - corriendo como administrador."
Write-Host ""

# 2. Habilitar minidumps
Write-Host "[1/4] Habilitando minidumps..."
try {
    $key = 'HKLM:\SYSTEM\CurrentControlSet\Control\CrashControl'
    Set-ItemProperty -Path $key -Name 'CrashDumpEnabled' -Value 3 -Type DWord
    Set-ItemProperty -Path $key -Name 'MinidumpDir' -Value '%SystemRoot%\Minidump' -Type ExpandString
    Set-ItemProperty -Path $key -Name 'Overwrite' -Value 1 -Type DWord
    Set-ItemProperty -Path $key -Name 'AutoReboot' -Value 1 -Type DWord
    Set-ItemProperty -Path $key -Name 'LogEvent' -Value 1 -Type DWord
    if (-not (Test-Path 'C:\Windows\Minidump')) {
        New-Item -ItemType Directory -Path 'C:\Windows\Minidump' -Force | Out-Null
    }
    Write-Host "OK - minidumps habilitados. Proximo crash deja archivo en C:\Windows\Minidump\"
} catch {
    Write-Host "FAIL: $_"
}
Write-Host ""

# 3. SFC /scannow
Write-Host "[2/4] Corriendo sfc /scannow (chequea integridad de archivos de Windows, ~5-10 min)..."
sfc /scannow
Write-Host ""

# 4. DISM RestoreHealth
Write-Host "[3/4] Corriendo DISM /Online /Cleanup-Image /RestoreHealth (~3-5 min)..."
DISM /Online /Cleanup-Image /RestoreHealth
Write-Host ""

# 5. Programar Memory Diagnostic para el proximo reboot
Write-Host "[4/4] Programar Windows Memory Diagnostic para el proximo reboot?"
Write-Host "Cuando reinicies, Windows hara un test de RAM ANTES de cargar Windows (~30 minutos)."
Write-Host "No reinicies ahora a menos que tengas tiempo. El test es automatico."
Write-Host ""
$confirm = Read-Host "Programarlo? (S/N)"
if ($confirm -eq 'S' -or $confirm -eq 's') {
    & "$env:SystemRoot\System32\MdSched.exe" /reboot
    Write-Host "Programado. Reinicia cuando puedas dedicar ~30 min."
} else {
    Write-Host "OK, no se programo. Podes correrlo manual escribiendo 'mdsched' en Inicio."
}

Write-Host ""
Write-Host "==============================================================="
Write-Host " DIAGNOSTICO COMPLETO"
Write-Host "==============================================================="
Write-Host ""
Write-Host "Proximos pasos:"
Write-Host " 1. Esperar al proximo freeze. Despues avisame y leo el minidump."
Write-Host " 2. Si elegiste reboot, dejar correr el memory test (~30 min)."
Write-Host " 3. Llevar la laptop a servicio para limpieza + thermal paste."
Write-Host ""
pause
