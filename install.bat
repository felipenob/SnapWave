@echo off
setlocal
chcp 65001 >nul
set PYTHONIOENCODING=utf-8
set PYTHONUTF8=1
title Setup & Install Dependencies - SnapWave
echo ======================================================================
echo    SnapWave - Automated Environment Setup
echo ======================================================================
echo.
cd /d "%~dp0"

REM ----------------------------------------------------------------------
REM 1. Locate Compatible Python (Python 3.11 is optimal; 3.10/3.12 also OK)
REM    Newer versions like 3.13/3.14/3.15 often lack prebuilt PyTorch wheels.
REM ----------------------------------------------------------------------
set SYS_PYTHON=

py -3.11 -c "import sys" >nul 2>&1
if not errorlevel 1 (
    set SYS_PYTHON=py -3.11
    goto :FOUND_PYTHON
)

if exist "%LocalAppData%\Programs\Python\Python311\python.exe" (
    set SYS_PYTHON="%LocalAppData%\Programs\Python\Python311\python.exe"
    goto :FOUND_PYTHON
)

if exist "C:\Python311\python.exe" (
    set SYS_PYTHON="C:\Python311\python.exe"
    goto :FOUND_PYTHON
)

py -3.12 -c "import sys" >nul 2>&1
if not errorlevel 1 (
    set SYS_PYTHON=py -3.12
    goto :FOUND_PYTHON
)

py -3.10 -c "import sys" >nul 2>&1
if not errorlevel 1 (
    set SYS_PYTHON=py -3.10
    goto :FOUND_PYTHON
)

if exist "C:\ProgramData\Anaconda3\python.exe" (
    set SYS_PYTHON="C:\ProgramData\Anaconda3\python.exe"
    goto :FOUND_PYTHON
)

where python >nul 2>&1
if not errorlevel 1 (
    python -c "import sys; sys.exit(0 if (3, 10) <= sys.version_info[:2] <= (3, 12) else 1)" >nul 2>&1
    if not errorlevel 1 (
        set SYS_PYTHON=python
        goto :FOUND_PYTHON
    )
)

echo [NOTICE] Compatible Python (3.10, 3.11, or 3.12) was not detected.
echo Note: Python 3.11 is strongly recommended because newer Python versions
echo (3.13+) do not yet support all prebuilt audio/AI packages (PyTorch/NeMo).
echo.
set /p AUTO_PY="Would you like to automatically install Python 3.11 now via Windows winget? (Y/N, default Y): "
if /i "%AUTO_PY%"=="N" goto :MANUAL_PYTHON_MSG

echo.
echo Installing Python 3.11 via winget...
winget install -e --id Python.Python.3.11 --accept-package-agreements --accept-source-agreements
if exist "%LocalAppData%\Programs\Python\Python311\python.exe" (
    set SYS_PYTHON="%LocalAppData%\Programs\Python\Python311\python.exe"
    goto :FOUND_PYTHON
)
py -3.11 -c "import sys" >nul 2>&1
if not errorlevel 1 (
    set SYS_PYTHON=py -3.11
    goto :FOUND_PYTHON
)

:MANUAL_PYTHON_MSG
echo.
echo [ERROR] Please install Python 3.11 (64-bit) from:
echo    https://www.python.org/downloads/release/python-3119/
echo Make sure to check "[x] Add python.exe to PATH" during installation,
echo then run install.bat again.
pause
exit /b 1

:FOUND_PYTHON
echo [OK] Compatible Python detected:
%SYS_PYTHON% --version
echo.

set VENV_DIR=%~dp0.venv
set VENV_PYTHON=%VENV_DIR%\Scripts\python.exe
set VENV_PIP=%VENV_DIR%\Scripts\pip.exe

if exist "%VENV_PYTHON%" (
    set /p RECREATE="Existing .venv detected. Recreate clean environment? (y/N): "
    if /i "%RECREATE%"=="Y" (
        echo Removing old .venv...
        rmdir /s /q "%VENV_DIR%"
    )
)

if not exist "%VENV_PYTHON%" (
    echo Creating isolated virtual environment in .venv ...
    %SYS_PYTHON% -m venv "%VENV_DIR%"
    if errorlevel 1 (
        echo [ERROR] Failed to create virtual environment.
        pause
        exit /b 1
    )
)

echo Upgrading pip, wheel, and setuptools...
"%VENV_PYTHON%" -m pip install --upgrade pip wheel setuptools

echo.
echo ======================================================================
echo Choose installation profile for this PC:
echo   [1] Standard CPU Mode           (Works on any PC or laptop)
echo   [2] NVIDIA GPU Mode (CUDA 12.4) (Whisper + Parakeet CTC on RTX GPU)
echo   [3] NVIDIA GPU + NeMo Toolkit   (Adds Parakeet TDT support via NeMo)
echo ======================================================================
echo.
set "MODE=1"
set /p "MODE=Enter 1, 2, or 3 [Default is 1]: "

if "%MODE%"=="2" goto :INSTALL_GPU
if "%MODE%"=="3" goto :INSTALL_NEMO
goto :INSTALL_CPU

:INSTALL_GPU
echo.
echo [1/2] Installing PyTorch with CUDA 12.4 support for NVIDIA GPU...
"%VENV_PIP%" install torch torchaudio --index-url https://download.pytorch.org/whl/cu124
echo.
echo [2/2] Installing application requirements (scipy, pillow, transformers, pywebview)...
"%VENV_PIP%" install -r requirements.txt
goto :DONE

:INSTALL_NEMO
echo.
echo [1/3] Installing PyTorch with CUDA 12.4 support for NVIDIA GPU...
"%VENV_PIP%" install torch torchaudio --index-url https://download.pytorch.org/whl/cu124
echo.
echo [2/3] Installing application requirements...
"%VENV_PIP%" install -r requirements.txt
echo.
echo [3/3] Installing NVIDIA NeMo ASR Toolkit (for Parakeet TDT)...
"%VENV_PIP%" install Cython packaging
"%VENV_PIP%" install "nemo_toolkit[asr]"
goto :DONE

:INSTALL_CPU
echo.
echo Installing standard CPU requirements in virtual environment...
"%VENV_PIP%" install -r requirements.txt
goto :DONE

:DONE
echo.
echo ======================================================================
echo [SUCCESS] Installation finished!
echo You can now launch the application anytime by double-clicking run.bat
echo ======================================================================
pause
