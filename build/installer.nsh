; Nyx installer look: dark pages in the colours of the app.
; (electron-builder includes this file before the NSIS template, so the MUI
; colour defines below apply to every page that follows.)

!define MUI_BGCOLOR "0B0E14"
!define MUI_TEXTCOLOR "F1F5F9"

!define MUI_WELCOMEPAGE_TITLE "Добро пожаловать в Nyx"
!define MUI_WELCOMEPAGE_TEXT "Nyx - быстрый и безопасный VPN-клиент для Windows.$\r$\n$\r$\nМастер установит приложение на ваш компьютер. Права администратора не требуются.$\r$\n$\r$\nНажмите «Далее», чтобы продолжить."
!define MUI_FINISHPAGE_TITLE "Nyx установлен"
!define MUI_FINISHPAGE_TEXT "Приложение готово к работе.$\r$\n$\r$\nДобавьте профиль или ссылку на подписку и нажмите кнопку включения."
!define MUI_FINISHPAGE_RUN_TEXT "Запустить Nyx"

!macro customHeader
!ifndef BUILD_UNINSTALLER
; ---- colouring helpers -------------------------------------------------

; Paint the window chrome (button bar, branding line) dark.
Function nyxPaintParent
  SetCtlColors $HWNDPARENT "F1F5F9" "0B0E14"
  GetDlgItem $0 $HWNDPARENT 1256
  SetCtlColors $0 "64748B" "0B0E14"
FunctionEnd

; Paint the inner page and every control on it.
Function nyxPaintPage
  Call nyxPaintParent
  FindWindow $R0 "#32770" "" $HWNDPARENT
  SetCtlColors $R0 "F1F5F9" "0B0E14"
  System::Call 'user32::GetWindow(p $R0, i 5) p .R1'
  ${While} $R1 <> 0
    SetCtlColors $R1 "F1F5F9" "0B0E14"
    System::Call 'user32::GetWindow(p $R1, i 2) p .R1'
  ${EndWhile}
FunctionEnd

Function nyxFinishShow
  Call nyxPaintParent
  ; the themed checkbox ignores text colours; the classic one does not
  System::Call 'uxtheme::SetWindowTheme(p $mui.FinishPage.Run, w "", w "")'
  SetCtlColors $mui.FinishPage.Run "F1F5F9" "0B0E14"
FunctionEnd

Function nyxDirShow
  Call nyxPaintPage
  ; the path box a little lighter than the page
  GetDlgItem $0 $R0 1019
  SetCtlColors $0 "F1F5F9" "141923"
FunctionEnd

Function nyxInstFilesShow
  Call nyxPaintPage
  ; progress bar: emerald on a dark track (needs the classic look to take colours)
  GetDlgItem $0 $R0 1004
  System::Call 'uxtheme::SetWindowTheme(p $0, w "", w "")'
  SendMessage $0 0x2001 0 0x1B0E0B
  SendMessage $0 0x409 0 0x81B910
  ; the details list
  GetDlgItem $0 $R0 1016
  SetCtlColors $0 "94A3B8" "0B0E14"
FunctionEnd
!endif
!macroend

; ---- page hooks --------------------------------------------------------

!macro customWelcomePage
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW nyxPaintParent
  !insertmacro MUI_PAGE_WELCOME

  ; The directory page is inserted here, by us, instead of by the template
  ; (allowToChangeInstallationDirectory is off) so that it can be painted.
  !include StrContains.nsh
  Function nyxDirPre
    ${if} ${isUpdated}
      Abort
    ${endif}
  FunctionEnd
  !define MUI_PAGE_CUSTOMFUNCTION_PRE nyxDirPre
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW nyxDirShow
  !insertmacro MUI_PAGE_DIRECTORY

  ; make sure the chosen folder ends with the application name
  Function nyxInstFilesPre
    ${StrContains} $0 "${APP_FILENAME}" $INSTDIR
    ${If} $0 == ""
      StrCpy $INSTDIR "$INSTDIR\${APP_FILENAME}"
    ${endIf}
  FunctionEnd
!macroend

!macro customPageAfterChangeDir
  ; applies to the install-progress page that follows
  !define MUI_PAGE_CUSTOMFUNCTION_PRE nyxInstFilesPre
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW nyxInstFilesShow
!macroend

!macro customFinishPage
  Function StartApp
    ${if} ${isUpdated}
      StrCpy $1 "--updated"
    ${else}
      StrCpy $1 ""
    ${endif}
    ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "$1"
  FunctionEnd

  !define MUI_FINISHPAGE_RUN
  !define MUI_FINISHPAGE_RUN_FUNCTION "StartApp"
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW nyxFinishShow
  !insertmacro MUI_PAGE_FINISH
!macroend

; Nyx is always installed for the current user (no admin rights needed), so skip
; the "for all users / only for me" page.
!macro customInstallMode
  StrCpy $isForceCurrentInstall "1"
!macroend
