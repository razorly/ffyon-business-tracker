; Reuse the existing NSIS installation when its display name changes.
; These keys are overridable solely for the disposable installer fixture.
!ifndef FFYON_LEGACY_UNINSTALL_KEY
  !define FFYON_LEGACY_UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\Ffyon Business Tracker"
!endif
!ifndef FFYON_LEGACY_INSTALL_KEY
  !define FFYON_LEGACY_INSTALL_KEY "Software\ffyon\Ffyon Business Tracker"
!endif

Var LegacyFfyonInstallDir

!macro NSIS_HOOK_PREINSTALL
  StrCpy $LegacyFfyonInstallDir ""
  ReadRegStr $R9 SHCTX "${UNINSTKEY}" "UninstallString"
  ${If} $R9 == ""
    ReadRegStr $R8 SHCTX "${FFYON_LEGACY_UNINSTALL_KEY}" "MainBinaryName"
    ${If} $R8 == "${MAINBINARYNAME}.exe"
      ReadRegStr $R9 SHCTX "${FFYON_LEGACY_INSTALL_KEY}" ""
      ${If} $R9 != ""
      ${AndIf} ${FileExists} "$R9\${MAINBINARYNAME}.exe"
        StrCpy $LegacyFfyonInstallDir $R9
        StrCpy $INSTDIR $R9
        ; The standard installer sets the output directory before this hook.
        SetOutPath $INSTDIR
      ${EndIf}
    ${EndIf}
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ${If} $LegacyFfyonInstallDir != ""
  ${AndIf} $LegacyFfyonInstallDir == $INSTDIR
    ; The new entry and uninstaller now exist, so retire only this old identity.
    DeleteRegKey SHCTX "${FFYON_LEGACY_UNINSTALL_KEY}"
    DeleteRegKey SHCTX "${FFYON_LEGACY_INSTALL_KEY}"
    !insertmacro IsShortcutTarget "$SMPROGRAMS\Ffyon Business Tracker.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    Pop $R9
    ${If} $R9 == 1
      Delete "$SMPROGRAMS\Ffyon Business Tracker.lnk"
    ${EndIf}
    !insertmacro IsShortcutTarget "$DESKTOP\Ffyon Business Tracker.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    Pop $R9
    ${If} $R9 == 1
      Delete "$DESKTOP\Ffyon Business Tracker.lnk"
    ${EndIf}
  ${EndIf}
!macroend
