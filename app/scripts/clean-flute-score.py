# -*- coding: utf-8 -*-
"""clean-flute-score.py — Luv Letter 长笛谱单声部清洗（任务 t_a857b79e Bug 1）

OMR 把钢琴低声部识别成了多声部（voice 2/3 + 68 处 <backup>），长笛谱必须
单音单声部。本脚本可重跑（幂等）：

  1. 原始未清洗谱保留在 omr-work/luv-letter-pre-clean.musicxml（首次运行时自动备份），
     之后每次都从它读入，重复运行结果一致；
  2. 清洗规则：
     - 删除 voice != 1 的全部 <note>，删除配套 <backup>/<forward>；
     - 同一位置的多音（<chord/> 组）只保留最高音，摘掉 <chord/> 标记；
     - 小节超拍（OMR 噪声，如 m51 多出 1 个十六分音符）从尾部截齐到拍数；
     - 摘除 <repeat> 反复记号：经与伴奏对齐验证，伴奏是线性贯穿版
       （线性 62 小节 = 269.3s ≈ 伴奏 270.4s；按谱面 repeat 展开反而得 308s），
       光标线性走谱即与伴奏对齐，保留反复记号只会让演奏者误读；
  3. 输出同步写两处：app/public/songs/luv-letter/score.musicxml 与
     resources/luv-letter/score/omr-work/luv-letter-final.musicxml；
  4. 打印清洗统计 + 逐小节旋律抽查（相邻音程 > 八度标记出来供人工复核）。

用法：python app/scripts/clean-flute-score.py
"""
from __future__ import annotations

import copy
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
PUBLIC_XML = REPO / "app" / "public" / "songs" / "luv-letter" / "score.musicxml"
OMR_DIR = REPO / "resources" / "luv-letter" / "score" / "omr-work"
RAW_XML = OMR_DIR / "luv-letter-pre-clean.musicxml"   # 只读：清洗前原谱
FINAL_XML = OMR_DIR / "luv-letter-final.musicxml"     # 最终产物（与 app 内同步）

STEP_SEMITONE = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}


def midi_of(note: ET.Element) -> int | None:
    pitch = note.find("pitch")
    if pitch is None:
        return None
    step = pitch.findtext("step") or "C"
    alter = int(pitch.findtext("alter") or 0)
    octave = int(pitch.findtext("octave") or 4)
    return (octave + 1) * 12 + STEP_SEMITONE[step] + alter


def name_of(note: ET.Element) -> str:
    if note.find("rest") is not None:
        return "rest"
    pitch = note.find("pitch")
    if pitch is None:
        return "?"
    alter = pitch.findtext("alter")
    suffix = {"1": "#", "-1": "b"}.get(alter, "")
    return f"{pitch.findtext('step')}{suffix}{pitch.findtext('octave')}"


def clean_measure(measure: ET.Element, stats: dict) -> None:
    # 拍数基准：优先读本小节 time，缺省 4/4 × divisions
    divisions = int(measure.findtext("./attributes/divisions") or 4)
    beats_el = measure.find("./attributes/time/beats")
    expected = int(beats_el.text) * divisions if beats_el is not None else 4 * divisions

    # 1) 丢掉非 voice 1 的音，删除 backup/forward
    for el in list(measure):
        if el.tag in ("backup", "forward"):
            measure.remove(el)
            stats["backup"] += 1
        elif el.tag == "note" and el.findtext("voice") not in (None, "1"):
            measure.remove(el)
            stats["voice2"] += 1

    # 2) 和弦组（连续的 <chord/> 跟随前面的音）只留最高音
    notes = [el for el in measure if el.tag == "note"]
    i = 0
    while i < len(notes):
        group = [notes[i]]
        j = i + 1
        while j < len(notes) and notes[j].find("chord") is not None:
            group.append(notes[j])
            j += 1
        if len(group) > 1:
            pitched = [n for n in group if midi_of(n) is not None]
            if pitched:
                keep = max(pitched, key=midi_of)
            else:
                keep = group[0]
            for n in group:
                if n is not keep:
                    measure.remove(n)
                    stats["chord"] += 1
                elif n.find("chord") is not None:
                    n.remove(n.find("chord"))  # 保留音摘掉和弦标记
        i = j

    # 3) 超拍截齐：从尾部往前减时值（m51 多 1 个十六分音符这类 OMR 噪声）
    total = sum(
        int(n.findtext("duration") or 0)
        for n in measure.findall("note")
        if n.find("chord") is None
    )
    while total > expected:
        lasts = [n for n in measure.findall("note") if n.find("chord") is None]
        last = lasts[-1]
        dur_el = last.find("duration")
        over = total - expected
        dur = int(dur_el.text)
        if dur > over:
            dur_el.text = str(dur - over)
            total = expected
            stats["trim"] += 1
        else:
            measure.remove(last)
            total -= dur
            stats["trim"] += 1

    # 4) 摘除反复记号（伴奏为线性贯穿版，见模块 docstring 的时长论证）
    for barline in measure.findall("barline"):
        for repeat in barline.findall("repeat"):
            barline.remove(repeat)
            stats["repeat"] += 1
        if len(barline) == 0 and not (barline.text or "").strip():
            measure.remove(barline)


