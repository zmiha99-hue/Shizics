@echo off
chcp 65001 >nul
echo === Установка расширения «Шизофрения» ===
cd /d "%~dp0"
set "EXT_PATH=%~dp0browser_extension"

echo %EXT_PATH%| clip
echo.
echo [1/2] Путь к расширению скопирован в буфер обмена:
echo       %EXT_PATH%
echo.
echo [2/2] Открываю Chrome на странице расширений...
start "" chrome "chrome://extensions/" 2>nul
if errorlevel 1 (
  start "" msedge "edge://extensions/" 2>nul
)

echo.
echo Включите "Режим разработчика" -^> "Загрузить распакованное расширение"
echo и вставьте путь из буфера (Ctrl+V).
echo Для будущих обновлений просто запускайте update_extension.bat!
pause
