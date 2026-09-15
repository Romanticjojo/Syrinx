#!/usr/bin/env node
/**
 * 幂等修补 electron-builder 的 NSIS 模板（Syrinx 安装器定制）。
 * `npm run dist` 前自动执行；node_modules 重装后重跑即可（幂等）。
 *
 * 修补点：
 * 1. instFilesPre：StrContains 宽匹配 → 末段精确匹配（目录 sanitize）。
 * 2. x64/ia32/arm64 拷包宏：.onInit 预拷贝后 Section 里跳过。
 * 3. 移除孤立 StrContains include（warning 6010）。
 * 4. 进度条折返根治（终极方案 = marquee 跑马灯）：
 *    实测：7z 插件解压把进度条推到 ~45% → NSIS 核心对剩余指令
 *    （CopyFiles/注册表/快捷方式）重设进度范围并从 0 重算 → 视觉折返。
 *    SetDetailsPrint 只静默文本不挡进度；PBM 锁范围也会被核心覆盖。
 *    唯一稳妥解：安装开始时把进度条切到 PBM_SETMARQUEE 连续流动模式
 *    （marquee 完全忽略 SETPOS/SETRANGE，任何阶段都无折返可能），
 *    解压完成后保持 marquee 直到 Section 结束——全程匀速流动动画。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { resolve, join } = require('node:path')

const tplDir = resolve(process.cwd(), 'node_modules/app-builder-lib/templates/nsis')

function patch(rel, marker, from, to, name, soft = false) {
  const p = join(tplDir, rel)
  if (!existsSync(p)) throw new Error(`template not found: ${p}`)
  let t = readFileSync(p, 'utf8')
  if (t.includes(marker)) {
    console.log(`  = ${name}: 已是补丁态，跳过`)
    return
  }
  if (!t.includes(from)) {
    if (soft) { console.log(`  = ${name}: 目标已不在（视为已打）`); return }
    throw new Error(`${name}: 待替换片段未找到（模板版本变了？）\n---\n${from}\n---`)
  }
  t = t.replace(from, to)
  writeFileSync(p, t)
  console.log(`  ✓ ${name}`)
}

// ---- 1. instFilesPre：末段精确匹配 ----
patch(
  'assistedInstaller.nsh',
  'SYRINX-PATCH-1',
  `Function instFilesPre
      \${StrContains} \$0 "\${APP_FILENAME}" \$INSTDIR
      \${If} \$0 == ""
        StrCpy \$INSTDIR "\$INSTDIR\\\${APP_FILENAME}"
      \${endIf}
    FunctionEnd`,
  `Function instFilesPre ; SYRINX-PATCH-1 exact last-segment match
      Push \$R9
      \${GetFileName} "\$INSTDIR" \$R9
      \${If} \$R9 != "\${APP_FILENAME}"
        StrCpy \$INSTDIR "\$INSTDIR\\\${APP_FILENAME}"
      \${endIf}
      Pop \$R9
    FunctionEnd`,
  'instFilesPre 末段精确匹配（自动追加 Syrinx 子文件夹）',
)

// ---- 2. 拷包宏：预拷后跳过 ----
for (const [macro, arch, def] of [['x64_app_files', '64', '64'], ['ia32_app_files', '32', '32'], ['arm64_app_files', 'arm64', 'ARM64']]) {
  patch(
    'include/extractAppPackage.nsh',
    `SYRINX-PATCH-2-${arch}`,
    `!macro ${macro}
  File /oname=\$PLUGINSDIR\\app-${arch}.\${COMPRESSION_METHOD} "\${APP_${def}}"
!macroend`,
    `!macro ${macro} ; SYRINX-PATCH-2-${arch} skip when pre-copied in .onInit
  \${ifNot} \${FileExists} "\$PLUGINSDIR\\app-${arch}.\${COMPRESSION_METHOD}"
    File /oname=\$PLUGINSDIR\\app-${arch}.\${COMPRESSION_METHOD} "\${APP_${def}}"
  \${endIf}
!macroend`,
    `${macro} 拷包跳过`,
  )
}

// ---- 3. 移除孤立 StrContains include ----
patch(
  'assistedInstaller.nsh',
  'SYRINX-PATCH-3',
  `!ifdef allowToChangeInstallationDirectory
    !include StrContains.nsh
`,
  `!ifdef allowToChangeInstallationDirectory
`,
  '移除 StrContains include（避免 warning 6010）',
  true,
)

// ---- 4. marquee 进度条（根治折返） ----
// 4a. extractUsing7za 开头：解压前切入 marquee
patch(
  'include/extractAppPackage.nsh',
  'SYRINX-PATCH-4a',
  `!macro extractUsing7za FILE
  Push \$OUTDIR
  CreateDirectory "\$PLUGINSDIR\\7z-out"
  ClearErrors`,
  `!macro syrinxMarqueeOn ; SYRINX-PATCH-4a continuous progress (no rewind)
  Push \$R9
  GetDlgItem \$R9 \$HWNDPARENT 1004
  \${If} \$R9 != 0
    SendMessage \$R9 0x409 1 12 \; PBM_SETMARQUEE on, 12ms step
  \${EndIf}
  Pop \$R9
!macroend

!macro syrinxMarqueeOff ; restore a full bar before the finish page
  Push \$R9
  GetDlgItem \$R9 \$HWNDPARENT 1004
  \${If} \$R9 != 0
    SendMessage \$R9 0x409 0 0 \; marquee off
    SendMessage \$R9 0x406 0 0 \; PBM_SETRANGE32 0..0
    SendMessage \$R9 0x402 0 0 \; PBM_SETPOS 0 → full under 0..0
  \${EndIf}
  Pop \$R9
!macroend

!macro extractUsing7za FILE
  !insertmacro syrinxMarqueeOn
  Push \$OUTDIR
  CreateDirectory "\$PLUGINSDIR\\7z-out"
  ClearErrors`,
  'marquee 宏注入（解压切入跑马灯）',
)

// 4c. CopyFiles 段：仍静默（文本层面干净）
patch(
  'include/extractAppPackage.nsh',
  'SYRINX-PATCH-4c',
  `  LoopExtract7za:
    IntOp \$R1 \$R1 + 1

    # Attempt to copy files in atomic way
    CopyFiles /SILENT "\$PLUGINSDIR\\7z-out\\*" \$OUTDIR`,
  `  LoopExtract7za: ; SYRINX-PATCH-4c
    IntOp \$R1 \$R1 + 1

    # Attempt to copy files in atomic way
    SetDetailsPrint none
    CopyFiles /SILENT "\$PLUGINSDIR\\7z-out\\*" \$OUTDIR
    SetDetailsPrint lastused`,
  'CopyFiles 静默',
)

// 4d. installSection：开头 marquee on；结尾（doStartApp 前）marquee off + 满条
patch(
  'installSection.nsh',
  'SYRINX-PATCH-4d',
  `SetOutPath \$INSTDIR`,
  `SetOutPath \$INSTDIR
; SYRINX-PATCH-4d marquee for the whole section: NSIS core recomputes the
; progress bar per remaining instruction after 7z extraction, which visibly
; rewinds it. Marquee mode ignores SETPOS/SETRANGE entirely → no rewind.
!ifdef SYRINX_MARQUEE
  !insertmacro syrinxMarqueeOn
!endif`,
  '安装段全程 marquee',
)

// 4e. Section 末尾：完成页前恢复满条
patch(
  'installSection.nsh',
  'SYRINX-PATCH-4e',
  `!macro doStartApp`,
  `!macro syrinxFinishProgress ; SYRINX-PATCH-4e full bar on the finish page
!ifdef SYRINX_MARQUEE
  !insertmacro syrinxMarqueeOff
!endif
!macroend

!macro doStartApp`,
  '完成页前恢复满条',
)

console.log('NSIS 模板修补完成')
