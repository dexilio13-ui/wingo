@echo off
chcp 65001 >nul
setlocal
title Volcanobet Bingo Tracker

REM ============================================================
REM  Volcanobet Bingo Tracker - START ALL
REM
REM   1/5  instalira zavisnosti (samo prvi put)
REM   2/5  brzi fetch - ucitava zadnja zavrsena kola u JSON
REM   3/5  pokrece GitHub Action workflow (ako je gh CLI instaliran)
REM   4/5  watch prozor - novo kolo se automatski dodaje (~4 min)
REM   5/5  server + automatsko otvaranje browsera sa menijem
REM
REM  JSON cuva zadnjih 40 kola. Prvo pokretanje ucita ~10,
REM  a svako novo kolo se dodaje dok se ne napuni svih 40.
REM ============================================================

cd /d "%~dp0"

echo.
echo  [1/5] Zavisnosti (node_modules)...
if not exist node_modules (
    echo        Prvo pokretanje: npm install...
    call npm install
    if errorlevel 1 goto :fail
) else (
    echo        Vec instalirano - preskacem.
)

echo.
echo  [2/5] Brzi fetch zadnjih kola (~12 s)...
call node scripts\fetch-bingo.mjs --quick
if errorlevel 1 goto :fail

echo.
echo  [3/5] GitHub Action workflow (update-bingo.yml)...
where gh >nul 2>nul
if errorlevel 1 (
    echo        gh CLI nije nadjen - preskacem.
    echo        Actions i inace rade sami po cron-u na svaki minut.
) else (
    gh workflow run update-bingo.yml
    if errorlevel 1 (
        echo        Workflow nije pokrenut iz terminala - probaj "gh auth login".
        echo        Actions i dalje rade sami po cron-u na svaki minut.
    ) else (
        echo        Workflow pokrenut - prati: GitHub repo ^> Actions.
    )
)

echo.
echo  [4/5] Watch prozor - novo kolo se dodaje automatski...
start "Bingo WATCH (ostavi otvoren)" cmd /k "chcp 65001 >nul && npm run watch"

echo.
echo  [5/5] Server + browser...
start "Bingo SERVER (ostavi otvoren)" cmd /k "chcp 65001 >nul && npm run serve"
timeout /t 2 /nobreak >nul
start "" "http://localhost:8080"

echo.
echo  ============================================================
echo   Sve radi! Prikaz zadnjih 40 kola:  http://localhost:8080
echo   Zatvori WATCH i SERVER prozore da zaustavis pracenje.
echo  ============================================================
echo.
pause
exit /b 0

:fail
echo.
echo  GRESKA: nesto nije uspelo - pogledaj poruke iznad.
pause
exit /b 1
