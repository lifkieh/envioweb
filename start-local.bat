@echo off
rem Jalankan website + CMS di komputer sendiri. Biarkan jendela ini terbuka selama dipakai.
rem Tutup jendela (atau tekan Ctrl+C) untuk menghentikan server.
cd /d "%~dp0"
echo Membuka http://localhost:3100 ...
start "" http://localhost:3100
node server.js
echo.
echo Server berhenti. Lihat pesan error di atas.
pause
