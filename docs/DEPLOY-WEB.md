# Syrinx Web 端部署（web-deploy 分支）

这个分支专门用于 BS 架构的 Web 端部署，部署目标 **https://romanticjojo.com**。

## 架构

- 形态：Vite 静态 SPA（`app/`，React + TS + OSMD + three.js），无后端
- 服务器：阿里云 47.95.167.143（Ubuntu 22.04，2C/1.6G，nginx 1.18）
- 域名：romanticjojo.com / www（已备案，DNS → 47.95.167.143）
- HTTPS：Let's Encrypt（`/etc/letsencrypt/live/romanticjojo.com/`，webroot 续期，nginx 配置内含 ACME 直通）

## 一键部署

```bash
bash scripts/deploy.sh
```

流程：build → tar → scp 上传 → 服务器解压到 `/var/www/syrinx` → 自动压缩 >200KB 的 jpg。

## nginx 配置要点（/etc/nginx/sites-enabled/proxy）

- `listen 443 ssl http2`（HTTP/2 多路复用）
- `location ^~ /.well-known/acme-challenge/` 直通（SPA fallback 不能吞 ACME 验证，续期靠它）
- `/assets/` 30 天 immutable 缓存；`/songs/` `/brand/` 7 天
- gzip：css/js/json/svg（JS 主包 2.2MB → 588KB）
- 视频走 Range 请求（206），不整段下载

## 首访性能账单（2026-09-06 优化实测）

| 项 | 优化前 | 优化后 |
|---|---|---|
| 曲库页图片 | ~6.5MB（logo 2.27MB、封面最大 1.4MB） | ~1MB（服务器压缩 83%） |
| JS 主包 | 2.2MB（gzip 588KB） | 同 |
| 进曲后背景 mp4 | 8MB×2 次全量请求 | Range 流式（浏览器按需拉） |
| 协议 | HTTP/1.1 | HTTP/2 |

原图备份：服务器 `/root/syrinx-img-backup/`。

## 已知待办（应用侧，不动服务器）

- 进演奏页时背景 mp4 预加载策略（`preload="metadata"` 或首帧海报）——需要改 `app/` 代码，在 dev 分支做
- JS 主包 2.2MB 可 code-split（OSMD/three.js 动态 import）——同上
