# 圆圆和QE的星空小铺

一个包含多个功能入口的网站。`/home` 是功能中心；普通访问者可以从这里进入星星瓶、七夕星空情书和严格教育现场。星星瓶仍保留原有纸条、收藏和主人编辑能力。

## 网站入口

- `http://localhost:8787/`：重定向到功能中心。
- `http://localhost:8787/home`：选择要进入的功能。
- `http://localhost:8787/star-bottle`：星星瓶。
- `http://localhost:8787/love-stars`：七夕星空情书。
- `http://localhost:8787/wrong`：严格教育现场。

首次打开会先进入登录页。访客账号为 `SITE_USERNAME`，密码为 `SITE_PASSWORD`；登录会话默认保持 12 小时，未登录时页面、静态资源和功能 API 都不会返回内容。站长/管理是**独立**的一套账号，使用 `OWNER_USERNAME` + `OWNER_PASSWORD` 登录（管理员登录需要账号和密码）；访客登录后只能浏览页面与功能，不能进入管理界面。

功能中心通过 `GET /api/features` 读取功能目录。页面入口、导航和服务端路由都来自 `config/features.js`，不会把内部文件路径返回给浏览器。

功能中心右上角的“功能中心”在 2.6 秒内连续点击 4 次会打开隐藏的站长入口。它使用独立的管理账号（`OWNER_USERNAME`）与管理密码（`OWNER_PASSWORD`）登录，与访客账号互不通用；登录后可以查看匿名浏览器的主页访问和功能打开记录、填写访客称呼与备注、发布公告、修改卡片标题/说明/重点/强调色，并可在“账号设置”里分别修改访客账号密码和管理员账号密码。详细操作见本机的 `OWNER-ACCESS.txt`。

主页展示设置保存到 `data/portal-settings.json`，访问活动保存到 `data/portal-activity.json`。服务端会在访客实际请求 `/home` 或已注册功能页面时记录活动，并用 HttpOnly Cookie 分配匿名浏览器 ID；该标识不等同于真实身份。动态设置只覆盖公开展示字段，不会改变 `config/features.js` 中固定的 `path` 或服务器内部 `entry`。

两个独立功能各自使用命名空间 API 和数据文件：

- 七夕星空情书：`/api/love-stars/message`，数据保存到 `data/love-stars-messages.json`。
- 严格教育现场：`/api/wrong/hit` 与 `/api/wrong/stats`，数据保存到 `data/wrong-counter.json`。

它们不会调用或覆盖星星瓶原有的 `/api/message`、`/api/hit` 数据。敲打统计接口使用统一的 `OWNER_PASSWORD`（或 `data/settings.json` 中的主人密码），不会复制外部项目的密码或 `state.json`。

## 新增功能

1. 在 `public/<feature-id>/` 下新增独立页面，例如 `public/my-tool/index.html`，以及它需要的脚本、样式和素材。页面资源使用根绝对路径，避免 `/tool` 和 `/tool/` 的尾斜杠造成相对路径差异。
2. 在 `config/features.js` 增加一项：

   ```js
   {
     id: "my-tool",
     title: "我的工具",
     description: "一句简短说明。",
     icon: "◇",
     path: "/my-tool",
     entry: "/my-tool/index.html",
     order: 20,
     enabled: true,
   }
   ```

3. 运行 `npm test`，确认注册表校验、页面路由和原有星星瓶功能都通过。

注册后，功能会自动出现在 `/home` 和站长的“主页设置”中，不需要为每个新功能再修改门户脚本或增加服务端路由分支。

`id`、`path` 和 `entry` 必须唯一；`path` 不能使用 `/api`、`/home`、`/portal`、`/vendor`、`/music`、`/pet` 等保留前缀；`enabled: false` 会同时隐藏入口并阻断页面及其目录资源直达。服务端还会校验注册入口的真实路径仍位于 `public/` 内。

## 目录结构

