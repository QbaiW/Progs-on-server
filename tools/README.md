# tools/ —— 3D 资产工具链

给以后改这套东西的人（包括 AI）看的：这个目录**不是运行时渲染模块**，是一套离线
「程序化几何 → glTF 2.0 二进制(.glb)」的批处理工具。生成出来的 .glb 被手动上传到
Hyperfy 世界的 `assets/` 里，再由数据库里的蓝图/实体指向它。

一句话链路：

```
island-terrain.mjs（纯高度函数，无副作用）
   ├── make-forest.mjs ─┐
   ├── make-island.mjs ─┤
   ├── make-house.mjs ──┼──→ mesh-builder.mjs ──→ <sha256>.glb ──scp──→ /www/wwwroot/hyperfy/<world>/assets/
   └── make-boat.mjs ───┘
   └── find-*.mjs / check-*.mjs（只读高度，不出模型）

服务器：db.sqlite
   blueprints(id, data)  data.model = "asset://<sha>.glb"、data.script = "asset://<sha>.js"、data.props
   entities(id, data)    data.blueprint、data.position、data.quaternion
   config(key, value)    spawn = {position, quaternion}
运行时：Hyperfy 服务端（PhysX 碰撞）+ 客户端 three 加载 GLB，
        glbToNodes 把节点 extras.node 映射成 collider / rigidbody。
```

工具链里**没有任何文件 import three 或 cannon**：`mesh-builder.mjs` 手写 glTF 的
bufferView/accessor，只用 `node:fs` / `node:path` 落文件。three 与 cannon-es 只存在于
浏览器端 `shared-board/public/scene.js`（星空瓶那几个页面），和这里的生成器无关。

## 文件职责

### 数学与几何
| 文件 | 职责 |
| --- | --- |
| `island-terrain.mjs` | 岛屿地形的**唯一事实来源**。导出 `TERRAIN`、`fbm`、`smoothstep`、`heightAt(x,z)`、`normalAt`、`slopeDeg`。纯函数，被 `make-island` / `make-forest` / `find-boat-spot` / `find-house-spot` / `check-house-site` / `check-boat-slide` 六处引用。 |
| `mesh-builder.mjs` | `createMeshBuilder()` → `addQuad` / `addTri` / `addBox` / `addRotBoxX` + `writeGlb`。按材质分桶，每个材质输出一个 primitive。绕序由「期望外法线」反推，不用手点三角形。更复杂的形状（松树的锥、船的弧面）由各生成器在自己的文件里用这几个基本块拼。 |

### 生成器（都输出 .glb）
| 文件 | 产出 |
| --- | --- |
| `make-island.mjs` | 雪顶小岛：单峰雪山 + 环岛浅滩 + 海底。世界二在用它。 |
| `make-forest.mjs` | 森林小岛：同一套高度场压平（`5.5*tanh(raw/15)`）+ 594 棵松树 + 篝火石圈 + 水面。世界一在用它。 |
| `make-house.mjs` | 两层小屋：门廊、护窗板、地基、壁炉、家具。视觉网格（15 个材质）+ 独立碰撞网格。 |
| `make-boat.mjs` | 小船：船体视觉（Hull / Tar / Trim 三种材质）+ 独立碰撞网格 `BoatBody`。 |

### 校验器
| 文件 | 查什么 |
| --- | --- |
| `glb-validate.mjs` | glTF 2.0 规范：chunk/对齐、bufferView、accessor、每个 primitive 自己的索引上限、场景节点引用、禁用扩展。 |
| `check-house.cjs` | 行为：门洞射线 20 条全通、门口净空、一二层地面采样、13 级楼梯接平、零面积/重复三角形、共面重叠。 |
| `check-boat.cjs` | 船体对真实碰撞网格打射线（蹭底/吃水）。 |
| `check-boat-slide.mjs` | 离线复刻 `boat.js` 的「走位 + 搁浅绕行」逻辑，密采样沿岸跑一圈。 |
| `find-boat-spot.mjs` / `find-house-spot.mjs` / `check-house-site.mjs` / `check-house-fit.mjs` | 选点与摆放高度。 |
| `glb-stats.mjs` | 体量统计：draw call（= primitive 数）、渲染三角形、材质、`extras.node` 标记、碰撞体是否单 primitive。**改完资产用它拿数，别猜。** |
| `check-panel-auth.mjs` / `check-skin-page.cjs` | 和 3D 无关：世界管理面板鉴权分支、皮肤页链接。 |

