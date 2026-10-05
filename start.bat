@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo 正在啟動 Interior Studio：http://localhost:8080
where py >nul 2>nul && (start "" http://localhost:8080 & py -m http.server 8080 & goto :eof)
where python >nul 2>nul && (start "" http://localhost:8080 & python -m http.server 8080 & goto :eof)
where npx >nul 2>nul && (npx --yes http-server -p 8080 -c-1 -o & goto :eof)
echo 找不到 Python 或 Node.js，請安裝其中一個後再執行。
pause
