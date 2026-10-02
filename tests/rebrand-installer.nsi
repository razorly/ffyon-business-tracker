; Run with makensis /DFIXTURE_ID=<fresh UUID> /DOUTFILE=<test-results path>.
; All registry writes and dummy files stay in a disposable fixture namespace.
Unicode true
!include LogicLib.nsh
!ifndef FIXTURE_ID
  !error "A fresh FIXTURE_ID is required"
!endif
!ifndef OUTFILE
  !error "A test-results OUTFILE is required"
!endif
!define FIXTURE_KEY "Software\TannedByFfyInstallerFixture\${FIXTURE_ID}"
!define FFYON_LEGACY_UNINSTALL_KEY "${FIXTURE_KEY}\old-uninstall"
!define FFYON_LEGACY_INSTALL_KEY "${FIXTURE_KEY}\old-install"
!define UNINSTKEY "${FIXTURE_KEY}\new-uninstall"
!define MAINBINARYNAME "fixture-app"
; Shortcut ownership is handled by Tauri's helper in the real installer.
; This fixture must never inspect or change real Desktop/Start Menu shortcuts.
!macro IsShortcutTarget shortcut target
  Push 0
!macroend
!include "..\src-tauri\installer\rebrand-hooks.nsh"

Name "Disposable rebrand installer fixture"
OutFile "${OUTFILE}"
RequestExecutionLevel user
SilentInstall silent
AutoCloseWindow true

!macro AssertEqual actual expected message
  ${If} "${actual}" != "${expected}"
    FileOpen $0 "$EXEDIR\evidence.txt" w
    FileWrite $0 "FAIL: ${message}"
    FileClose $0
    DeleteRegKey HKCU "${FIXTURE_KEY}"
    SetErrorLevel 1
    Quit
  ${EndIf}
!macroend

Section
  SetRegView 64
  SetShellVarContext current

  ; A fresh install must retain the chosen destination.
  StrCpy $INSTDIR "$EXEDIR\fresh"
  SetOutPath $INSTDIR
  !insertmacro NSIS_HOOK_PREINSTALL
  !insertmacro AssertEqual $INSTDIR "$EXEDIR\fresh" "fresh installation destination"
  !insertmacro AssertEqual $LegacyFfyonInstallDir "" "fresh installation migration flag"

  ; An installed legacy NSIS app must be replaced in its original directory.
  CreateDirectory "$EXEDIR\legacy"
  FileOpen $0 "$EXEDIR\legacy\fixture-app.exe" w
  FileWrite $0 "dummy executable"
  FileClose $0
  FileOpen $0 "$EXEDIR\legacy\records.db" w
  FileWrite $0 "saved business records"
  FileClose $0
  WriteRegStr HKCU "${FFYON_LEGACY_INSTALL_KEY}" "" "$EXEDIR\legacy"
  WriteRegStr HKCU "${FFYON_LEGACY_UNINSTALL_KEY}" "MainBinaryName" "fixture-app.exe"
  !insertmacro NSIS_HOOK_PREINSTALL
  !insertmacro AssertEqual $INSTDIR "$EXEDIR\legacy" "legacy installation directory"
  !insertmacro AssertEqual $OUTDIR "$EXEDIR\legacy" "actual executable output directory"
  ; Simulate the standard installer writing the replacement's identity.
  WriteRegStr HKCU "${UNINSTKEY}" "UninstallString" "fixture uninstall"
  !insertmacro NSIS_HOOK_POSTINSTALL
  ReadRegStr $R0 HKCU "${FFYON_LEGACY_UNINSTALL_KEY}" "MainBinaryName"
  !insertmacro AssertEqual $R0 "" "retire old uninstall identity"
  ReadRegStr $R0 HKCU "${FFYON_LEGACY_INSTALL_KEY}" ""
  !insertmacro AssertEqual $R0 "" "retire old installation identity"
  ReadRegStr $R0 HKCU "${UNINSTKEY}" "UninstallString"
  !insertmacro AssertEqual $R0 "fixture uninstall" "keep new uninstall identity"
  FileOpen $0 "$EXEDIR\legacy\records.db" r
  FileRead $0 $R0
  FileClose $0
  !insertmacro AssertEqual $R0 "saved business records" "preserve business records"

  ; Later upgrades must not migrate a stale legacy entry over the current app.
  WriteRegStr HKCU "${FFYON_LEGACY_INSTALL_KEY}" "" "$EXEDIR\legacy"
  WriteRegStr HKCU "${FFYON_LEGACY_UNINSTALL_KEY}" "MainBinaryName" "fixture-app.exe"
  StrCpy $INSTDIR "$EXEDIR\current"
  SetOutPath $INSTDIR
  !insertmacro NSIS_HOOK_PREINSTALL
  !insertmacro NSIS_HOOK_POSTINSTALL
  !insertmacro AssertEqual $INSTDIR "$EXEDIR\current" "preserve existing current installation"
  ReadRegStr $R0 HKCU "${FFYON_LEGACY_UNINSTALL_KEY}" "MainBinaryName"
  !insertmacro AssertEqual $R0 "fixture-app.exe" "leave unrelated stale legacy entry alone"

  ; A key naming another executable must never be migrated or removed.
  DeleteRegKey HKCU "${UNINSTKEY}"
  WriteRegStr HKCU "${FFYON_LEGACY_UNINSTALL_KEY}" "MainBinaryName" "unrelated.exe"
  !insertmacro NSIS_HOOK_PREINSTALL
  !insertmacro NSIS_HOOK_POSTINSTALL
  !insertmacro AssertEqual $INSTDIR "$EXEDIR\current" "reject unrelated executable identity"
  ReadRegStr $R0 HKCU "${FFYON_LEGACY_UNINSTALL_KEY}" "MainBinaryName"
  !insertmacro AssertEqual $R0 "unrelated.exe" "preserve unrelated uninstall entry"

  DeleteRegKey HKCU "${FIXTURE_KEY}"
  FileOpen $0 "$EXEDIR\evidence.txt" w
  FileWrite $0 "PASS: fresh install, legacy migration, actual output path, records retained, later upgrade and unrelated identity."
  FileClose $0
  SetErrorLevel 0
SectionEnd
