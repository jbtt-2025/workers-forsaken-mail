Cloudflare Workers 版本说明
==========================
本目录是 Forsaken Mail 的 Cloudflare Workers 重写版：前端保持不变，后端改为 Workers Email + D1。

一键部署
--------
[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/jbtt-2025/workers-forsaken-mail)

部署后在 Cloudflare 控制台完成：
- 绑定 D1：binding 名为 `DB`，并在 `worker_version/wrangler.toml` 填入你的 `database_id`。
- 环境变量：`MAIL_DOMAIN`（邮箱域名）、`PRE_BLACKLIST`（前缀黑名单，逗号分隔）、`BAN_SEND_FROM_DOMAIN`（拒收域名，逗号分隔）。
- 邮件路由：为 `MAIL_DOMAIN` 配置 Email Routing/MX，并把同一个 Worker 绑定到 Email 入口。
- 定时清理：`wrangler.toml` 已含 cron（每日 0 点清理 7 天前邮件）。

本地/调试
---------
1) 安装 `wrangler`。  
2) 创建并绑定 D1 数据库，确保 binding 名称为 `DB`。  
3) 在 `worker_version/wrangler.toml` 设置你的环境变量。  
4) 运行：`wrangler dev --config worker_version/wrangler.toml`。

项目链接
--------
Cloudflare 版本仓库：https://github.com/jbtt-2025/workers-forsaken-mail
