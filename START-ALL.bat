@echo off
chcp 65001 >nul
setlocal
title Volcanobet Bingo Tracker

REM ============================================================
REM  Volcanobet Bingo Tracker - START ALL
REM
REM   1/4  instalira zavisnosti (samo prvi put)
REM   2/4  brzi fetch - ucitava zadnja zavrsena kola u JSON
REM        (odmah ima SVEZE brojeve, bez cekanja na GitHub!)
REM   3/4  watch + server + browser - ODMAH, bez cekanja
REM   4/4  GitHub Action trigger u POZADINI (osvezava online feed)
REM
REM  Napomena: ne ceka se GitHub Action ni Pages deployment -
REM  lokalni fetch dovodi sveze kole odmah, a GitHub feed se
REM  osvezava sam u pozadini (cron na 5 min radi i sam po sebi).
REM
REM  JSON cuva zadnjih 120 kola. Prvo pokretanje ucita ~10,
REM  a svako novo kolo se dodaje dok se ne napuni svih 120.
REM ============================================================

cd /d "%~dp0"

echo.
echo  [1/4] Zavisnosti (node_modules)...
if not exist node_modules (
    echo        Prvo pokretanje: npm install...
    call npm install
    if errorlevel 1 goto :fail
) else (
    echo        Vec instalirano - preskacem.
)

echo.
echo  [2/4] Brzi fetch zadnjih kola (~12 s) - svezi brojevi odmah...
call node scripts\fetch-bingo.mjs --quick
if errorlevel 1 goto :fail

echo.
echo  [3/4] Watch + server + browser (odmah, bez cekanja)...
start "Bingo WATCH (ostavi otvoren)" cmd /k "chcp 65001 >nul && npm run watch"
start "Bingo SERVER (ostavi otvoren)" cmd /k "chcp 65001 >nul && npm run serve"
timeout /t 2 /nobreak >nul
start "" "http://localhost:8080"

echo.
echo  [4/4] GitHub Action trigger u pozadini (ne ceka se)...
REM  Trigger ide u POZADINI: osvezava ONLINE feed (GitHub + Pages).
REM  Lokalno vec imas sveze kole iz koraka 2/4 - ovo je samo za online kopiju.
start "Bingo TRIGGER (pozadina)" /min cmd /c "chcp 65001 >nul && npm run trigger -- --wait"

echo.
echo  ============================================================
echo   Sve radi! Prikaz zadnjih 120 kola:  http://localhost:8080
echo   Svezi brojevi su vec ucitani (korak 2/4).
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
