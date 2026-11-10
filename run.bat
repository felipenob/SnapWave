@echo off
setlocal
chcp 65001 >nul
set PYTHONIOENCODING=utf-8
set PYTHONUTF8=1
title SnapWave - Multi-Speaker Transcript Review Studio
echo ======================================================================
echo    SnapWave - Multi-Speaker Transcript Review Studio [100%% Offline]
echo ======================================================================
echo.

cd /d "%~dp0"

REM ----------------------------------------------------------------------
REM 1. Priority Detection: Check local .venv first, then Anaconda/System
REM ----------------------------------------------------------------------
if not exist "%~dp0.venv\Scripts\python.exe" goto :CHECK_ANACONDA
"%~dp0.venv\Scripts\python.exe" -c "import scipy, PIL, torch, transformers" >nul 2>&1
if errorlevel 1 goto :CHECK_ANACONDA
set APP_PYTHON="%~dp0.venv\Scripts\python.exe"
echo [OK] Using isolated virtual environment [.venv].
goto :LAUNCH_SERVER

:CHECK_ANACONDA
if not exist "C:\ProgramData\Anaconda3\python.exe" goto :CHECK_SYSTEM_PYTHON
"C:\ProgramData\Anaconda3\python.exe" -c "import scipy, PIL, torch, transformers" >nul 2>&1
if errorlevel 1 goto :CHECK_SYSTEM_PYTHON
set APP_PYTHON="C:\ProgramData\Anaconda3\python.exe"
echo [OK] Found Python with all required packages [Anaconda].
goto :LAUNCH_SERVER

:CHECK_SYSTEM_PYTHON
where python >nul 2>&1
if errorlevel 1 goto :RUN_INSTALLER
python -c "import scipy, PIL, torch, transformers" >nul 2>&1
if errorlevel 1 goto :RUN_INSTALLER
set APP_PYTHON=python
echo [OK] Found system Python with all required packages ready.
goto :LAUNCH_SERVER

REM ----------------------------------------------------------------------
REM 2. First-time setup: Delegate to install.bat to set up Python 3.11 & .venv
REM ----------------------------------------------------------------------
:RUN_INSTALLER
echo [SETUP] First-time setup or missing packages detected.
echo Launching automated installer (install.bat)...
echo.
call "%~dp0install.bat"
if exist "%~dp0.venv\Scripts\python.exe" (
    set APP_PYTHON="%~dp0.venv\Scripts\python.exe"
    goto :LAUNCH_SERVER
)
exit /b 1

REM ----------------------------------------------------------------------
REM 3. Launch Standalone Desktop Application
REM ----------------------------------------------------------------------
:LAUNCH_SERVER
echo.
echo ======================================================================
echo Starting Multi-Speaker Review Interface [Standalone Desktop]
echo ======================================================================
echo.

%APP_PYTHON% desktop.py %*

if errorlevel 1 (
    echo.
    echo [ERROR] The application exited with code %ERRORLEVEL%.
    pause
)
