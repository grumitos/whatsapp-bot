@echo off
rem Abrir este archivo otra vez es el reinicio manual: primero se cierra la ventana anterior (con su
rem bot y su navegador) y despues esta toma el titulo. Nunca hay dos instancias.
taskkill /FI "WINDOWTITLE eq WhatsApp Bot*" /T /F >nul 2>&1
title WhatsApp Bot
cd /d "%~dp0"

rem Si el bot se detiene, se relanza a los 5 segundos. El bucle va en un bloque: cmd
rem lo lee entero antes de ejecutarlo, asi que este archivo se puede editar con el bot en marcha.
:loop
(
    if not exist node_modules (
        echo Instalando dependencias...
        set PUPPETEER_SKIP_DOWNLOAD=true
        call bun install --silent
    )
    bun src/main.ts
    echo.
    echo Reiniciando en 5 segundos ^(cierra esta ventana para salir^)...
    timeout /t 5 /nobreak >nul
    echo.
    goto loop
)
