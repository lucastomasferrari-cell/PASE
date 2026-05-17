# Activar-DriverVerifier.ps1
# ----------------------------------------------------------------------
# Activa Microsoft Driver Verifier sobre los drivers de TERCEROS
# (no-Microsoft) cargados en este equipo, para diagnosticar el origen
# de los freezes/cuelgues.
#
# Que hace:
#   - Detecta drivers .sys de terceros cargados.
#   - Activa Verifier con el set "Standard" (el mas seguro).
#   - Requiere reboot para tomar efecto.
#
# Si la PC bootea en BSOD loop: power button x3 en arranque -> Safe
# Mode -> 'verifier /reset' como admin -> reiniciar.
# ----------------------------------------------------------------------

#Requires -RunAsAdministrator

$ErrorActionPreference = 'Stop'

Write-Host "=== Driver Verifier - Activacion ===" -ForegroundColor Cyan
Write-Host ""

# ----------------------------------------------------------------------
# Helper: resolver el path real de un driver desde la propiedad ImagePath
# del registry. Maneja formatos: \SystemRoot\, \??\, system32\..., y
# paths absolutos.
# ----------------------------------------------------------------------
function Resolve-DriverPath {
    param([string]$ImagePath)
    if (-not $ImagePath) { return $null }
    $p = $ImagePath.Trim('"')
    $sysRoot = $env:SystemRoot  # tipicamente C:\Windows

    # \SystemRoot\System32\drivers\foo.sys
    if ($p -match '^\\SystemRoot\\(.+)$') {
        return Join-Path $sysRoot $Matches[1]
    }
    # \??\C:\path\foo.sys
    if ($p -match '^\\\?\?\\(.+)$') {
        return $Matches[1]
    }
    # system32\drivers\foo.sys (relativo a SystemRoot)
    if ($p -match '^[Ss]ystem[Rr]oot\\(.+)$' -or $p -match '^[Ss]ystem32\\') {
        return Join-Path $sysRoot ($p -replace '^[Ss]ystem[Rr]oot\\', '')
    }
    # Path absoluto C:\...
    if ($p -match '^[A-Za-z]:\\') {
        return $p
    }
    # Cualquier otra cosa: asumir relativo a SystemRoot
    return Join-Path $sysRoot $p
}

# ----------------------------------------------------------------------
# 1) Enumerar drivers cargados y resolver path real
# ----------------------------------------------------------------------
Write-Host "1/4 Detectando drivers de terceros cargados..." -ForegroundColor Yellow

$services = Get-CimInstance Win32_SystemDriver -ErrorAction SilentlyContinue |
            Where-Object { $_.State -eq 'Running' }
Write-Host ("  Servicios en estado Running: " + $services.Count) -ForegroundColor Gray

$resolved = @()
$notFound = 0
foreach ($svc in $services) {
    # Leer ImagePath directo del registry (mas confiable que PathName)
    $regKey = "HKLM:\SYSTEM\CurrentControlSet\Services\" + $svc.Name
    try {
        $reg = Get-ItemProperty -Path $regKey -ErrorAction Stop
        $imgPath = $reg.ImagePath
    } catch {
        $imgPath = $svc.PathName  # fallback
    }
    $abs = Resolve-DriverPath $imgPath
    if ($abs -and (Test-Path $abs)) {
        $resolved += [PSCustomObject]@{
            Service = $svc.Name
            Path    = $abs
            SysFile = [System.IO.Path]::GetFileName($abs)
        }
    } else {
        $notFound++
    }
}
Write-Host ("  Drivers con .sys resuelto: " + $resolved.Count) -ForegroundColor Gray
if ($notFound -gt 0) {
    Write-Host ("  Drivers cuyo path no se pudo resolver: " + $notFound + " (ignorados)") -ForegroundColor Gray
}

# ----------------------------------------------------------------------
# 2) Filtrar por firma no-Microsoft
# ----------------------------------------------------------------------
$thirdParty = @()
$msCount    = 0
$noSigCount = 0
foreach ($d in $resolved) {
    try {
        $sigObj = Get-AuthenticodeSignature -FilePath $d.Path -ErrorAction Stop
    } catch { continue }

    $cert = $sigObj.SignerCertificate
    if (-not $cert) { $noSigCount++; continue }

    $subject = $cert.Subject
    if ($subject -match 'Microsoft Corporation|Microsoft Windows') {
        $msCount++
        continue
    }

    $signerName = $subject
    if ($subject -match 'CN=([^,]+)') { $signerName = $Matches[1] }

    $thirdParty += [PSCustomObject]@{
        Service = $d.Service
        SysFile = $d.SysFile
        Path    = $d.Path
        Signer  = $signerName.Trim('"').Trim()
    }
}

