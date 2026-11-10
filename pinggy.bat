@echo off
setlocal EnableExtensions

rem ==========================================================================
rem  LS Global Assembleias - publica o sistema em https://www.hellou.com.br
rem  pelo Pinggy, COM audio e video para quem esta fora da rede local.
rem
rem  Uso:
rem    pinggy.bat          publica a porta 5173 (Vite do npm run dev)
rem    pinggy.bat 8080     publica outra porta
rem
rem  Abre dois tuneis:
rem    1. pagina, API e sinalizacao: ssh do Pinggy, https://www.hellou.com.br
rem       -> https://127.0.0.1:5173 (o Vite atende em HTTPS: x:localServerTls)
rem    2. midia (audio/video): D:\PINGGY\pinggy.exe, TCP -> relay TURN
rem       (coturn) no WSL -> LiveKit. O LiveKit e reiniciado anunciando o relay.
rem  Ao sair, fecha os tuneis e volta o LiveKit a configuracao so de rede local.
rem  A logica fica em infra\windows\pinggy-publico.ps1.
rem
rem  Antes, nesta ordem (ver docs\08-transmissao-livekit.md):
rem    wsl -d LSG -u root -- bash "/mnt/d/LS GLOBAL/infra/wsl/start-media.sh"
rem    powershell -ExecutionPolicy Bypass -File infra\windows\start-livekit.ps1
rem    npm run dev
rem
rem  O sistema exige login. Ainda assim, o endereco fica publico enquanto o
rem  tunel estiver aberto: use senhas longas e feche quando nao estiver em uso.
rem ==========================================================================

pushd "%~dp0"

set "PORTA=%~1"
if "%PORTA%"=="" set "PORTA=5173"

echo.
echo  ============================================================
echo    LS Global Assembleias  ^|  tunel Pinggy
echo  ============================================================
echo    Publicando : https://127.0.0.1:%PORTA%  em  https://www.hellou.com.br
echo    Midia      : relay TURN (coturn no WSL) por tunel TCP
echo  ------------------------------------------------------------

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0infra\windows\pinggy-publico.ps1" -WebPort %PORTA%
set "RC=%ERRORLEVEL%"
if not "%RC%"=="0" (
  echo.
  echo   [ERRO] Veja a mensagem acima.
)
echo.
pause
popd
endlocal & exit /b %RC%
