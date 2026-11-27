@echo off
chcp 65001 >nul
echo === Обновление проекта «Шизофрения» с GitHub ===
cd /d "%~dp0"

where git >nul 2>&1
if %errorlevel%==0 (
  if exist ".git" (
    git pull --ff-only
    if errorlevel 1 (
      echo.
      echo [!] Не удалось выполнить git pull.
      pause
      exit /b 1
    )
    goto :done
  )
)

echo Git не найден — скачиваю архив с GitHub через PowerShell...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$zip = Join-Path $env:TEMP 'shizics_main.zip';" ^
  "$dir = Join-Path $env:TEMP 'shizics_extract';" ^
  "Invoke-WebRequest -Uri 'https://github.com/zmiha99-hue/Shizics/archive/refs/heads/main.zip' -OutFile $zip;" ^
  "if (Test-Path $dir) { Remove-Item -Recurse -Force $dir };" ^
  "Expand-Archive -Path $zip -DestinationPath $dir -Force;" ^
  "$src = Join-Path $dir 'Shizics-main';" ^
  "Copy-Item -Path (Join-Path $src '*') -Destination '.' -Recurse -Force;" ^
  "Remove-Item -Force $zip; Remove-Item -Recurse -Force $dir"

if errorlevel 1 (
  echo.
  echo [!] Ошибка при скачивании обновления с GitHub.
  pause
  exit /b 1
)

:done
echo.
echo [OK] Файлы обновлены! Теперь откройте chrome://extensions/ и нажмите значок "Обновить" (круглая стрелка).
pause
