# Syrinx Web 端部署（web-deploy 分支）

这个分支专门用于 BS 架构的 Web 端部署，部署目标 **https://romanticjojo.com**。

## 架构

- 形态：Vite 静态 SPA（`app/`，React + TS + OSMD + three.js），无后端
- 服务器：阿里云 47.95.167.143（Ubuntu 22.04，2C/1.6G，nginx 1.18，**公网带宽 ~3.3Mbps**——一切媒体优化围绕它）
- 域名：romanticjojo.com / www（已备案，DNS → 47.95.167.143）
- HTTPS：Let's Encrypt（`/etc/letsencrypt/live/romanticjojo.com/`，webroot 续期）
- nginx 配置：`docs/deploy/nginx-romanticjojo.conf`（快照；实际写在服务器 `/etc/nginx/sites-enabled/proxy`，该文件还承载 alnazar.me——**只合并 Syrinx 块，别整文件覆盖**）

## 一键部署

```bash
bash scripts/deploy.sh
```

流程：build → tar → scp → 解压 → **媒体优化**（幂等）→ 验证。

服务器依赖（首次部署装一次）：

```bash
apt-get install -y ffmpeg python3-pil
```

## 媒体优化策略（deploy.sh 自动执行，2026-09-06 实测账单）

| 资源 | 策略 | 前 → 后 |
|---|---|---|
| 曲库封面/品牌图 jpg | >200KB 的缩到最长边 1280 + 质量 80 | 6.5MB → 1.0MB |
| hover 封面视频 | 720×720、去音轨、CRF26 | 25.2MB → 2.0MB |
| 背景视频（详情/演奏页） | **原分辨率**、去音轨、CRF26、faststart | 27.7MB → 7.2MB |
| 伴奏 mp3（320k） | AAC 96k m4a + nginx 内容协商（URL 仍 .mp3） | 37.9MB → 16.0MB |

设计原则：
- **背景视频保原分辨率**（详情页/演奏页全屏直出无模糊，清晰度优先）；hover 封面显示才 ~300px，720 足够
- `-movflags +faststart`（moov 前置）让视频边下边播
- 伴奏内容协商：应用 URL 硬编码 `.mp3`，nginx `try_files` 优先吐 `accompaniment.m4a`，应用零改动
- 原 mp3 带内嵌封面流，转码必须 `-vn`（否则 x264 报 width not divisible by 2）

首访总账：**22.4MB → 2.3MB（-90%）**；flower-dance 伴奏加载 **20+s → 7.3s**。

原文件备份（服务器）：`/root/syrinx-img-backup/`、`/root/syrinx-video-backup/`、`/root/syrinx-audio-backup/`。

## nginx 配置要点

- `listen 443 ssl http2`
- **ACME 直通**：`location ^~ /.well-known/acme-challenge/ { root /var/www/html; }`——SPA fallback 会吞验证路径导致续期失败（踩过）
- `/assets/` 30 天 immutable；`/songs/` `/brand/` 7 天
- gzip：css/js/json/svg（JS 主包 2.2MB → 588KB）
- 视频天然支持 Range（206）

## 常见坑

- 本机代理会把外网直连测试变成 502/超时——验收要么服务器本地 `curl --resolve`，要么走系统代理
- nginx 备份文件不能留在 `sites-enabled/`（会被当配置加载 → conflicting server name）
- `certbot --nginx` 插件未装，续期走 webroot（renewal 配置已就位）
- Playwright 验收时入场弹窗 `.intro` 挡点击，先点「进入应用 ›」

## 后续优化方向（需改 app 代码，在 dev 分支做）

- 伴奏预取（进详情页就开始拉，点演奏时已就位）→ 可压到 0s
- JS 主包 2.2MB code-split（OSMD/three.js 动态 import）
- hover 视频首帧海报图替代预载
