' Coworker tray: silent launcher. Runs the tray script without any console window.
' Double-click this file, or point a shortcut / the Startup folder at wscript.exe with it.
Dim fso, shell, base, command
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
base = fso.GetParentFolderName(WScript.ScriptFullName)
command = "powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & base & "\coworker-tray.ps1"""
' 0 = hidden window, False = do not wait
shell.Run command, 0, False
