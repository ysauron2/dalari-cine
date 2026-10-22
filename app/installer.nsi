; Instalador do Dalari Cine para Windows (NSIS), por usuário: não pede administrador.
; Uso: makensis /DSRC=<pasta dist-win\DalariCine> /DOUT=<instalador.exe> /DVERSION=<versão> installer.nsi
Unicode true
!include "MUI2.nsh"

!ifndef SRC
  !error "Defina /DSRC=<pasta do app montada por build-windows.ps1>"
!endif
!ifndef OUT
  !define OUT "DalariCine-Setup.exe"
!endif
!ifndef VERSION
  !define VERSION "0.0.0"
!endif
!ifdef ICON
  !define MUI_ICON "${ICON}"
  !define MUI_UNICON "${ICON}"
!endif

Name "Dalari Cine"
OutFile "${OUT}"
InstallDir "$LOCALAPPDATA\Programs\DalariCine"
InstallDirRegKey HKCU "Software\DalariCine" "InstallDir"
RequestExecutionLevel user
SetCompressor /SOLID lzma

!define MUI_ABORTWARNING
!define MUI_FINISHPAGE_RUN "$INSTDIR\DalariCine.exe"
!define MUI_FINISHPAGE_RUN_TEXT "Abrir o Dalari Cine"
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "PortugueseBR"

; Atualização automática: o app abre este instalador com /S e fecha em seguida. Em modo silencioso o instalador
; espera o DalariCine.exe ser liberado (até ~20 s) e, ao terminar, abre o app de novo.
Function .onInstSuccess
  IfSilent 0 +2
  Exec '"$INSTDIR\DalariCine.exe"'
FunctionEnd

Section "Instalar"
  IfFileExists "$INSTDIR\DalariCine.exe" 0 exeFree
  StrCpy $0 0
  waitExe:
    ClearErrors
    FileOpen $1 "$INSTDIR\DalariCine.exe" a
    IfErrors 0 closeExe
    IntOp $0 $0 + 1
    IntCmp $0 40 exeFree 0 exeFree
    Sleep 500
    Goto waitExe
  closeExe:
    FileClose $1
  exeFree:
  SetOutPath "$INSTDIR"
  File /r "${SRC}\*.*"
  WriteUninstaller "$INSTDIR\Desinstalar.exe"
  CreateDirectory "$SMPROGRAMS\DalariCine"
  CreateShortcut "$SMPROGRAMS\DalariCine\Dalari Cine.lnk" "$INSTDIR\DalariCine.exe" "" "$INSTDIR\resources\app\assets\icon.ico"
  CreateShortcut "$DESKTOP\Dalari Cine.lnk" "$INSTDIR\DalariCine.exe" "" "$INSTDIR\resources\app\assets\icon.ico"
  WriteRegStr HKCU "Software\DalariCine" "InstallDir" "$INSTDIR"
  ; Convite com um toque: links dalari://entrar/XXXX-XXXX abrem o Dalari Cine (só neste usuário)
  WriteRegStr HKCU "Software\Classes\dalari" "" "URL:Dalari Cine"
  WriteRegStr HKCU "Software\Classes\dalari" "URL Protocol" ""
  WriteRegStr HKCU "Software\Classes\dalari\DefaultIcon" "" "$INSTDIR\DalariCine.exe,0"
  WriteRegStr HKCU "Software\Classes\dalari\shell\open\command" "" '"$INSTDIR\DalariCine.exe" "%1"'
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\DalariCine" "DisplayName" "Dalari Cine"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\DalariCine" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\DalariCine" "UninstallString" '"$INSTDIR\Desinstalar.exe"'
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\DalariCine" "DisplayIcon" "$INSTDIR\resources\app\assets\icon.ico"
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\DalariCine" "NoModify" 1
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\DalariCine" "NoRepair" 1
SectionEnd

; O perfil (sessão Netflix) fica em %APPDATA%\Dalari Cine e NÃO é apagado ao desinstalar.
Section "Uninstall"
  Delete "$DESKTOP\Dalari Cine.lnk"
  Delete "$SMPROGRAMS\DalariCine\Dalari Cine.lnk"
  RMDir "$SMPROGRAMS\DalariCine"
  RMDir /r "$INSTDIR"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\DalariCine"
  DeleteRegKey HKCU "Software\DalariCine"
  DeleteRegKey HKCU "Software\Classes\dalari"
SectionEnd