### 入库脚本（在服务器上跑，`better-sqlite3` 装在服务器 node_modules 里）
`forest-update.cjs`（世界一：$scene + 搬小屋 + 出生点）、`house-update.cjs`（两世界的
小屋蓝图换模型）、`boat-update.cjs` / `boat-v2-update.cjs`（船蓝图换脚本与 props）。
统一套路：先确认 `assets/<sha>.glb` 存在 → 改一行值 → 打印改动前后。

### 世界内脚本（上传成 `<sha>.js`，由蓝图 `script` 指向）
`scene-forest.js`（森林：天空/雾/篝火粒子）、`scene-island.js`（雪顶岛：降雪）、
`boat.js`（小船 v3：一个 E 键两种玩法）。这些跑在 Hyperfy 的沙箱 app 里。

### 其它
`render-house.mjs`（零依赖软件光栅器，把 GLB 渲成 PNG）、`vrm-*.cjs` /
`fix-vrm-root.cjs`（VRM 皮肤排查）、`boat-diag.js`（临时诊断，用完即弃）、
`sync-server-data.ps1`（运行数据 PULL/PUSH）。

## Hyperfy 的硬约束（改资产前必读）

1. **碰撞体必须「单个 primitive、不带材质」**。
   `src/core/extras/glbToNodes.js:73` 的判断是 `else if (props.node === 'collider' && object3d.isMesh)`；
   同一文件的注释（74–76 行）写明：一个带多材质的物体导出后会被 GLTFLoader 拆成 Group + 每材质一个 Mesh，
   标记落在 Group 上 `isMesh === false`，**碰撞体会静默地不存在**。
   所以房子是两块网格：`HouseVisual`（多材质）+ `HouseBody`（单 primitive 无材质）。
2. **索引是 Uint16**，任何一条 POSITION accessor 的顶点数必须 ≤ 65535
   （`mesh-builder.mjs:21`）。超了就只能拆网格——森林因此把地形与植被分成两块网格。
3. **不要用扩展**。Hyperfy fork 的 `GLTFLoader` 里虽然有 66 处 `KHR_` 引用，但
   `glbToNodes` 只认自家的 `extras.node` 结构；`EXT_mesh_gpu_instancing` 之类会改变场景图形态，
   没验证过。校验器直接按「有扩展就报错」处理。
4. **没有 light 节点**。屋里唯一能亮的东西是 emissive 材质（壁炉 `Ember`、灯 `Lamp`），
   值必须 ≤ 1，否则要么溢出要么得加扩展。
5. **不用外部贴图**。材质只有 PBR 因子（baseColor / metallic / roughness / emissive / alphaMode），
   玻璃和水用 `alphaMode: 'BLEND'`。
6. **共面同朝向面会 z-fighting，零面积三角形会让 PhysX 报警**：`addGable` 的 `TUCK = 0.012`、
   `check-house.cjs` 的平面分组检查就是为这两条存在的。
7. **场景脚本跑在沙箱里**：`world` 是白名单代理，给 `world.network.isServer` 赋值会整屏黑掉
   （真实事故）；地形碰撞体是异步加载的，脚本刚启动时向下打射线会返回 999，要等约 3 秒。
8. **Model app 的 `props.collision = false`** 表示「用 glb 里嵌入的碰撞体」，不要再另配碰撞。

## 当前实测体量（2026-10-20，`node tools/glb-stats.mjs`）

