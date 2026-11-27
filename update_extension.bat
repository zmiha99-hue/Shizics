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

echo Git не найден — скачиваю архив с GitHub...
set "ZIP_FILE=%TEMP%\shizics_%RANDOM%.zip"
set "EXTRACT_DIR=%TEMP%\shizics_extract_%RANDOM%"
set "ZIP_URL=https://github.com/zmiha99-hue/Shizics/archive/refs/heads/main.zip"

if exist "%ZIP_FILE%" del /f /q "%ZIP_FILE%" >nul 2>&1

echo [1/3] Скачивание архива...
where curl.exe >nul 2>&1
if %errorlevel%==0 (
  curl.exe -fL --connect-timeout 15 --max-time 60 --progress-bar "%ZIP_URL%" -o "%ZIP_FILE%"
) else (
  powershell -NoProfile -ExecutionPolicy Bypass -Command "$ProgressPreference='SilentlyContinue'; [Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -UseBasicParsing -TimeoutSec 45 -Uri '%ZIP_URL%' -OutFile '%ZIP_FILE%'"
)

if errorlevel 1 (
  echo.
  echo [!] Ошибка при скачивании архива с GitHub. Проверьте интернет или VPN.
  pause
  exit /b 1
)

echo [2/3] Распаковка архива...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ProgressPreference='SilentlyContinue';" ^
  "if (Test-Path '%EXTRACT_DIR%') { Remove-Item -Recurse -Force '%EXTRACT_DIR%' };" ^
  "Expand-Archive -Path '%ZIP_FILE%' -DestinationPath '%EXTRACT_DIR%' -Force"

if errorlevel 1 (
  echo.
  echo [!] Ошибка при распаковке архива.
  pause
  exit /b 1
)

echo [3/3] Копирование обновлённых файлов...
robocopy "%EXTRACT_DIR%\Shizics-main" "%~dp0." /E /XF update_extension.bat /NFL /NDL /NJH /NJS /NC /NS /NP >nul
if errorlevel 8 (
  echo.
  echo [!] Ошибка при копировании файлов. Закройте открытые файлы и попробуйте снова.
  pause
  exit /b 1
)

del /f /q "%ZIP_FILE%" >nul 2>&1
rmdir /s /q "%EXTRACT_DIR%" >nul 2>&1

:done
echo.
echo [OK] Файлы обновлены! Теперь откройте chrome://extensions/ и нажмите значок "Обновить" (круглая стрелка).
pause
