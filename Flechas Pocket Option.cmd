@echo off
rem Flechas para Pocket Option: IZQUIERDA = Buy, DERECHA = Sell (solo en la ventana de Pocket Option).
rem Para cerrarlo: icono junto al reloj -> clic derecho -> Salir.  F8 lo pausa.
start "" powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0tools\flechas.ps1"
