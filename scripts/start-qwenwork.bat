@echo off
chcp 936 >nul 2>&1
setlocal EnableExtensions
title 千问办公 启动器 (Claude Code 桥接版)

REM ============================================================
REM  千问办公 启动器 (Claude Code 桥接版)
REM
REM  为什么需要它: 环境变量只在进程启动那一刻被继承。直接双击千问办公
REM  自己的图标时, 父进程不一定带着 QODER_CLI_PATH, 于是千问办公退回
REM  自带引擎(qoderclicn.exe), 消耗千问积分而不是你的 Claude。
REM  本脚本自己设好这两个变量再启动, 绕开这个不确定性。
REM
REM  放在仓库 scripts\ 下, 路径全部相对本文件推导, 换机器也能用。
REM  编码: GBK(936) + CRLF 行尾 —— 改这个文件时请保持, 否则 cmd 会解析错乱。
REM ============================================================

REM 千问办公安装根目录, 可用环境变量覆盖
if not defined QWENWORK_ROOT set "QWENWORK_ROOT=C:\Program Files\QwenWorkCN"
REM 仓库根目录 = 本脚本所在目录的上一级
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
REM  优先用注册表里的值(权威来源); 读不到则退回仓库内相对路径。
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
REM  千问办公有单实例锁: 旧进程没退干净时, 再启动只会唤回旧窗口,
REM  不会重新读环境变量, 等于白重启。
tasklist /fi "imagename eq QwenWorkCN.exe" 2>nul | findstr /i "QwenWorkCN.exe" >nul
if errorlevel 1 goto :no_running
echo [3/4] 关闭正在运行的实例...
taskkill /f /im QwenWorkCN.exe >nul 2>&1
call :sleep 6
goto :launch

:no_running
echo [3/4] 当前没有运行中的实例

:launch
echo [4/4] 启动中...
start "" "%QW_EXE%"
echo.
echo 等待启动, 约 30 秒...
call :sleep 30

REM ---------- 自检: 走的是 custom 还是 bundled ----------
set "LOGDIR="
for /f "delims=" %%D in ('dir /b /ad /o-n "%APPDATA%\QwenWorkCN\logs" 2^>nul ^| findstr /r /c:"^[0-9][0-9]*$"') do if not defined LOGDIR set "LOGDIR=%APPDATA%\QwenWorkCN\logs\%%D"

echo.
echo ---------------- 自检 ----------------
if not defined LOGDIR goto :no_logdir
findstr /c:"Using custom QODER_CLI_PATH" "%LOGDIR%\main.log" >nul 2>&1
if not errorlevel 1 goto :verdict_ok
findstr /c:"Resolved bundled Qoder CLI path" "%LOGDIR%\main.log" >nul 2>&1
if not errorlevel 1 goto :verdict_bundled
echo [?] 日志里还没出现判定行, 可能还在启动中
echo     稍后自查: %LOGDIR%\main.log
goto :check_bridge

:no_logdir
echo [X] 找不到日志目录
goto :check_bridge

:verdict_ok
echo [OK] 已走 Claude Code 桥接
goto :check_bridge

:verdict_bundled
echo [X] 走了自带引擎, 在用千问积分 (不是你的 Claude)
echo     重试: 关掉千问办公, 再双击本脚本一次。

:check_bridge
REM 翻译层 8820: 挂了 Claude 就用不了 (看门狗计划任务 1 分钟内自动拉起)
netstat -ano | findstr ":8820" | findstr "LISTENING" >nul 2>&1
if not errorlevel 1 goto :bridge_ok
echo [!] 翻译层 8820 没在监听, Claude 暂时不可用
echo     等 1 分钟(看门狗会自动拉起), 或手动执行:
echo     powershell -File "%REPO_ROOT%\..\claude-hub-bridge\restart-bridge.ps1"
goto :done

:bridge_ok
echo [OK] 翻译层 8820 在监听

:done
echo ----------------------------------------
echo.
pause
endlocal
exit /b 0

:sleep
REM timeout 在 stdin 被重定向时会报错, 用 ping 更稳
ping -n %1 -w 1000 127.0.0.1 >nul 2>&1
exit /b 0
