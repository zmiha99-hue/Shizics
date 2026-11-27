@echo off
chcp 65001 >nul
echo === Обновление проекта «Шизофрения» из Git ===
cd /d "%~dp0"
git pull --ff-only
if errorlevel 1 (
  echo.
  echo [!] Не удалось автоматически обновить (проверьте наличие Git или локальных правок).
  pause
  exit /b 1
)
echo.
echo [OK] Файлы обновлены! Теперь откройте chrome://extensions/ и нажмите значок "Обновить" (круглая стрелка).
pause
