@echo off
REM Build a single-file exe: dist\MailManager.exe
cd /d %~dp0
.venv\Scripts\pyinstaller.exe --noconfirm --clean --onefile --windowed ^
  --name "MailManager" ^
  --add-data "web;web" ^
  main.py