def clean(xml_bytes: bytes) -> tuple[bytes, dict, list[tuple[str, list[str]]]]:
    root = ET.fromstring(xml_bytes)
    stats = {"voice2": 0, "backup": 0, "chord": 0, "trim": 0, "repeat": 0}
    melody_log: list[tuple[str, list[str]]] = []

    for part in root.findall("part"):
        for measure in part.findall("measure"):
            clean_measure(measure, stats)
            names = [name_of(n) for n in measure.findall("note")]
            melody_log.append((measure.get("number") or "?", names))

    ET.indent(root, space="  ")
    out = ET.tostring(root, encoding="utf-8")
    # libxml 系解析器（浏览器/happy-dom）不认 ElementTree 默认的单引号声明，统一双引号
    out = b'<?xml version="1.0" encoding="UTF-8"?>\n' + out
    return out, stats, melody_log


def audit(melody_log: list[tuple[str, list[str]]]) -> list[str]:
    """旋律连续性抽查：同一小节内相邻音程 > 八度（12 半音）则报告人工复核点。"""
    findings = []
    for number, names in melody_log:
        midis: list[int] = []
        for name in names:
            if name == "rest":
                continue
            step, octave = name[0], int(name[-1])
            alter = 1 if "#" in name else (-1 if "b" in name else 0)
            midis.append((octave + 1) * 12 + STEP_SEMITONE[step] + alter)
        for a, b in zip(midis, midis[1:]):
            if abs(a - b) > 12:
                findings.append(f"m{number}: {name} 跳进 >八度（{a}→{b}）")
    return findings


def main() -> int:
    # 原始谱备份只建一次；之后永远从备份读，保证可重跑
    if not RAW_XML.exists():
        OMR_DIR.mkdir(parents=True, exist_ok=True)
        RAW_XML.write_bytes(PUBLIC_XML.read_bytes())
        print(f"[backup] 原始谱 → {RAW_XML.relative_to(REPO)}")
    raw = RAW_XML.read_bytes()

    out, stats, melody_log = clean(raw)
    PUBLIC_XML.write_bytes(out)
    FINAL_XML.write_bytes(out)

    # 完整性自检
    root = ET.fromstring(out)
    problems = []
    voices = {n.findtext("voice") for n in root.iter("note")}
    if voices - {None, "1"}:
        problems.append(f"残留 voice: {voices}")
    for tag in ("backup", "forward", "chord", "repeat"):
        if root.find(f".//{tag}") is not None:
            problems.append(f"残留 <{tag}>")
    divisions, expected = 4, None
    for measure in root.findall("./part/measure"):
        t = measure.find("./attributes/time/beats")
        if t is not None:
            expected = int(t.text) * divisions
        total = sum(
            int(n.findtext("duration") or 0)
            for n in measure.findall("note")
            if n.find("chord") is None
        )
        if expected is not None and total != expected:
            problems.append(f"m{measure.get('number')} 拍数 {total}/{expected}")

    measures = root.findall("./part/measure")
    print(
        f"[clean] {len(measures)} 小节 | 删除 voice2/3 音 {stats['voice2']}、"
        f"backup {stats['backup']}、和弦多余音 {stats['chord']}、"
        f"截齐超拍 {stats['trim']}、反复记号 {stats['repeat']}"
    )
    # 逐小节旋律抽查（前 8 小节全文 + 跳进异常清单）
    for number, names in melody_log[:8]:
        print(f"  m{number}: {' '.join(names)}")
    for f in audit(melody_log):
        print(f"  [audit] {f}")
    if problems:
        print("[FAIL] 自检未通过：")
        for p in problems:
            print("  -", p)
        return 1
    print(f"[ok] 已写出 {PUBLIC_XML.relative_to(REPO)} 与 {FINAL_XML.relative_to(REPO)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
