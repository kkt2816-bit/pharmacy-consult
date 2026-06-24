@echo off
chcp 65001 >nul
title 약국 상담 정리 프로그램
cd /d "%~dp0"

REM === 최신 버전 자동 업데이트 (git 있고, 이 폴더가 GitHub와 연결돼 있으면) ===
REM   설정 파일(.json)은 .gitignore 처리돼서 절대 안 덮어써짐 → 연결 유지
where git >nul 2>nul
if not errorlevel 1 if exist ".git" (
  echo  최신 버전 확인 중...
  git fetch --quiet origin 2>nul
  git reset --hard origin/main --quiet 2>nul
)

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo [!] Node.js 가 설치되어 있지 않습니다.
  echo     https://nodejs.org 에서 LTS 버전을 설치한 뒤 다시 실행하세요.
  echo.
  pause
  exit /b
)

echo.
echo  약국 상담 정리 프로그램을 시작합니다...
echo  브라우저가 자동으로 열립니다. (안 열리면 http://127.0.0.1:8800 접속)
echo  이 검은 창은 프로그램이 켜져 있는 동안 닫지 마세요.
echo.
node server.mjs
pause
