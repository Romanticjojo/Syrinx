#!/usr/bin/env bash
# Syrinx web 端部署脚本（web-deploy 分支专用）
# 用法：bash deploy.sh [commit-message 可选，默认自动带时间戳]
#
# 流程：本地 build → tar → 上传阿里云 → 解压 /var/www/syrinx → 完成
# 服务器：romanticjojo.com (47.95.167.143)，nginx 配置在 /etc/nginx/sites-enabled/proxy
# 注意：cover/logo 等大图上传后需要在服务器跑压缩（见 DEPLOY-WEB.md），否则首访流量爆炸

set -e
cd "$(dirname "$0")/.."

HOST=47.95.167.143
USER=root
REMOTE_DIR=/var/www/syrinx
STAMP=$(date +%Y%m%d-%H%M%S)
TAR=/tmp/syrinx-dist-$STAMP.tar.gz

echo "[1/4] 构建..."
cd app && npm run build && cd ..

echo "[2/4] 打包..."
tar -czf "$TAR" -C app/dist .

echo "[3/4] 上传..."
scp -o StrictHostKeyChecking=no "$TAR" $USER@$HOST:/tmp/

echo "[4/4] 服务器解压..."
ssh -o StrictHostKeyChecking=no $USER@$HOST "
  set -e
  rm -rf $REMOTE_DIR
  mkdir -p $REMOTE_DIR
  tar -xzf /tmp/$(basename $TAR) -C $REMOTE_DIR
  rm /tmp/$(basename $TAR)
  echo '== 图片压缩（>200KB 的 jpg）=='
  python3 - <<'PY'
from PIL import Image
import os
for root, dirs, files in os.walk('/var/www/syrinx'):
    for f in files:
        if not f.endswith('.jpg'):
            continue
        p = os.path.join(root, f)
        if os.path.getsize(p) < 200 * 1024:
            continue
        im = Image.open(p).convert('RGB')
        w, h = im.size
        if max(w, h) > 1280:
            r = 1280 / max(w, h)
            im = im.resize((round(w * r), round(h * r)), Image.LANCZOS)
        tmp = p + '.tmp'
        im.save(tmp, 'JPEG', quality=80, optimize=True, progressive=True)
        if os.path.getsize(tmp) < os.path.getsize(p):
            os.replace(tmp, p)
            print(f'  compressed {f}')
        else:
            os.remove(tmp)
PY
  echo '部署完成'
  curl -s -o /dev/null -w '首页: %{http_code}\\n' --resolve romanticjojo.com:443:127.0.0.1 https://romanticjojo.com/
"

echo "✓ https://romanticjojo.com/ 已更新"
