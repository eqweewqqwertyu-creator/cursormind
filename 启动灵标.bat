@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 灵标 CursorMind

rem 检测本项目是否已在运行（只匹配命令行含本目录的 electron 进程，不误伤其他软件）
powershell -NoProfile -Command "$p = Get-CimInstance Win32_Process -Filter \"Name='electron.exe'\" | Where-Object { $_.CommandLine -like '*鼠标伴侣*' }; if ($p) { exit 1 } else { exit 0 }" >nul 2>nul
if not errorlevel 1 goto :start

echo.
echo   ==============================
echo    灵标已经在运行了
echo    （屏幕右下角托盘有白球图标）
echo   ==============================
echo.
choice /C NR /M "N=退出不动  R=结束旧实例并重启"
if errorlevel 2 goto :restart
exit /b 0

:restart
echo.
echo [灵标] 正在结束旧实例，请稍候...
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='electron.exe'\" | Where-Object { $_.CommandLine -like '*鼠标伴侣*' } | ForEach-Object { taskkill /PID $_.ProcessId /T /F | Out-Null }" >nul 2>nul
timeout /t 3 /nobreak >nul

:start
echo.
echo [灵标] 编译并启动中（后台运行，与本窗口解绑）...
echo [灵标] 关闭本窗口不影响灵标；退出灵标请用 托盘图标右键 - 退出。
echo.

rem 分离启动：Hidden PowerShell 拉起 npm start，输出重定向到日志（关窗/超时均不杀灵标）
if not exist ".temp" mkdir ".temp"
powershell -NoProfile -Command "Start-Process npm.cmd -ArgumentList 'start' -WindowStyle Hidden -WorkingDirectory '%~dp0.' -RedirectStandardOutput '.temp\start-out.log' -RedirectStandardError '.temp\start-err.log'" >nul 2>nul

rem 轮询等待灵标进程出现（2 秒一次，最多 30 秒）
set /a tries=0
:waitloop
timeout /t 2 /nobreak >nul
set /a tries+=1
powershell -NoProfile -Command "$p = Get-CimInstance Win32_Process -Filter \"Name='electron.exe'\" | Where-Object { $_.CommandLine -like '*鼠标伴侣*' }; if ($p) { exit 1 } else { exit 0 }" >nul 2>nul
if not errorlevel 1 (
  if %tries% GEQ 15 goto :fail
  goto :waitloop
)

echo [灵标] 已在后台运行（托盘见白球图标）。
echo [灵标] 退出方式：托盘图标右键 - 退出。
echo [灵标] 本窗口 4 秒后自动关闭。
timeout /t 4 /nobreak >nul
exit /b 0

:fail
echo.
echo [灵标] 30 秒内未检测到灵标进程，可能启动失败。
echo [灵标] 错误日志尾部（.temp\start-err.log）：
powershell -NoProfile -Command "if (Test-Path '.temp\start-err.log') { Get-Content '.temp\start-err.log' -Tail 15 }" 2>nul
echo.
echo 请把上方报错截图发给助手。
pause
