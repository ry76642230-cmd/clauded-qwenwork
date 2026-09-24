@echo off
chcp 936 >nul 2>&1
setlocal EnableExtensions
title 千问办公 启动器 (Claude Code 桥接版)

REM ============================================================
REM  千问办公 启动器 (Claude Code 桥接版)
REM
REM  为什么需要它:
REM   环境变量只在进程启动那一刻被继承。直接双击千问办公自己的图标时,
REM   父进程不一定带着 QODER_CLI_PATH, app 就退回自带引擎(qoderclicn.exe),
REM   消耗千问积分而不是你的 Claude。本脚本自己设好再启动。
REM
REM  为什么用 powershell Start-Process 启动:
REM   若用 cmd 的 start 启动, app 会继承本窗口的控制台。你一旦关掉本窗口,
REM   Windows 会给该控制台所有进程发 CTRL_CLOSE_EVENT, 千问办公被一起带走。
REM   经 Start-Process(ShellExecute) 启动则挂到 explorer 下, 关本窗口不影响它。
REM
REM  编码: GBK(936) + CRLF 行尾 —— 改动时请保持, 否则 cmd 解析错乱/中文乱码。
REM ============================================================

if not defined QWENWORK_ROOT set "QWENWORK_ROOT=C:\Program Files\QwenWorkCN"
set "REPO_ROOT=%~dp0.."

echo ==================================================
echo    千问办公 启动器  (Claude Code 桥接版)
echo ==================================================
echo.

REM ---------- 1. 选最新版本目录 ----------
set "QW_EXE="
for /f "delims=" %%D in ('dir /b /ad /o-n "%QWENWORK_ROOT%" 2^>nul') do if not defined QW_EXE if exist "%QWENWORK_ROOT%\%%D\QwenWorkCN.exe" set "QW_EXE=%QWENWORK_ROOT%\%%D\QwenWorkCN.exe"
if defined QW_EXE goto :got_exe
echo [X] 在 %QWENWORK_ROOT% 下找不到 QwenWorkCN.exe
echo     若装在别处, 先设: set QWENWORK_ROOT=你的安装根目录
echo.
pause
exit /b 1

:got_exe
echo [1/4] 程序 : %QW_EXE%

REM ---------- 2. 注入桥接环境变量 ----------
set "SHIM_PATH="
for /f "tokens=2,*" %%A in ('reg query "HKCU\Environment" /v QODER_CLI_PATH 2^>nul ^| findstr /i "REG_SZ"') do set "SHIM_PATH=%%B"
if defined SHIM_PATH goto :have_shim
set "SHIM_PATH=%REPO_ROOT%\src\bridge-shim.mjs"
echo [!] 注册表里没读到 QODER_CLI_PATH, 改用仓库内相对路径

:have_shim
set "QODER_CLI_PATH=%SHIM_PATH%"
set "QODERCLI_PATH=%SHIM_PATH%"
echo [2/4] 桥接 : %SHIM_PATH%
if exist "%SHIM_PATH%" goto :shim_ok
echo.
echo [X] 桥接文件不存在, 已中止启动。
echo     照常启动会退回自带引擎, 消耗千问积分。
echo     期望路径: %SHIM_PATH%
echo     修复: cd /d "%REPO_ROOT%" ^&^& pnpm apply
echo.
pause
exit /b 1

:shim_ok
REM ---------- 3. 关掉正在运行的实例 ----------
REM  千问办公有单实例锁: 旧进程没退干净时, 再启动只会唤回旧窗口, 不重读环境变量。
tasklist /fi "imagename eq QwenWorkCN.exe" 2>nul | findstr /i "QwenWorkCN.exe" >nul
if errorlevel 1 goto :no_running
echo [3/4] 关闭正在运行的实例...
taskkill /f /im QwenWorkCN.exe >nul 2>&1
call :sleep 7
goto :record_dir

:no_running
echo [3/4] 当前没有运行中的实例

