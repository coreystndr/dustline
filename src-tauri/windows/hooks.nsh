; Place Steam API redistributable next to the game executable.
; Windows resolves steam_api64.dll at process load time from $INSTDIR.

!macro NSIS_HOOK_PREINSTALL
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ; Tauri resources land in $INSTDIR\resources\
  IfFileExists "$INSTDIR\resources\steam_api64.dll" 0 try_nested
    CopyFiles /SILENT "$INSTDIR\resources\steam_api64.dll" "$INSTDIR\steam_api64.dll"
    Goto appid
  try_nested:
  IfFileExists "$INSTDIR\resources\_up_\steam_api64.dll" 0 appid
    CopyFiles /SILENT "$INSTDIR\resources\_up_\steam_api64.dll" "$INSTDIR\steam_api64.dll"
  appid:
  IfFileExists "$INSTDIR\resources\steam_appid.txt" 0 done
    CopyFiles /SILENT "$INSTDIR\resources\steam_appid.txt" "$INSTDIR\steam_appid.txt"
  done:
!macroend

!macro NSIS_HOOK_PREUNINSTALL
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
!macroend
