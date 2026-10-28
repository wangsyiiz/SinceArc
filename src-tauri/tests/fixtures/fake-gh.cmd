@echo off
rem 假 gh：按 argv 与 FAKE_GH_MODE 模拟 GitHub CLI 的各种形态。
rem
rem 为什么用 goto/label 而不是 if ( ... ) 块：批处理里括号块会被 echo 文本中的
rem ")" 提前闭合（例如 "gh version 2.99.1 (2026-10-28)" 里的右括号），
rem 结果整段条件被执行成无条件语句 —— 实测表现是 auth status 也返回 0 并打印版本行。
rem 标签结构没有这个解析陷阱，代价只是多几行。
setlocal

if "%FAKE_GH_MODE%"=="slow" goto slow
if "%1"=="--version" goto version
if "%1"=="auth" if "%2"=="status" goto auth
if "%1"=="crash" goto crash
goto unsupported

:slow
ping -n 6 127.0.0.1 >nul

:version
if "%FAKE_GH_MODE%"=="garbage-version" goto garbage_version
echo gh version 2.99.1 (2026-10-28)
echo https://github.com/cli/cli/releases/tag/v2.99.1
exit /b 0

:garbage_version
echo this is not a gh version
exit /b 0

:auth
if "%FAKE_GH_MODE%"=="not-logged-in" goto not_logged_in
echo github.com
echo   Logged in to github.com account tester
exit /b 0

:not_logged_in
>&2 echo You are not logged into any GitHub hosts.
exit /b 1

:crash
>&2 echo fake gh crashed
exit /b 1

:unsupported
>&2 echo unsupported fake gh command
exit /b 1
