# Syrinx Web 发布与回滚

R1 使用不可变版本目录。线上入口仍是 `/var/www/syrinx/index.html`，每个完整版本位于 `/var/www/syrinx-releases/<release-id>/`。入口只通过同文件系统临时文件原子替换；发布流程不会删除或覆盖旧版本资源。

## 一次性 nginx 配置

人工把 [`deploy/nginx-syrinx-releases.conf`](deploy/nginx-syrinx-releases.conf) 中两个 `location` 合并到以下两个 Syrinx server 块：

- `/etc/nginx/sites-enabled/proxy` 的 `romanticjojo.com` 443 块；
- `/etc/nginx/sites-enabled/syrinx` 的 8090 块。

保留共享文件中的 Alnazar server、现有 `root /var/www/syrinx;`、ACME challenge、证书和其他 location。不要用仓库文件覆盖服务器配置。

先把 `/etc/nginx/mime.types` 复制为 `/etc/nginx/snippets/syrinx-mime.types`，只把其中 `.m4a` 的 `audio/x-m4a` 映射改为 `audio/mp4`（已经是 `audio/mp4` 时保留）。版本资源 location 引用这份专用表，其他类型保留原值，也不改变同机其他网站的 MIME 配置。实际 Ubuntu 表默认为 `audio/x-m4a`，不能仅假定 include 标准表就满足验收。

合并后先执行 `nginx -t`；只有检查成功才 reload。分别请求 8090 和 HTTPS 的版本 M4A，确认 `Content-Type: audio/mp4`、字节范围请求返回 206，以及 JS/CSS 类型和缓存正常。

## 准备候选版（Windows 或 Linux）

需要 Python 3、Node/npm、`ffprobe`。媒体快照目录必须包含 `songs/<song-id>/...` 与 `brand/...`。优先从当前线上目录只读取得已经优化过的快照，避免二次压缩；工具绝不修改快照或 `app/public`。

PowerShell：

```powershell
python scripts\release.py prepare `
  --app-dir app `
  --media-snapshot resources\r1-audit\optimized-snapshot `
  --output-root resources\r1-audit\release-staging
```

Bash：

```bash
python3 scripts/release.py prepare \
  --app-dir app \
  --media-snapshot resources/r1-audit/optimized-snapshot \
  --output-root resources/r1-audit/release-staging
```

默认上线曲目固定为 `luv-letter,flower-dance,expedition-33,interstellar`。确需改变时显式传 `--song-ids id1,id2`。工具自动生成 `<UTC>-<git-sha>-<random>` 版本号，并在构建时设置：

```text
SYRINX_RELEASE_ID=<release-id>
VITE_SONG_IDS=luv-letter,flower-dance,expedition-33,interstellar
VITE_AUDIO_FORMAT=m4a
```

准备顺序是：先验证源 manifest 的全部引用、MusicXML 与 beats 时间轴，再构建；随后丢弃 `dist/songs` 和 `dist/brand`，只从显式优化快照复制上线曲目的引用文件与品牌图。源 manifest 保持 MP3 不变；候选版中生成的 manifest 和编译后的资源解析器直接指向 M4A。未上线曲目、原始 MP3 和快照里的多余文件不会进入候选版。

`ffprobe` 无法解码 AAC/MP4/MP3、快照的 score/beats 与源码哈希不同、资源缺失、构建失败或同一版本目录已经存在，都会以非零状态停止。失败候选不会成为线上入口。成功目录包含 `release-manifest.json` 与覆盖其余全部文件的 `checksums.sha256`。

可再次独立检查：

```powershell
python scripts\release.py verify --release-dir resources\r1-audit\release-staging\<release-id>
```

`--dist-dir` 只用于测试夹具或事故恢复时验证已有构建；正常发布不要绕过带环境变量的构建。

## 上传和发布

把完整候选目录、`scripts/release.py` 与 `scripts/deploy.sh` 上传到服务器的临时接收目录。不要直接写 `/var/www/syrinx-releases/<release-id>`，发布器会先在 release 根目录的隐藏 incoming 目录复制并验证，再原子命名为正式版本。

服务器发布命令：

```bash
sudo bash /srv/syrinx-tools/deploy.sh publish \
  --candidate /srv/syrinx-incoming/<release-id> \
  --release-root /var/www/syrinx-releases \
  --live-root /var/www/syrinx \
  --probe-base-url http://127.0.0.1:8090 \
  --probe-base-url https://romanticjojo.com \
  --resolve romanticjojo.com:443:127.0.0.1
```

发布器会执行这些门槛：

1. 本地校验候选全部 SHA-256、允许曲目、文件格式与可解码性；
2. 拒绝覆盖已有版本号，把候选复制为同文件系统的 incoming 目录，复验后原子命名；
3. 在切换前，通过 8090 回环和 HTTPS 回环逐个请求版本入口、全部 JS/CSS 和 manifest 引用资源；`curl --fail`、10 秒连接超时、45 秒总超时保证 4xx/5xx 或挂起均失败；
4. 把当前入口保留到 `/var/www/syrinx/.index-history/`，再用 `/var/www/syrinx` 内的临时文件原子替换 `index.html`；
5. 切换后复查两个根入口和版本资源。任何探测失败都会立即原子恢复刚保存的旧入口，并返回非零。

首次增加 `/releases/` 路由必须先由人工完成 nginx 合并与 `nginx -t`。发布器不会修改或 reload nginx，也不会删除 live 目录或历史版本。

## 回滚

记录每次发布前的版本号。回滚直接重新激活仍然完整的旧版本：

```bash
sudo bash /srv/syrinx-tools/deploy.sh rollback \
  --release-id <previous-release-id> \
  --release-root /var/www/syrinx-releases \
  --live-root /var/www/syrinx \
  --probe-base-url http://127.0.0.1:8090 \
  --probe-base-url https://romanticjojo.com \
  --resolve romanticjojo.com:443:127.0.0.1
```

它会完整验证旧版本并执行同样的预检、原子切换、后检，同时把当前入口再留一份历史备份。

如果第一版上线前的旧入口还没有版本目录，可从 `.index-history` 恢复。先选择本次发布命令输出的 `previousIndex`，验证它确实是预期旧页，然后在 live 根目录内复制成临时文件并原子移动：

```bash
sudo cp /var/www/syrinx/.index-history/<exact-backup>.html /var/www/syrinx/.index.rollback.tmp
sudo mv -T /var/www/syrinx/.index.rollback.tmp /var/www/syrinx/index.html
curl --fail --show-error --silent --connect-timeout 10 --max-time 45 \
  --output /dev/null http://127.0.0.1:8090/
```

不要用模糊匹配自动挑备份，也不要删除失败候选或旧资源；保留它们用于定位。

## 发布记录

每次记录新旧版本号、切换时间、命令输出的 `previousIndex`、候选校验结果、8090 与 HTTPS 检查、四首曲目的业务冒烟测试，以及未覆盖的设备/实吹项目。上传完成不等于部署验收通过。
