# 圆圆和QE的星空小铺（qe-star-bottle）

「圆圆和QE的星空小铺」是一个包含多个功能入口的网站的本地开发与数据管理仓库。

- 核心站点位于 `shared-board`（Node.js 服务端与前端资源）。
- 网站部署在云服务器上（宝塔 + PM2 + Nginx 反向代理）。
- 本仓库负责：代码更新（通过 `deploy-server.sh`）和运行数据同步（通过 `PULL / PUSH / SYNC-SERVER-DATA.cmd`）。

## 网站功能

- `/home`：功能中心，从下面的功能入口进入各功能。
- `/star-bottle`：星星瓶。从星河里挑一颗星星，打开一张给圆圆宝宝的纸条；保留原有纸条、收藏和主人编辑能力。
- `/love-stars`：七夕星空情书。旋转视角，在星尘与双星之间发现一封隐藏的告白。
- `/wrong`：严格教育现场。点击舞台，看圆圆宝宝拿小锤子敲打 QE。

首次打开会先进入登录页（`SITE_USERNAME` / `SITE_PASSWORD`）。站长编辑使用独立的主人密码（`OWNER_PASSWORD`）。功能注册表在 `config/features.js`，新增功能从这里接入。

完整的功能说明、目录结构、本地运行与公网启动步骤，见 [shared-board/README.md](shared-board/README.md)。

## 仓库结构

```text
shared-board/            网站源码（Node.js 服务端与前端资源）
  config/features.js     功能注册表（新增功能从这里接入）
  lib/                   功能注册表校验、门户状态等
  public/                前端页面、3D 与物理引擎、宠物动画、音乐
  data/                  运行数据（纸条、收藏、访问记录、主人设备名单、功能数据）——除 settings.json 外均会被转移
  server.js              服务端入口
  deploy-server.sh       服务器自动部署脚本
  ecosystem.config.cjs   PM2 配置
  BAOTA-DEPLOY.md        宝塔部署详细说明
tools/
  sync-server-data.ps1   运行数据同步脚本（由 *.cmd 快捷方式调用）
server-data/             (gitignore) 从服务器拉取的运行数据副本与备份
  from-server/           PULL 到的本地数据
  backups/               拉取/推送前生成的本地备份
deploy-package-*/        (gitignore) 生成的部署包
qe-star-bottle-deploy-*.zip   (gitignore) 生成的部署压缩包
*.cmd                    双击即可运行的 Windows 快捷脚本（PULL / PUSH / SYNC）
```

## 运行数据同步

运行 JSON 数据刻意不纳入 Git，保存在 `server-data\from-server`。双击 `SYNC-SERVER-DATA.cmd` 选择方向，或直接使用：

- `PULL-SERVER-DATA.cmd`：把服务器数据下载到本地 `server-data\from-server`。
- `PUSH-SERVER-DATA.cmd`：把该本地文件夹上传到服务器。

四个核心文件（`notes.json`、`favorites.json`、`activity.json`、`owner-devices.json`）总是被同步；功能数据存在时一并同步：`love-stars-messages.json`、`wrong-counter.json`、`portal-settings.json`、`portal-activity.json`。`settings.json` 与 `.env` 永远不会被该工具同步，因为它们包含服务器专属的凭据和配置。

- 拉取会把之前的本地文件夹备份到 `server-data\backups`。推送会在服务器 `/var/backups/qe-star-bottle` 下创建带时间戳的备份，替换数据后重启 PM2，并检查 `/api/health`。
- 本地服务只读写下载的数据副本，不会直接修改云服务器。需要传回服务器时再运行 `PUSH-SERVER-DATA.cmd`。

## 本地运行

在项目上一级目录先双击 `PULL-SERVER-DATA.cmd` 下载数据副本，然后在 `shared-board` 目录双击 `START-LOCAL.cmd`，浏览器访问 `http://localhost:8787/home`。

前端代码和音乐文件无需编译，修改后刷新浏览器即可；改动 `server.js` 后需要关闭并重新运行本地服务。

## 启动公网网站（临时）

在 `shared-board` 目录双击 `START-PUBLIC.cmd`。首次启动会自动下载约定版本的 Three.js 和 Cannon ES，然后显示：

```text
Public URL: https://...trycloudflare.com
```

将这个网址发给其他电脑即可访问；公网网址每次重新启动连接时可能变化。停止网站双击 `STOP.cmd`。

## 更新网站代码（服务器）

在服务器仓库根目录执行自动部署脚本（它会拉取 `main`、按需安装依赖、重启 PM2 并检查健康状态）：

```bash
cd /www/wwwroot/qe-star-bottle
bash shared-board/deploy-server.sh
```

`PUSH-SERVER-DATA.cmd` 只同步运行数据，不会上传网页或服务端代码。

## 部署到云服务器（宝塔）

### 准备

把整个 Git 仓库（包含 `shared-board` 子目录）上传到 `/www/wwwroot/qe-star-bottle`，应用目录为 `/www/wwwroot/qe-star-bottle/shared-board`。不要只上传 `shared-board` 子目录，否则服务器上没有自动部署脚本；不要删除 `data` 文件夹。

### 环境

- 宝塔软件商店通过“Node.js 版本管理器”安装 Node.js 20 或 22，再安装 PM2。
- 在 `shared-board` 目录执行：`npm install --omit=dev --package-lock=false`，以及 `npm install -g pm2`。
- 新建 `shared-board/.env`，设置 `NODE_ENV`、`HOST=127.0.0.1`、`PORT=8787`、`BOARD_DATA_DIR=/www/wwwroot/qe-star-bottle/data`、`OWNER_PASSWORD`、`SITE_USERNAME`、`SITE_PASSWORD`、`SESSION_HOURS=12`。请使用长随机密码，不要用简单数字密码。
- 执行 `pm2 start ecosystem.config.cjs`、`pm2 save`、`pm2 startup`（复制并执行其打印的命令），再 `pm2 save` 并检查 `curl http://127.0.0.1:8787/api/health`。

### 域名与 HTTPS

宝塔“网站”添加域名，反向代理目标为 `http://127.0.0.1:8787`，并应用 `nginx-starshop.conf.example` 中的转发请求头、超时与 `proxy_buffering off` / `proxy_cache off` 等配置；申请并启用 SSL 证书。防火墙（宝塔与云安全组）只开放 `80`、`443` 及必要的 `22`，不要开放 `8787`，因为 Node 已绑定到 `127.0.0.1`。

详细步骤见 [shared-board/BAOTA-DEPLOY.md](shared-board/BAOTA-DEPLOY.md)。

## 数据备份

升级或迁移前备份整个 `data` 文件夹：

```text
data/notes.json
data/favorites.json
data/activity.json
data/owner-devices.json
data/settings.json
data/love-stars-messages.json
data/wrong-counter.json
data/portal-settings.json
data/portal-activity.json
```

后四个文件在对应功能首次产生数据前可能尚不存在。`settings.json` 或生产 `.env` 中含站长密码，不要上传到公开仓库。
