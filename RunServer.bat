@echo off
title Vyntra Server

cd /d %~dp0

echo Starting Vyntra server...
start cmd /k node server.js

timeout /t 3 >nul

echo Starting ngrok tunnel...
start cmd /k ngrok http 3000

pause