#!/usr/bin/env python3
# 服务器媒体优化（幂等）：大图压缩 + hover/背景视频转码 + 伴奏 AAC
import os, sys, subprocess, shutil

WEB = "/var/www/syrinx"
IMG_BAK = "/root/syrinx-img-backup"
VID_BAK = "/root/syrinx-video-backup"
AUD_BAK = "/root/syrinx-audio-backup"

def run(cmd):
    r = subprocess.run(cmd, shell=True, capture_output=True, text=True)
    if r.returncode != 0:
        print(f"  FAIL {cmd}: {r.stderr[:200]}")
        return False
    return True

# ── 1) 图片：>200KB jpg → 最长边 1280 质量 80 ──
from PIL import Image
os.makedirs(IMG_BAK, exist_ok=True)
for root, dirs, files in os.walk(WEB):
    for f in files:
        if not f.lower().endswith(".jpg"):
            continue
        p = os.path.join(root, f)
        if os.path.getsize(p) < 200 * 1024:
            continue
        bak = os.path.join(IMG_BAK, f)
        if not os.path.exists(bak):
            shutil.copy2(p, bak)
        im = Image.open(p).convert("RGB")
        w, h = im.size
        if max(w, h) > 1280:
            r = 1280 / max(w, h)
            im = im.resize((round(w * r), round(h * r)), Image.LANCZOS)
        tmp = p + ".tmp"
        im.save(tmp, "JPEG", quality=80, optimize=True, progressive=True)
        if os.path.getsize(tmp) < os.path.getsize(p):
            os.replace(tmp, p)
            print(f"img {f}: ->{os.path.getsize(p)//1024}KB")
        else:
            os.remove(tmp)

# ── 2) 视频：hover >800KB → 720²无音轨；背景 >2MB → 原分辨率 CRF26 ──
os.makedirs(VID_BAK, exist_ok=True)
songs_dir = os.path.join(WEB, "songs")
for song in sorted(os.listdir(songs_dir)):
    sd = os.path.join(songs_dir, song)
    if not os.path.isdir(sd):
        continue
    hover = os.path.join(sd, "hover-square.mp4")
    if os.path.isfile(hover) and os.path.getsize(hover) > 800_000:
        bak = os.path.join(VID_BAK, f"{song}-hover-square.mp4")
        if not os.path.exists(bak):
            shutil.copy2(hover, bak)
        out = "/tmp/_v.mp4"
        if run(f'ffmpeg -y -loglevel error -i "{hover}" -vf scale=720:720 -an -c:v libx264 -crf 26 -preset medium -movflags +faststart "{out}"'):
            old = os.path.getsize(hover)
            if os.path.getsize(out) < old:
                shutil.move(out, hover)
                print(f"{song}/hover: {old//1024}KB -> {os.path.getsize(hover)//1024}KB")
    for bg in ("background.mp4", "background-square.mp4"):
        bp = os.path.join(sd, bg)
        if os.path.isfile(bp) and os.path.getsize(bp) > 2_000_000:
            bak = os.path.join(VID_BAK, f"{song}-{bg}")
            if not os.path.exists(bak):
                shutil.copy2(bp, bak)
            out = "/tmp/_v.mp4"
            if run(f'ffmpeg -y -loglevel error -i "{bp}" -an -c:v libx264 -crf 26 -preset medium -movflags +faststart "{out}"'):
                old = os.path.getsize(bp)
                if os.path.getsize(out) < old:
                    shutil.move(out, bp)
                    print(f"{song}/{bg}: {old//1024}KB -> {os.path.getsize(bp)//1024}KB")

# ── 3) 伴奏：有 mp3 且无 m4a → AAC 96k ──
os.makedirs(AUD_BAK, exist_ok=True)
for song in sorted(os.listdir(songs_dir)):
    mp3 = os.path.join(songs_dir, song, "accompaniment.mp3")
    m4a = os.path.join(songs_dir, song, "accompaniment.m4a")
    if os.path.isfile(mp3) and not os.path.isfile(m4a):
        bak = os.path.join(AUD_BAK, f"{song}-accompaniment.mp3")
        if not os.path.exists(bak):
            shutil.copy2(mp3, bak)
        if run(f'ffmpeg -y -loglevel error -i "{mp3}" -vn -c:a aac -b:a 96k -movflags +faststart "{m4a}"'):
            print(f"{song}/accompaniment.m4a: {os.path.getsize(m4a)//1024}KB")

print("== ALL DONE ==")
