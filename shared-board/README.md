# 圆圆和QE的星空小铺

一个包含多个功能入口的网站。`/home` 是功能中心；普通访问者可以从这里进入星星瓶、七夕星空情书和严格教育现场。星星瓶仍保留原有纸条、收藏和主人编辑能力。

## 网站入口

- `http://localhost:8787/`：重定向到功能中心。
- `http://localhost:8787/home`：选择要进入的功能。
- `http://localhost:8787/star-bottle`：星星瓶。
- `http://localhost:8787/love-stars`：七夕星空情书。
- `http://localhost:8787/wrong`：严格教育现场。
- `http://localhost:8787/envelopes`：信封记录（一格一个信封，打开就是一个能写字、贴图的备忘录）。

首次打开会先进入登录页，账号分两级，都在同一个登录框里输入。**用户级**是 `SITE_USERNAME` + `SITE_PASSWORD`（默认 `Yuna`），能打开全部页面、静态资源和功能 API；**管理员级**是 `OWNER_USERNAME` + `OWNER_PASSWORD`（默认 `QbaiW`），权限上包含用户级的全部功能，另外还能进入管理后台。登录会话默认保持 12 小时，未登录时页面、静态资源和功能 API 都不会返回内容。用管理员账号登录站点时，服务端会同时下发管理会话（两个 Cookie：`star_bottle_access` + `star_bottle_owner`）；用户级账号拿不到管理会话，`/api/owner/*` 一律 401。

功能中心通过 `GET /api/features` 读取功能目录。页面入口、导航和服务端路由都来自 `config/features.js`，不会把内部文件路径返回给浏览器。

管理后台有两个入口：主页右上角在管理员登录后会显示「管理后台」按钮（`#ownerEntry`，来自 `GET /api/owner/status` 的结果）；功能中心右上角的“功能中心”在 2.6 秒内连续点击 4 次是保留下来的隐藏入口。两者打开同一个管理面板，用管理员账号（`OWNER_USERNAME`）+ 管理密码（`OWNER_PASSWORD`）登录；登录后可以查看匿名浏览器的主页访问和功能打开记录、填写访客称呼与备注、发布公告、修改卡片标题/说明/重点/强调色，并可在“账号设置”里分别修改用户账号密码和管理员账号密码。详细操作见本机的 `OWNER-ACCESS.txt`。

> 修改过的账号密码保存在 `data/settings.json`，且**优先于 `.env` 里的同名配置**——后台改完重启后仍然生效。如果忘记密码，需要在服务器上直接编辑或删除 `data/settings.json`，或通过后台改回；仅修改 `.env` 不会覆盖已保存的值。

主页展示设置保存到 `data/portal-settings.json`，访问活动保存到 `data/portal-activity.json`。服务端会在访客实际请求 `/home` 或已注册功能页面时记录活动，并用 HttpOnly Cookie 分配匿名浏览器 ID；该标识不等同于真实身份。动态设置只覆盖公开展示字段，不会改变 `config/features.js` 中固定的 `path` 或服务器内部 `entry`。

三个独立功能各自使用命名空间 API 和数据文件：

- 七夕星空情书：`/api/love-stars/message`，数据保存到 `data/love-stars-messages.json`。
- 严格教育现场：`/api/wrong/hit` 与 `/api/wrong/stats`，数据保存到 `data/wrong-counter.json`；气泡内容通过 `/api/wrong/phrases` 读写，保存到 `data/wrong-bubbles.json`。
- 信封记录：`/api/envelopes`（列表/新建）与 `/api/envelopes/<id>`（修改/删除），数据保存到 `data/envelopes.json`；图片通过 `POST /api/envelopes/image` 上传，落到 `public/envelopes/uploads/`，接口返回的地址再写进信封内容。

严格教育现场页面右上角的 `YY` 按钮会打开它的管理面板（输入管理密码）：除了敲打统计，还有一个「气泡内容」编辑框——**每行一条**，直接修改或新增一行再保存，就能改掉/新增敲打时冒出的气泡文案，保存后立即生效。首次运行时气泡内容会从 `public/wrong/phrases.txt` 播种一份默认值。

它们不会调用或覆盖星星瓶原有的 `/api/message`、`/api/hit` 数据。敲打统计与气泡内容接口使用统一的 `OWNER_PASSWORD`（或 `data/settings.json` 中的主人密码），不会复制外部项目的密码或 `state.json`。

信封记录打开一格先是**阅读视图**：主标题、副标题、正文和 Markdown 混排，Markdown 会渲染成标题/列表/引用/代码/粗体。点右上角「编辑」才进入编辑，段落格式在 正文 / Markdown / 主标题 / 副标题 之间随时切换，「＋ 文字」「＋ 图片」增删段落，图片先在浏览器里压到长边 1600 再上传，最后点「保存」。看板卡片用第一张图或前几行文字当封面，登录后任何访客都能编辑这些信封。

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
public/login.html         站点登录页（用户级 / 管理员级共用）
public/favicon.png        网站图标（64×64，另有一张 favicon-180.png 供苹果/主屏）
public/love-stars/        七夕星空情书页面及资源
public/wrong/             严格教育现场页面、Matter.js 和图片资源
public/envelopes/         信封记录看板与备忘录编辑器（uploads/ 放上传的图片，不提交）
data/notes.json           纸条内容（不提交）
data/favorites.json       收藏（不提交）
data/activity.json        星星打开记录（不提交）
data/owner-devices.json   主人设备名单（不提交）
data/settings.json        用户级/管理员级账号密码与会话时长（不提交）
data/love-stars-messages.json  七夕留言运行数据（不提交）
data/wrong-counter.json        敲打统计运行数据（不提交）
data/wrong-bubbles.json        教育现场气泡文案，管理员可改（不提交）
data/portal-settings.json      主页公告、卡片覆盖和访客备注（不提交）
data/portal-activity.json      主页访问与功能打开记录（不提交）
data/envelopes.json            信封记录内容（不提交）
test-auth.js               鉴权与主人编辑测试
test-site-auth.js          站点登录门与两级账号测试
test-portal.js             门户与注册表测试
test-portal-admin.js       主页访问记录和站长管理测试
test-love-stars.js         七夕功能/API 测试
test-wrong.js              严格教育现场/API 测试
test-envelopes.js          信封记录/API 测试
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

迁移到其他服务器时，请一起保留整个 `data` 文件夹，其中包含纸条、收藏、打开记录、主人设备名单、主页公告与访客备注，以及各独立功能的留言、敲打统计和信封记录；信封里的图片在 `public/envelopes/uploads/`，也要一起带走。

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
