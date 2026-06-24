@echo off
chcp 65001 >nul
title 약국 상담 프로그램 - 자동 설치
cd /d "%~dp0"
echo.
echo   ===== 약국 상담 프로그램 자동 설치 =====
echo    (필요한 것까지 알아서 깔고, 최신으로 연결합니다)
echo.

REM ---------- 1) Node / Git 없으면 자동 설치 ----------
where node >nul 2>nul
if errorlevel 1 goto INSTALL
where git >nul 2>nul
if errorlevel 1 goto INSTALL
goto CONNECT

:INSTALL
where winget >nul 2>nul
if errorlevel 1 goto NOWINGET
where node >nul 2>nul
if not errorlevel 1 goto INSTGIT
echo   [설치] Node.js ... 허용(예) 창이 뜨면 눌러주세요.
winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
:INSTGIT
where git >nul 2>nul
if not errorlevel 1 goto INSTDONE
echo   [설치] Git ... 허용(예) 창이 뜨면 눌러주세요.
winget install -e --id Git.Git --accept-source-agreements --accept-package-agreements
:INSTDONE
echo.
echo   ==================================================
echo    설치가 끝났어요! 이 검은 창을 닫고,
echo    '설치.bat' 을 한 번만 더 더블클릭 해주세요.
echo   ==================================================
pause
exit /b

:NOWINGET
echo   [!] 자동 설치를 못 했어요. 아래 두 개를 직접 설치한 뒤 다시 실행해주세요.
echo        - Node.js : https://nodejs.org  (LTS 버튼)
echo        - Git     : https://git-scm.com/download/win
pause
exit /b

REM ---------- 2) 연결 ----------
:CONNECT
if exist "server.mjs" goto INPLACE
if exist "start.bat" goto INPLACE
goto FRESH

REM (이미 프로그램 폴더 안) 그 자리에서 연결 — 설정(.json)은 그대로 유지
:INPLACE
echo   기존 폴더를 자동 업데이트로 연결하는 중... (키/로그인 설정은 그대로 유지)
if not exist ".git" git init -b main >nul 2>nul
git remote get-url origin >nul 2>nul
if not errorlevel 1 goto HAVEREMOTE
git remote add origin https://github.com/kkt2816-bit/pharmacy-consult.git >nul 2>nul
:HAVEREMOTE
git fetch origin
git reset --hard origin/main
echo.
echo   ============== 완료! ==============
echo    이제 'start.bat' 만 더블클릭하면 됩니다.
echo    (앞으로 켤 때마다 자동으로 최신 버전이 됩니다)
echo   ===================================
pause
exit /b

REM (새 컴퓨터) 바탕화면에 새로 받기 + 바로가기
:FRESH
set "DIR=%USERPROFILE%\Desktop\약국상담프로그램"
echo   프로그램을 새로 받는 중...
if exist "%DIR%\.git" goto FUPDATE
git clone https://github.com/kkt2816-bit/pharmacy-consult.git "%DIR%"
goto FSHORT
:FUPDATE
git -C "%DIR%" fetch origin
git -C "%DIR%" reset --hard origin/main
:FSHORT
powershell -NoProfile -Command "$s=(New-Object -ComObject WScript.Shell).CreateShortcut([Environment]::GetFolderPath('Desktop')+'\약국 상담.lnk'); $s.TargetPath='%DIR%\start.bat'; $s.WorkingDirectory='%DIR%'; $s.Save()" >nul 2>nul
echo.
echo   ============== 설치 완료! ==============
echo    바탕화면의 '약국 상담' 아이콘을 더블클릭하면 실행됩니다.
echo    (앞으로 켤 때마다 자동으로 최신 버전이 됩니다)
echo   =======================================
timeout /t 2 >nul
start "" "%DIR%\start.bat"
exit /b
