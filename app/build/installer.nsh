; OBSAR NSIS additions (included by electron-builder via nsis.include).
; On uninstall, offer to delete the data and models folders created during first-run setup.
; The app writes their paths, one per line, to %APPDATA%\obsar\dirs.txt (line 1 data, line 2 models).

!macro customUnInstall
  Push $0
  Push $1
  Push $2

  StrCpy $1 ""
  StrCpy $2 ""
  IfFileExists "$APPDATA\obsar\dirs.txt" 0 obsar_done
  FileOpen $0 "$APPDATA\obsar\dirs.txt" r
  IfErrors obsar_done
  FileRead $0 $1
  FileRead $0 $2
  FileClose $0
  ; strip trailing CR/LF
  Push $1
  Call un.ObsarTrim
  Pop $1
  Push $2
  Call un.ObsarTrim
  Pop $2

  StrCmp $1 "" obsar_done
  MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 \
    "Also delete OBSAR's index, Python runtime and AI models?$\r$\n$\r$\n$1$\r$\n$2$\r$\n$\r$\nThis frees up to about 20 GB. Your photos and videos are never touched." \
    IDNO obsar_done
  RMDir /r "$1"
  StrCmp $2 "" +2
  RMDir /r "$2"
  Delete "$APPDATA\obsar\dirs.txt"

obsar_done:
  Pop $2
  Pop $1
  Pop $0
!macroend

Function un.ObsarTrim
  Exch $R0
  Push $R1
obsar_trim_loop:
  StrCpy $R1 $R0 1 -1
  StrCmp $R1 "$\r" obsar_trim_cut
  StrCmp $R1 "$\n" obsar_trim_cut
  StrCmp $R1 " " obsar_trim_cut
  Goto obsar_trim_end
obsar_trim_cut:
  StrCpy $R0 $R0 -1
  Goto obsar_trim_loop
obsar_trim_end:
  Pop $R1
  Exch $R0
FunctionEnd
