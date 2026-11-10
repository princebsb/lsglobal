@echo off
setlocal EnableExtensions

rem ==========================================================================
rem  LS Global Assembleias - inicia o ambiente de desenvolvimento completo.
rem
rem  Ordem (ver docs\08-transmissao-livekit.md):
rem    1. Redis + Egress no WSL "LSG"        (infra\wsl\start-media.sh)
rem    2. LiveKit Server nativo do Windows   (infra\windows\start-livekit.ps1)
rem    3. API (:3333) e web (:5173)          (npm run dev)
rem
rem  O PostgreSQL roda como servico do Windows (inicio automatico).
rem  Para publicar na internet depois, rode pinggy.bat em outra janela.
rem  Ctrl+C nesta janela encerra a API e a web (LiveKit/WSL continuam).
rem ==========================================================================

pushd "%~dp0"
title LS Global Assembleias

echo.
echo  ============================================================
echo    LS Global Assembleias  ^|  ambiente de desenvolvimento
echo  ============================================================

rem --- 0. PostgreSQL --------------------------------------------------------
sc query postgresql-x64-18 | find "RUNNING" >nul
if errorlevel 1 (
  echo   [AVISO] Servico postgresql-x64-18 nao esta rodando. Tentando iniciar...
  net start postgresql-x64-18 >nul 2>&1 || echo   [AVISO] Nao consegui iniciar ^(precisa de administrador^).
)

rem --- 1. Redis + Egress (WSL) ----------------------------------------------
echo.
echo  [1/3] Redis + Egress no WSL "LSG"...
wsl -d LSG -u root -- bash "/mnt/d/LS GLOBAL/infra/wsl/start-media.sh"
rem O codigo de saida do wsl.exe nao e confiavel; confira as linhas Redis/Egress acima.

rem --- 2. LiveKit (Windows) -------------------------------------------------
echo.
echo  [2/3] LiveKit Server...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0infra\windows\start-livekit.ps1"
if errorlevel 1 (
  echo.
  echo   [ERRO] LiveKit nao respondeu. Veja D:\livekit\livekit.log
  pause
  popd
  exit /b 1
)

rem --- 3. API + web ---------------------------------------------------------
if not exist "node_modules\" (
  echo.
  echo  Instalando dependencias ^(npm install^)...
  call npm install || goto :erro
)

echo.
echo  [3/3] API e web ^(npm run dev^)...
echo    Web : https://localhost:5173   ^(ou http, se nao houver .certs^)
echo    API : http://localhost:3333/api/v1   OpenAPI: /api/docs
echo  ------------------------------------------------------------
call npm run dev
goto :fim

:erro
echo.
echo   [ERRO] Veja a mensagem acima.

:fim
echo.
pause
popd
endlocal