$thirdParty = @($thirdParty | Sort-Object SysFile -Unique)
Write-Host ("  Microsoft (filtrados):       " + $msCount)       -ForegroundColor Gray
Write-Host ("  Sin firma (filtrados):       " + $noSigCount)    -ForegroundColor Gray
Write-Host ("  Terceros .sys unicos:        " + $thirdParty.Count) -ForegroundColor Green
Write-Host ""

if ($thirdParty.Count -eq 0) {
    Write-Host "ERROR: no se detectaron drivers de terceros validos. Abortando." -ForegroundColor Red
    exit 1
}

# Mostrar la lista
$thirdParty | Format-Table SysFile, Signer -AutoSize | Out-String | Write-Host

# ----------------------------------------------------------------------
# 3) Backup del estado actual de Verifier
# ----------------------------------------------------------------------
$sysList = @($thirdParty.SysFile)
Write-Host ("2/4 Verifier se activara sobre " + $sysList.Count + " drivers .sys") -ForegroundColor Yellow
Write-Host ""

if ($sysList.Count -gt 100) {
    Write-Host ("AVISO: " + $sysList.Count + " excede el limite seguro (~100). Truncando.") -ForegroundColor Red
    $priority = $thirdParty | Where-Object { $_.Signer -match 'Intel|Realtek|Synaptics|Fortemedia|Sonitude|Sound Research' }
    $rest     = $thirdParty | Where-Object { $_.Signer -notmatch 'Intel|Realtek|Synaptics|Fortemedia|Sonitude|Sound Research' }
    $combined = @($priority) + @($rest)
    $sysList  = @(($combined | Select-Object -First 100).SysFile)
}

Write-Host "3/4 Backup del estado actual de Verifier..." -ForegroundColor Yellow
$backupPath = "$env:USERPROFILE\verifier-backup-$(Get-Date -Format 'yyyyMMdd-HHmmss').txt"
& verifier /query *> $backupPath
Write-Host ("  Estado previo guardado en: " + $backupPath) -ForegroundColor Gray
Write-Host ""

# ----------------------------------------------------------------------
# 4) Activar Verifier
# ----------------------------------------------------------------------
Write-Host "4/4 Activando Verifier..." -ForegroundColor Yellow
Write-Host ("  Comando: verifier /standard /driver " + ($sysList -join ' ')) -ForegroundColor DarkGray

$argList = @('/standard', '/driver') + $sysList
& verifier @argList
$exit = $LASTEXITCODE
Write-Host ""

if ($exit -eq 0) {
    Write-Host "=== Verifier activado correctamente ===" -ForegroundColor Green
    Write-Host ""
    Write-Host "PROXIMO PASO: reiniciar la laptop:"        -ForegroundColor Cyan
    Write-Host "  shutdown /r /t 0"                        -ForegroundColor White
    Write-Host ""
    Write-Host "Despues usa la PC normal. Si hay BSOD, los minidumps quedan en" -ForegroundColor Cyan
    Write-Host "  C:\Windows\Minidump\"                                          -ForegroundColor White
    Write-Host ""
    Write-Host "Para DESACTIVAR: ejecutar Desactivar-DriverVerifier.ps1 (admin) y reboot." -ForegroundColor Cyan
    Write-Host ""
    Write-Host "SI ENTRA EN BOOT LOOP:" -ForegroundColor Yellow
    Write-Host "  1. Power button x3 durante el arranque (forzar menu recuperacion)." -ForegroundColor White
    Write-Host "  2. Solucionar problemas -> Opciones avanzadas ->" -ForegroundColor White
    Write-Host "     Configuracion de inicio -> Reiniciar -> tecla 4 (Modo seguro)." -ForegroundColor White
    Write-Host "  3. En Safe Mode, cmd admin: verifier /reset" -ForegroundColor White
    Write-Host "  4. Reiniciar normal." -ForegroundColor White
} else {
    Write-Host ("=== ERROR: verifier devolvio exit code " + $exit + " ===") -ForegroundColor Red
}
