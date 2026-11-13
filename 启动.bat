@echo off
cd /d "%~dp0"

rem 从 Electron 系终端（如某些 IDE）启动时会继承这个变量，
rem 它会让 electron.exe 退化成纯 Node 运行时，导致启动即崩溃
set ELECTRON_RUN_AS_NODE=

rem 可追加参数，例如：启动.bat --diag  （开启诊断日志，排查岛消失问题时用）
start "" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0." %*
