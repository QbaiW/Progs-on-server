# 宝塔部署说明

## 1. 准备项目

建议把 Git 仓库（包含 `shared-board` 子目录）上传到：

```text
/www/wwwroot/qe-star-bottle
```

应用目录应为 `/www/wwwroot/qe-star-bottle/shared-board`。如果使用 Git 部署，
不要只上传 `shared-board` 子目录，否则服务器上没有自动部署脚本。

可以不上传 `cloudflared.exe`、`*.ps1`、`*.cmd`、`*.log` 和 `public-url.txt`。不要删除 `data` 文件夹；其中保存纸条、收藏、访问记录、主人设备名单、功能数据和主页管理设置。

## 2. 安装 Node.js 和 PM2

在宝塔软件商店安装 Node.js 版本管理器，选择 Node.js 20 或 22。然后在宝塔终端执行：

```bash
cd /www/wwwroot/qe-star-bottle/shared-board
npm install --omit=dev --package-lock=false
npm install -g pm2
```

项目没有提交依赖锁文件；`npm install` 产生的 `package-lock.json` 不参与代码部署。

如果服务器没有编译工具，当前项目不需要编译原生模块；`three` 和 `cannon-es` 的浏览器文件已经放在 `public/vendor` 中。

## 3. 设置生产环境变量

在宝塔文件管理器新建 `/www/wwwroot/qe-star-bottle/shared-board/.env`，内容如下。把密码换成新的长密码，不建议继续使用简单数字密码：

```dotenv
NODE_ENV=production
HOST=127.0.0.1
PORT=8787
BOARD_DATA_DIR=/www/wwwroot/qe-star-bottle/data
OWNER_USERNAME=QbaiW
OWNER_PASSWORD=replace-with-a-long-random-password
SITE_USERNAME=Yuna
SITE_PASSWORD=replace-with-a-long-random-password
SESSION_HOURS=12
```

`.env` 已加入 `.gitignore`，不要把真实密码提交到 Git 或发到聊天里。`SITE_USERNAME` + `SITE_PASSWORD` 是用户级账号（日常使用，能打开全部页面和功能）；`OWNER_USERNAME` + `OWNER_PASSWORD` 是管理员级账号，权限上包含用户级的全部功能，另外还能打开 /home 里的管理后台。两套账号在同一个登录页输入，管理员账号登录后会顺手建立管理会话，页面右上角会出现「管理后台」入口；原站长入口（功能中心连点 4 次）仍然可用。`data/settings.json` 里的账号优先于环境变量，改名后可同步修改该文件。

## 4. 启动并设置自动重启

在项目目录执行：

```bash
cd /www/wwwroot/qe-star-bottle/shared-board
pm2 delete qe-star-bottle 2>/dev/null || true
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup
```

`pm2 startup` 会打印一条需要复制并执行的命令。执行那条命令后，再运行：

```bash
pm2 save
curl http://127.0.0.1:8787/api/health
```

看到 `"ok":true` 才继续配置域名。查看日志使用：

```bash
pm2 logs qe-star-bottle --lines 100
```

以后修改 `.env` 后，执行 `pm2 startOrRestart ecosystem.config.cjs --update-env`，让 PM2 重新读取账号密码等配置。

## 5. 在宝塔添加网站和 HTTPS

在“网站”中添加你的域名，例如 `star.example.com`。网站根目录可以填写项目目录，但公网请求必须通过反向代理转发给 Node；不要把 `data` 目录单独作为网站根目录。

在“反向代理”中新增：

```text
目标 URL: http://127.0.0.1:8787
发送域名: $host
```

打开高级配置，将 `nginx-starshop.conf.example` 中的 `proxy_http_version`、转发请求头、`proxy_buffering off`、`proxy_cache off`、`proxy_read_timeout 3600s` 和 `proxy_send_timeout 3600s` 加入代理配置。必须让 Nginx 覆盖 `X-Forwarded-For` 并清空外部传入的 `CF-Connecting-IP`，否则登录限流可能被伪造来源头绕过。SSE 如果出现“已断开”或无法实时同步，优先检查这些配置。

随后在宝塔“SSL”中申请并启用证书，再打开强制 HTTPS。HTTPS 很重要，因为主人登录使用 HttpOnly Cookie，公网环境不应使用明文 HTTP。

## 6. 防火墙

宝塔和云服务器安全组只开放 `80`、`443`，以及必要的 `22`。不要开放 `8787`，因为 Node 已绑定到 `127.0.0.1`，外部只能通过 Nginx 访问。

## 7. 数据备份

升级或迁移前备份整个 `data` 文件夹。至少包含：

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

后四个文件在对应功能首次产生数据前可能尚不存在；存在时必须一并备份。`settings.json` 或生产 `.env` 中含有站长密码，不要上传到公开仓库。

更新代码时，在仓库根目录执行自动部署脚本（它会拉取 `main`、按需安装依赖、重启 PM2 并检查健康状态）：

```bash
cd /www/wwwroot/qe-star-bottle
bash shared-board/deploy-server.sh
```

脚本会忽略 `npm install` 自动生成的未跟踪 `shared-board/package-lock.json`，但仍会拒绝
其他未提交的代码改动，以免覆盖服务器上的人工修改。部署锁使用仓库 `.git` 目录的
`flock`，不再依赖 `/tmp` 下由某个用户创建的锁文件。如果仓库由 `root`（或其他固定部署用户）
管理，从 `admin` 终端直接运行时脚本会自动通过 `sudo` 切换到同一用户，避免出现两套 PM2
进程；不要交替用不同用户手动启动 PM2。看到 `refusing dirty non-data path` 时先检查
`git status --short`，不要直接使用 `git reset --hard`。宝塔终端是 Linux shell，请逐行粘贴命令；
如果出现 `$'\r': command not found`，说明复制内容带入了 Windows 换行符，重新手动输入该行即可。
