#!/usr/bin/env bash
# Syrinx web 端部署脚本（web-deploy 分支专用）
# 用法：bash scripts/deploy.sh
#
# 流程：build → tar → 上传 → 解压 → 媒体优化（压图/视频转码/伴奏 AAC）→ 验证
# 服务器：romanticjojo.com (47.95.167.143)，nginx 配置见 docs/deploy/nginx-romanticjojo.conf
# 依赖：服务器需 ffmpeg + python3-PIL（首次部署见 DEPLOY-WEB.md）

set -e
cd "$(dirname "$0")/.."

HOST=47.95.167.143
USER=root
REMOTE_DIR=/var/www/syrinx
STAMP=$(date +%Y%m%d-%H%M%S)
TAR=/tmp/syrinx-dist-$STAMP.tar.gz

echo "[1/5] 构建..."
cd app && npm run build && cd ..

echo "[2/5] 打包上传..."
tar -czf "$TAR" -C app/dist .
scp -o StrictHostKeyChecking=no "$TAR" $USER@$HOST:/tmp/

echo "[3/5] 服务器解压 + 媒体优化（原文件自动备份到 /root/syrinx-*-backup）..."
ssh -o StrictHostKeyChecking=no $USER@$HOST "
  set -e
  rm -rf $REMOTE_DIR
  mkdir -p $REMOTE_DIR
  tar -xzf /tmp/$(basename $TAR) -C $REMOTE_DIR
  rm /tmp/$(basename $TAR)

  # ── 媒体优化（幂等：已在服务器优化过的文件会被新上传的原始文件覆盖，重跑一遍即可）──
  mkdir -p /root/syrinx-img-backup /root/syrinx-video-backup /root/syrinx-audio-backup
  python3 - <<'PY'
from PIL import Image
import os
# 1) 图片：>200KB 的 jpg 缩到最长边 1280 + 质量 80
for root, dirs, files in os.walk('/var/www/syrinx'):
    for f in files:
        if not f.endswith('.jpg'): continue
        p = os.path.join(root, f)
        if os.path.getsize(p) < 200 * 1024: continue
        shutil_copy = '/root/syrinx-img-backup/' + f
        if not os.path.exists(shutil_copy):
            import shutil; shutil.copy2(p, shutil_copy)
        im = Image.open(p).convert('RGB')
        w, h = im.size
        if max(w, h) > 1280:
            r = 1280 / max(w, h)
            im = im.resize((round(w * r), round(h * r)), Image.LANCZOS)
        tmp = p + '.tmp'
        im.save(tmp, 'JPEG', quality=80, optimize=True, progressive=True)
        if os.path.getsize(tmp) < os.path.getsize(p):
            os.replace(tmp, p)
            print(f'  img {f}: compressed')
        else:
            os.remove(tmp)
PY

  # 2) 视频：hover-square → 720x720 无音轨；background → 原分辨率 CRF26
  cd /var/www/syrinx/songs
  for song in */; do
    song=\${song%/}
    [ -f \"\$song/hover-square.mp4\" ] && {
      cp -n \"\$song/hover-square.mp4\" /root/syrinx-video-backup/\"\$song-hover-square.mp4\" 2>/dev/null || true
      ffmpeg -y -loglevel error -i \"\$song/hover-square.mp4\" -vf scale=720:720 -an -c:v libx264 -crf 26 -preset medium -movflags +faststart /tmp/v.mp4 \\
        && mv /tmp/v.mp4 \"\$song/hover-square.mp4\"
    }
    for bg in background.mp4 background-square.mp4; do
      [ -f \"\$song/\$bg\" ] && {
        cp -n \"\$song/\$bg\" /root/syrinx-video-backup/\"\$song-\$bg\" 2>/dev/null || true
        ffmpeg -y -loglevel error -i \"\$song/\$bg\" -an -c:v libx264 -crf 26 -preset medium -movflags +faststart /tmp/v.mp4 \\
          && mv /tmp/v.mp4 \"\$song/\$bg\"
      }
    done
  done

  # 3) 伴奏：mp3 320k → AAC 96k m4a（-vn 丢封面流；URL 不变，nginx 内容协商吐 m4a）
  for song in */; do
    song=\${song%/}
    f=\"\$song/accompaniment.mp3\"
    [ -f \"\$f\" ] || continue
    cp -n \"\$f\" /root/syrinx-audio-backup/\"\$song-accompaniment.mp3\" 2>/dev/null || true
    ffmpeg -y -loglevel error -i \"\$f\" -vn -c:a aac -b:a 96k -movflags +faststart \"\$song/accompaniment.m4a\"
  done
  cd /

  echo '== 验证 =='
  curl -s -o /dev/null -w '首页: %{http_code}\\n' --resolve romanticjojo.com:443:127.0.0.1 https://romanticjojo.com/
  curl -s -o /dev/null -w '伴奏(flower-dance): %{http_code} %{content_type} %{size_download}B\\n' --resolve romanticjojo.com:443:127.0.0.1 https://romanticjojo.com/songs/flower-dance/accompaniment.mp3
"

echo "[4/5] nginx 配置检查（配置变更时手动应用 docs/deploy/nginx-romanticjojo.conf）..."
echo "  跳过——如需更新 nginx 配置，参考 docs/deploy/nginx-romanticjojo.conf 手动合并"

echo "[5/5] ✓ https://romanticjojo.com/ 已更新"
echo "  完整首访验证：新开无痕窗口（Ctrl+Shift+N）访问，曲库 hover 与进曲伴奏应明显变快"
