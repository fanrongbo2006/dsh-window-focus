Option Explicit

' Protocol handler launcher.
' Windows starts this file through wscript.exe (a GUI-subsystem host), so no
' console window is created. It then runs the PowerShell worker with a hidden
' window so clicking a toast button never flashes a terminal.
Dim shell, fso, base, uri, ps
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

base = fso.GetParentFolderName(WScript.ScriptFullName)
uri = ""
If WScript.Arguments.Count > 0 Then
  uri = WScript.Arguments(0)
End If

' Defensive: drop embedded double quotes before splicing into a command line.
If InStr(uri, """") > 0 Then
  uri = Replace(uri, """", "")
End If

ps = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File " _
   & Chr(34) & base & "\toast-action.ps1" & Chr(34) & " " _
   & Chr(34) & uri & Chr(34)

shell.Run ps, 0, False
