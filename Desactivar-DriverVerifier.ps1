# Desactivar-DriverVerifier.ps1
# ----------------------------------------------------------------------
# Revierte Driver Verifier al estado por defecto (apagado).
# Ejecutar como administrador. Requiere reboot para tomar efecto.
#
# Usar este script cuando:
#   - Ya identificamos el driver culpable y queremos volver al estado normal.
#   - La PC tiene BSODs muy frecuentes y queremos desactivar mientras
#     investigamos cual driver lo causa.
#
# Si la PC NO bootea por BSOD loop: este script NO va a poder correr
# porque no llegas al escritorio. En ese caso seguir Safe Mode:
#   1. Power button x3 durante el arranque -> menu de recuperacion.
#   2. Solucionar problemas -> Opciones avanzadas -> Configuracion de
#      inicio -> Reiniciar -> tecla 4 (Modo seguro).
#   3. cmd admin: verifier /reset
#   4. Reiniciar.
# ----------------------------------------------------------------------

#Requires -RunAsAdministrator

Write-Host "=== Driver Verifier - Desactivacion ===" -ForegroundColor Cyan
Write-Host ""

Write-Host "Estado actual de Verifier:" -ForegroundColor Yellow
& verifier /query
Write-Host ""

Write-Host "Ejecutando verifier /reset..." -ForegroundColor Yellow
& verifier /reset
$exit = $LASTEXITCODE
Write-Host ""

if ($exit -eq 0) {
    Write-Host "=== Verifier desactivado ===" -ForegroundColor Green
    Write-Host ""
    Write-Host "PROXIMO PASO: REINICIAR para que tome efecto:" -ForegroundColor Cyan
    Write-Host "  shutdown /r /t 0"                            -ForegroundColor White
} else {
    Write-Host ("=== ERROR: verifier devolvio exit code " + $exit + " ===") -ForegroundColor Red
}