```text
config/features.js       功能注册表（新增功能从这里接入）
lib/feature-registry.js   注册表校验与公开数据投影
lib/portal-state.js       主页设置和访问活动的数据校验
public/portal/            功能中心页面、样式和脚本
public/index.html         星星瓶页面（保留根级资源兼容路径）
public/love-stars/        七夕星空情书页面及资源
public/wrong/             严格教育现场页面、Matter.js 和图片资源
data/love-stars-messages.json  七夕留言运行数据（不提交）
data/wrong-counter.json        敲打统计运行数据（不提交）
data/portal-settings.json      主页公告、卡片覆盖和访客备注（不提交）
data/portal-activity.json      主页访问与功能打开记录（不提交）
test-portal.js             门户与注册表测试
test-portal-admin.js       主页访问记录和站长管理测试
test-love-stars.js         七夕功能/API 测试
test-wrong.js              严格教育现场/API 测试
```

## 本地运行

先在项目上一级目录双击 `PULL-SERVER-DATA.cmd`，把服务器数据下载到 `server-data\from-server`。然后双击本目录的 `START-LOCAL.cmd`，浏览器访问 `http://localhost:8787/home`。

本地服务只读写下载的数据副本，不会直接修改云服务器。需要把本地数据传回服务器时，再运行 `PUSH-SERVER-DATA.cmd`。前端代码和音乐文件不需要编译，修改后刷新浏览器即可；修改 `server.js` 后需要关闭并重新运行本地服务。

## 启动公网网站

双击 `START-PUBLIC.cmd`。首次启动会自动下载固定版本的 Three.js 和 Cannon ES，然后显示：

```text
Public URL: https://...trycloudflare.com
```

将这个网址发给其他电脑即可访问。公网网址每次重新启动连接时可能变化。

停止网站时双击 `STOP.cmd`。

## 纸条内容

所有 400 条纸条都在 `data/notes.json`，每种情绪各 100 条。只修改每条记录的 `text` 内容即可；网站运行时保存文件，所有在线访问者会自动收到更新。

## 主人编辑入口

详细入口和密码位于本机的 `OWNER-ACCESS.txt`。该文件和 `data/settings.json` 不会通过网站公开。

主人后台可以修改纸条文字、情绪属性和单颗星星颜色，也可以查看星星打开记录。“宝宝！！”是默认不出现的淡蓝色特殊状态，设置后会排在橙色星星左边。另有一个可自定义名称、颜色及左右位置的状态；至少设置一颗后才会显示对应气泡。记录使用服务器时间，并在后台显示为北京时间。

任何成功进入过主人后台的浏览器都会加入“主人设备”名单。名单内设备打开星星时不会生成访客记录；从名单移除后会恢复记录。

## 收藏方式

收藏保存在服务器的 `data/favorites.json`。任意设备收藏或取消后，所有在线设备会自动更新；旧浏览器中已有的本地收藏会在首次打开新版网站时迁移一次。

迁移到其他服务器时，请一起保留整个 `data` 文件夹，其中包含纸条、收藏、打开记录、主人设备名单、主页公告与访客备注，以及两个独立功能的留言和敲打统计。

## 运行条件

- 运行网站的电脑需要保持开机，并保持网站和公网连接进程运行。
- 电脑关机或休眠后网站会离线；重新建立临时公网连接后，公网网址可能变化。
- 若需要电脑关机后仍长期在线，需要部署到云服务器或长期通电的设备。
- 首次启动需要联网下载约定版本的 3D 与物理引擎，之后从本地文件加载。
- 任何拿到公网网址的人都能阅读纸条，请不要写入敏感信息。

## 云服务器部署

项目已附带 `ecosystem.config.cjs`、`.env.example`、`start-linux.sh` 和 `BAOTA-DEPLOY.md`。部署到宝塔时使用 Node.js 20/22 + PM2 + Nginx 反向代理，不需要上传 `cloudflared.exe`。详细步骤请查看 `BAOTA-DEPLOY.md`。

代码更新时，在服务器仓库根目录执行：

```bash
cd /www/wwwroot/qe-star-bottle
bash shared-board/deploy-server.sh
```

`PUSH-SERVER-DATA.cmd` 只同步运行数据，不会上传网页或服务端代码。
