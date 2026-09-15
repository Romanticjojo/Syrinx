!macro customInit
  ; 高 DPI 清晰化：electron-builder 默认模板未给 NSIS 壳设 DPI 感知，
  ; 高分屏上安装/卸载向导被位图拉伸导致发糊。SetDPIAware 在 init 阶段生效。
  System::Call 'user32::SetProcessDPIAware() i .r0'
!macroend

!macro customUnInit
  System::Call 'user32::SetProcessDPIAware() i .r0'
!macroend
