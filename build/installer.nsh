!macro customUnInstall
  DetailPrint "Wiping all Remote Care Monitor passwords, databases, and local credentials..."
  RMDir /r "$APPDATA\Remote Care Monitor"
  RMDir /r "$LOCALAPPDATA\Remote Care Monitor"
  RMDir /r "$LOCALAPPDATA\remote-care-monitor-updater"
  RMDir /r "$APPDATA\remote-care-monitor"
  RMDir /r "$PROFILE\.remote-care"
  DeleteRegKey HKCU "Software\in.archidtech.remotecare"
  DeleteRegKey HKCU "Software\Remote Care Monitor"
  DeleteRegKey HKLM "Software\in.archidtech.remotecare"
!macroend
