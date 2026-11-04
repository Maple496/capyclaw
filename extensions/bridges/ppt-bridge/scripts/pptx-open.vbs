Option Explicit
' DSH PPT "Open with" launcher: hide the console and pass the first argument to pptx-open.mjs.
Dim fso, shell, here, script, nodeExe, file
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

If WScript.Arguments.Count = 0 Then
  MsgBox "Drop a .pptx file onto this launcher, or choose DSH PPT from the Open with menu.", 48, "DSH PPT"
  WScript.Quit 1
End If

here = fso.GetParentFolderName(WScript.ScriptFullName)
script = here & "\pptx-open.mjs"
file = WScript.Arguments(0)

nodeExe = shell.ExpandEnvironmentStrings("%ProgramFiles%\nodejs\node.exe")
If Not fso.FileExists(nodeExe) Then nodeExe = "node"

shell.Run """" & nodeExe & """ """ & script & """ --file """ & file & """", 0, False