| 资产 | 体积 | 渲染 draw call | 渲染三角形 | 最大两项 |
| --- | --- | --- | --- | --- |
| 世界一 森林 `dc7b8733…glb` | 3.80 MB | 11 | 134,074 | Sand 55,038 · Water 54,126（占 81%） |
| 世界一 小屋 `a161d944…glb` | 0.30 MB | 15 | 4,192 | Wood 972 · Wall 772 · Stone 708 |
| 世界二 雪顶岛 `3444c4df…glb` | 2.46 MB | 6 | 116,086 | Sand 55,167 · Water 54,126 |
| 世界二 小船 `de9d7359…glb` | 0.02 MB | 3 | 186 | Hull 78 · Tar 56 · Trim 52 |

两处容易读错的数字：

- **碰撞体不算渲染成本**。地形碰撞网格是 61,952 个三角形，只喂 PhysX，不画。
- **顶点是每个材质各存一份**：地形 31,329 个顶点在 4 个材质 band 里重复了 4 次
  （`mesh-builder` 按材质分桶），所以森林总计 457,810 个顶点。这个量级还不痛，但别再往上加材质。

结论（要优化就先动这两块，别动树）：

- 水面是**纯平面**，却按 176×176 网格铺了 54,126 个三角形——换粗网格能省 5 万面，视觉无差。
- 沙面 55,038 面里很大一部分在**水下**（水面是 `BLEND` 半透明，近岸看得见、深处其实看不见），
  按深度裁掉深水区能再省数万面。
- 松树 17,820 面 / 594 棵 = 30 面一棵，小屋 4,192 面：都不是瓶颈。

## 加一个新资产的标准流程

1. 写生成器：`import { createMeshBuilder } from './mesh-builder.mjs'`，用 `addBox` / `addQuad` 之类组装，
   别忘了 `extras.node = 'collider'` 的那块要单 primitive、无材质。
2. `node tools/glb-validate.mjs out.glb`（规范）+ 对应的 `check-*.cjs`（行为）。
3. `node tools/glb-stats.mjs out.glb` 看 draw call / 三角形 / 碰撞体标记是否还合理。
4. 传资产：文件名必须是 **sha256 + 扩展名**，`scp` 到 `/www/wwwroot/hyperfy/<world>/assets/`。
5. 改数据库：写/复用 `*-update.cjs`，**先 `cp db.sqlite /root/<world>-db-<时间戳>.sqlite`**，
   再 `pm2 restart <app>`。
6. 看日志：`/root/.pm2/logs/hyperfy-out-1.log`（世界一）、`hyperfy-world2-out-2.log`（世界二），
   错误看同名 `-error-*.log`。**不要 `tail` 整份日志**（里面有二进制垃圾），用 `grep -a` 且限量。

## 明确不做的事（防止重复提错方案）

- **不在 tools 里引入 three**：生成器是离线 glTF 写出器，没有渲染器；把 `PlaneGeometry` /
  `MeshStandardMaterial` 搬进来会丢掉按高度分层的地形材质，还会把「可校验的二进制产出」
  换成「需要浏览器才能看到的运行时对象」。
- **不用 InstancedMesh / 实例化扩展**：静态 .glb 里没有这个概念，等效的
  `EXT_mesh_gpu_instancing` 走的是未验证的加载路径；而且树早就合并成 2 个 primitive（Trunk / Needles）。
- **不建 `CANNON.Heightfield`**：世界里的物理是 Hyperfy 服务端的 PhysX trimesh，
  cannon-es 只服务星空瓶那个网页。
- **不预先抽象**：世界一那版压平高度（`5.5*tanh(raw/15)`）目前只住在 `make-forest.mjs` 里。
  等真有第二个消费者（比如给世界一算泊位）再抽成 `island-shape.mjs`，现在不抽。

## 本机操作的两个坑

- **Windows 的 ssh 会吃掉远端命令里的 `|` 和 `"`**：`grep -E "a|b"`、`pm2 list | grep` 都会裂开。
  可靠做法是把命令写进 `.sh` 文件 `scp` 上去再 `bash`，或者只把原始输出拉回本地过滤。
- **PowerShell 双引号里的 `$(date ...)` 会在本机执行**：远端命令用单引号包整条，或写进 .sh。