:record_dir
REM 记住当前最新日志目录, 用来区分"本次启动新产生的目录"
call :newestlogdir
set "BEFORE_DIR=%LOGDIR%"

REM ---------- 4. 启动 (经 ShellExecute, 与本窗口解耦) ----------
echo [4/4] 启动中...
powershell -NoProfile -Command "Start-Process -FilePath '%QW_EXE%'" >nul 2>&1
if errorlevel 1 goto :launch_failed
echo.
echo 等待启动并自检 (最多约 45 秒)...

REM ---------- 5. 轮询日志, 一出现判定行就收工 ----------
set /a TRIES=0
:waitloop
call :sleep 4
set /a TRIES+=1
call :newestlogdir
if not defined LOGDIR goto :wait_again
if "%LOGDIR%"=="%BEFORE_DIR%" goto :wait_again
findstr /c:"Using custom QODER_CLI_PATH" "%LOGDIR%\main.log" >nul 2>&1
if not errorlevel 1 goto :verdict_ok
findstr /c:"Resolved bundled Qoder CLI path" "%LOGDIR%\main.log" >nul 2>&1
if not errorlevel 1 goto :verdict_bundled

:wait_again
if %TRIES% lss 12 goto :waitloop
goto :verdict_unknown

:verdict_ok
echo.
echo ---------------- 自检 ----------------
echo [OK] 已走 Claude Code 桥接
echo      日志: %LOGDIR%\main.log
call :check_bridge
call :writelog OK
echo.
echo 本窗口将在 6 秒后自动关闭, 千问办公不受影响。
call :sleep 7
endlocal
exit /b 0

:verdict_bundled
echo.
echo ---------------- 自检 ----------------
echo [X] 走了自带引擎, 在用千问积分 (不是你的 Claude)
echo      日志: %LOGDIR%\main.log
call :writelog BUNDLED
echo.
echo     修复: cd /d "%REPO_ROOT%" ^&^& pnpm apply
echo     然后关掉千问办公, 再双击本脚本一次。
echo.
pause
endlocal
exit /b 1

:verdict_unknown
echo.
echo ---------------- 自检 ----------------
echo [?] 等了约 45 秒仍未见判定行, 可能启动较慢
echo      稍后自查: %LOGDIR%\main.log
call :check_bridge
call :writelog UNKNOWN
echo.
echo 本窗口将在 10 秒后自动关闭。
call :sleep 11
endlocal
exit /b 0

:launch_failed
echo.
echo [X] 启动失败 (powershell Start-Process 返回错误)
echo     可直接手动双击: %QW_EXE%
echo.
pause
endlocal
exit /b 1

:check_bridge
REM 翻译层 8820: 挂了 Claude 就用不了 (看门狗计划任务 1 分钟内自动拉起)
netstat -ano | findstr ":8820" | findstr "LISTENING" >nul 2>&1
if not errorlevel 1 goto :bridge_ok
echo [!] 翻译层 8820 没在监听, Claude 暂时不可用
echo     等 1 分钟(看门狗会自动拉起), 或手动执行:
echo     powershell -File "%REPO_ROOT%\..\claude-hub-bridge\restart-bridge.ps1"
exit /b 0

:bridge_ok
echo [OK] 翻译层 8820 在监听
exit /b 0

:writelog
REM %1 = 判定结果; 追加到 %TEMP%\qwenwork-launcher.log
>>"%TEMP%\qwenwork-launcher.log" echo %DATE% %TIME%  %1  %LOGDIR%
exit /b 0

:newestlogdir
set "LOGDIR="
for /f "delims=" %%D in ('dir /b /ad /o-n "%APPDATA%\QwenWorkCN\logs" 2^>nul ^| findstr /r /c:"^[0-9][0-9]*$"') do if not defined LOGDIR set "LOGDIR=%APPDATA%\QwenWorkCN\logs\%%D"
exit /b 0

:sleep
REM timeout 在 stdin 被重定向时会报错, 用 ping 更稳; %1 = ping 次数
ping -n %1 -w 1000 127.0.0.1 >nul 2>&1
exit /b 0
