#!/usr/bin/env bash
# Syrinx web 端部署脚本（web-deploy 分支专用）
# 用法：bash scripts/deploy.sh
#
# 流程：build → tar → 上传 → 解压 → 媒体优化（scripts/optimize_media.py）→ 验证
# 服务器：romanticjojo.com (47.95.167.143)，nginx 配置见 docs/deploy/nginx-romanticjojo.conf
# 依赖：服务器需 ffmpeg + python3-PIL（首次部署见 DEPLOY-WEB.md）
#
# ⚠️ 教训（2026-09-06）：手动解压 tar 覆盖站点会把服务器上优化过的媒体冲回肥版。
#    任何部署都必须走本脚本（或至少跑一遍 optimize_media.py），别手动 tar 覆盖。

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
scp -o StrictHostKeyChecking=no "$TAR" scripts/optimize_media.py $USER@$HOST:/tmp/

echo "[3/5] 服务器解压 + 媒体优化（原文件自动备份到 /root/syrinx-*-backup）..."
ssh -o StrictHostKeyChecking=no $USER@$HOST "
  set -e
  rm -rf $REMOTE_DIR
  mkdir -p $REMOTE_DIR
  tar -xzf /tmp/$(basename $TAR) -C $REMOTE_DIR
  rm /tmp/$(basename $TAR)
  cp /tmp/optimize_media.py /root/optimize_media.py
  rm /tmp/optimize_media.py
  python3 /root/optimize_media.py

  echo '== 验证 =='
  curl -s -o /dev/null -w '首页: %{http_code}\n' --resolve romanticjojo.com:443:127.0.0.1 https://romanticjojo.com/
  curl -s -o /dev/null -w '伴奏(flower-dance): %{http_code} %{content_type} %{size_download}B\n' --resolve romanticjojo.com:443:127.0.0.1 https://romanticjojo.com/songs/flower-dance/accompaniment.mp3
"

echo "[4/5] nginx 配置检查（配置变更时手动应用 docs/deploy/nginx-romanticjojo.conf）..."
echo "  跳过——如需更新 nginx 配置，参考 docs/deploy/nginx-romanticjojo.conf 手动合并"

echo "[5/5] ✓ https://romanticjojo.com/ 已更新"
echo "  完整首访验证：新开无痕窗口（Ctrl+Shift+N）访问，曲库 hover 与进曲伴奏应明显变快"
