@echo off
rem Abre el Lector de tendencia. Doble clic sobre este archivo.
cd /d "%~dp0"
if not exist node_modules (
  echo Instalando por primera vez, espera un momento...
  call npm install
)
start "" /min cmd /c "npm start"
