# Syrinx NSIS 定制（electron-builder build/installer.nsh 自动 include）
# 修复清单：
# 1. 高分屏发糊：给安装/卸载壳进程设 DPI 感知
# 2. 选目录自动追加 Syrinx 子文件夹：官方模板用 StrContains 宽匹配
#    （路径里任何位置含 "syrinx" 就不追加——D:\syrinx-test\foo 这类路径会被
#    误判），这里用「末段精确匹配」重写：只有当选中目录的最后一段不是
#    Syrinx 时才追加 \Syrinx，保证永远装进独立子文件夹
# 3. 卸载安全护栏：官方卸载是 RMDir /r $INSTDIR 整目录递归删除——若用户
#    曾手改目录或旧版装进了共用目录，会把目录里其他文件一起删掉。护栏
#    要求 $INSTDIR 末段 == Syrinx 且内含 Syrinx.exe，否则中止卸载

!include "FileFunc.nsh"

; 激活安装段 marquee 进度条（见 scripts/patch-nsis.mjs 注释）
!define SYRINX_MARQUEE

!macro customInit
  System::Call 'user32::SetProcessDPIAware() i .r0'

  # ---- 预拷贝压缩包（进度条只走一轮的根源修） ----
  # 官方流程：Section 里 File 拷 223MB 7z（进度条走满一轮）→ Nsis7z 解压
  # （从零再走一轮）。这里在 .onInit（欢迎页阶段，无进度条可见）先拷出来，
  # Section 里的拷包步骤检测到已存在会跳过——用户只看到解压这一轮进度。
  # File 需要编译期路径常量，与 x64_app_files 宏同款写法。
  InitPluginsDir
  SetOutPath "$PLUGINSDIR"
  !ifdef APP_64
    File /oname=$PLUGINSDIR\app-64.${COMPRESSION_METHOD} "${APP_64}"
  !endif
  !ifdef APP_32
    File /oname=$PLUGINSDIR\app-32.${COMPRESSION_METHOD} "${APP_32}"
  !endif
!macroend

# ---- 目录 sanitize 说明 ----
# 官方 instFilesPre 的 StrContains 宽匹配已由 scripts/patch-nsis.mjs 改为
# 「末段精确匹配」：选中目录最后一段不是应用目录名时自动追加 \Syrinx，
# 保证永远装进独立子文件夹（含 syrinx 字样的路径不再被误判）。

!macro customUnInit
  System::Call 'user32::SetProcessDPIAware() i .r0'
  # ---- 卸载安全护栏 ----
  ${GetFileName} "$INSTDIR" $0
  StrCmp $0 "Syrinx" +3 0
    MessageBox MB_OK|MB_ICONSTOP "卸载目录异常（$INSTDIR）。为安全起见，卸载程序不会删除这个目录的内容，请手动清理。"
    Abort
  IfFileExists "$INSTDIR\Syrinx.exe" +3 0
    MessageBox MB_OK|MB_ICONSTOP "目录 $INSTDIR 内没有 Syrinx.exe，疑似不是 Syrinx 的安装目录。为安全起见，卸载已中止。"
    Abort
!macroend
