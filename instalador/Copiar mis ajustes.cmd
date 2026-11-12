@echo off
rem Copia los ajustes y la memoria del mercado a esta computadora (no copia claves).
setlocal
set "DEST=%APPDATA%\senales-overlay"
if not exist "%DEST%" mkdir "%DEST%"
if exist "%DEST%\config.json" (
  echo Ya hay ajustes en esta computadora: no se tocan.
) else (
  copy /y "%~dp0datos\config.json" "%DEST%\config.json" >nul
  echo Ajustes copiados.
)
if not exist "%DEST%\memoria" mkdir "%DEST%\memoria"
xcopy /y /d /q "%~dp0datos\memoria\*" "%DEST%\memoria\" >nul
echo Memoria del mercado copiada.
echo.
echo Listo. Ahora abre "Lector de tendencia.exe", pega las claves en el engrane y marca la zona.
pause
