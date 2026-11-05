# 03 · Web 客户端模块图：构建时机、漏检条件、能否不重启重建

> 一句话答案：**不能**。`clientModules.clientPath(id)` 为 null 时，唯一的补行入口是「Loader 行重新构造 → 增量 flush」，而解析结果（含**否定结论**）被按 `(baseUrl, loaderName)` 在进程内存里缓存到重启为止；刷新页面、HMR、删缓存文件都改变不了它。可靠修复只有重启宿主。
>
> 证据主文件：`app.asar/dsh/node_modules/@deepseek-ai/dsh-client-modules/lib/index.js`（受检版本 **0.2.1-rc.5**，1000 行，本次全量读完，下文简写 `cm:`）。
> 契约来源：`cordis_inspect_query(platform="host", provider="Service", input={service:"clientModules"})`。
> 时间线来源：profile 目录时间戳、`Get-Process StartTime`、本仓库 `git log`。

---

## 0. 结论先行（三个问题各自答案）

| 问题 | 结论 | 依据 |
| --- | --- | --- |
| 表怎么建 | 扫的是**活跃 Loader 行**，不是 profile `package.json` 的依赖，也不是磁盘 `node_modules`。增量、无全量重扫 | `cm:115`、`cm:558`、`cm:854` |
| 什么情况下漏 | 11 条判据；本机命中的最可能是**解析否定缓存放过了头**：包首次被扫到时 `package.json` 还没有 `dsh.client` | `cm:121-122`、`cm:722-736` |
| 能否不重启重建 | **不能（无公开触发点）**。`rebuilt(id)` 只服务已在表里的 id；`onGraphChanged/onRebuilt` 是通知不是触发器；无磁盘缓存可删 | `cm:625-627`、`cm:649-666` |

---

## 1. 表是怎么建的

### 1.1 扫描对象 = 活跃 Loader 行

`ClientModuleRegistry`（`static inject = ["loader"]`，`cm:513-514`）在构造时把 `ctx.loader.entries()` 的**行名**塞进 dirty 集（`cm:558`），flush 时再对每个行名重新查一遍 `ctx.loader.entries()`，只接受：

```js
for (const entry of this.ctx.loader.entries()) {
  if (entry.options.name !== entryName || entry.fiber === void 0 || entry.disabled) continue;  // cm:855
  const source = this.resolveSource(entry);                                                    // cm:856
```

即：**行存在 + 行名匹配 + fiber 已构造 + 未被 disabled**。磁盘上 `node_modules` 里躺着一个包但没被 Loader 挂载，等于不存在。
（本机这条成立：profile `dsh.profile.bundles` 里有 `dsh-mini-superagent`，其自带 `cordis.patch.yml` 插入行 `id/name = dsh-mini-superagent`；`cordis.patch.yml` 的 Config 目录里能看到 `include:dsh-mini-superagent`，且 host 半边的工具在跑。）

### 1.2 增量模型：没有全量重扫

- `cm:115`：`Scanning is incremental per package — there is no full-rescan code path.`
- `cm:117-120`：每次 cordis `internal/plugin`（fiber 构造/销毁）只把该 fiber 的 `entry.options.name` 标脏，`queueMicrotask` 合批 flush。
- `cm:545-557`：订阅 + 合批；`cm:558-562`：构造期先 seed 全部行、同步 flush 一次（首次扫描与稳态共用同一实现）。

### 1.3 一行 → 一条图的调用链

1. `processOne(entryName)`（`cm:852`）：重算该行名对应的所有活跃 source，再对受影响包调 `reconcilePackage`。
2. `resolveSource`（`cm:877`）：行名 → `resolveSource(entry)`，取 `baseUrl = entry.parent.tree.ctx.baseUrl`（缺则抛错，`cm:880`）。
3. `resolveMeta(loaderName, baseUrl)`（`cm:720`）：**先查缓存** `pkgMeta`（`cm:722-723`）；未命中则用 `ctx.loader.internal.resolveSync` 解析行名 → `nearestPackage` 找最近的、`name` 与包名一致的 `package.json`（`cm:762-809`）→ 读 `dsh.client` → `platform` 必须严格 `=== "web"`（`cm:733`）→ 必须有 `exports["./client"]`（缺则**抛错**，不是返回 null，`cm:737-738`）。
4. `reconcilePackage`（`cm:890`）：同一 `sourceKey` 已存在则跳过（`cm:899`）；否则 `initialBundleSnapshot`（`statSync` + `readFileSync`，`cm:830-841`）→ `this.table.set(packageName, …)`（`cm:902`）。**表键是 manifest 里的 `name`，不是行名**。
5. `flush`（`cm:912`）：任一包变了才 `compose()`（`cm:667`）→ 换 `this.composed` → `notifyGraphChanged()`（`cm:930-931`）。

### 1.4 图怎么到浏览器

构造期注册 `webserver/index-inject`，每次渲染 index 时把 `bootInjections(this.composed)` 推进注入表（`cm:571-573`），其中最后一行是 `name: "__DSH_BOOT__", value: graph`（`cm:499-503`）。注意：**注入行是「每请求现算」，但读的是 `this.composed` 这个进程内快照**；`composed` 只在 `flush`/`rebuilt` 里被替换。所以刷新页面拿到的一定还是旧图。

### 1.5 三段关键代码（读实现时最该盯的）

```js
// (A) 唯一的增/删行入口，且是「按行名」而不是「按包」 —— cm:852-876
processOne(entryName, onError) {
  const nextSources = new Map();
  for (const entry of this.ctx.loader.entries()) {
    if (entry.options.name !== entryName || entry.fiber === void 0 || entry.disabled) continue; // cm:855
    const source = this.resolveSource(entry);
    ...
```

```js
// (B) 否定结论被缓存 —— cm:720-736
resolveMeta(loaderName, baseUrl) {
  const sourceKey = this.sourceKey(loaderName, baseUrl);        // baseUrl\0loaderName
  const cached = this.pkgMeta.get(sourceKey);
  if (cached !== void 0) return cached;                         // cm:722-723  ← null 也算命中
  ...
  if (decl === void 0 || decl.platform !== "web") {
    this.pkgMeta.set(sourceKey, null);                          // cm:734  ← 永久否定
    return null;
  }
```

```js
// (C) 只有「表变了」才重组合 —— cm:912-932
flush(onError) {
  let changed = false;
  for (const entryName of [...this.dirty]) { this.dirty.delete(entryName); if (this.processOne(entryName, onError)) changed = true; }
  if (!changed) return;                                          // cm:922  ← 缓存命中即在这里退出
  composed = this.compose(); ... this.composed = composed; this.notifyGraphChanged();
```

三者串起来就是本机的死结：行事件有 → `processOne` 有 → 但 `resolveMeta` 吃缓存 → `changed=false` → 不组合、不通知、页面永远看不到。

### 1.6 时序（文本图）

```
宿主启动
  └─ ClientModuleRegistry 构造 (cm:537)
       ├─ ctx.on("internal/plugin") 订阅                         cm:545
       ├─ seed: loader.entries() 全部行名 → dirty                cm:558
       └─ 同步 flush #1                                         cm:561
            └─ 每个行名 processOne → resolveMeta → pkgMeta 写入 ← 本机 13:02:38 就在这里把「无 dsh.client」写死
后续任一 fiber 构造/销毁
  └─ dirty.add(entryName) → queueMicrotask → flush
       └─ resolveMeta 命中 pkgMeta（null）→ changed=false → return  ← 无 compose、无 index 注入变化
页面每次 GET /
  └─ webserver/index-inject → bootInjections(this.composed)      cm:571-573  ← 读旧快照
```

---

## 2. `clientPath(id)` 返 null 的完整条件清单

`clientPath` 只有一句：`return this.table.get(id)?.meta.clientPath`（`cm:587-589`）。没有记录 → undefined。要不再出现记录，只能是以下之一：

### 2.1 清单

| # | 条件 | 判据（行号） | 本机是否踩中 |
| --- | --- | --- | --- |
| 1 | 没有活跃 Loader 行（未挂载 / `fiber === undefined` / `disabled`） | `cm:855` | 否（host 半边在跑，Config 目录有该行） |
| 2 | 行名不是「裸包名」也不是「路径式」：子路径 `pkg/sub`、`cordis:`、`node:`、URL 一律跳过 | `cm:83-89`、`cm:763-766` | 否（`name: dsh-mini-superagent`） |
| 3 | 所属树没有 `baseUrl` → 抛错，行永久补不进 | `cm:880` | 否（同树其它 bundle 行正常） |
| 4 | `package.json` 无 `dsh.client` 对象 | `cm:732-736` | **曾踩中**（见 2.2） |
| 5 | `dsh.client.platform !== "web"`（严格等于，大小写敏感） | `cm:733` | 否 |
| 6 | 有 `dsh.client` 但缺 `exports["./client"]` → **抛错**（启动期会变 FAILED fiber，而不是静默 null） | `cm:737-738` | 否（exports 有） |
| 7 | bundle 文件读不到（ENOENT）→ `MissingClientBundleError`，稳态只 warn，行不落地；下一轮 flush 会重试，**不会**污染缓存 | `cm:830-841` | 否（文件 18:43:38 已落盘） |
| 8 | **解析结论被缓存**：`pkgMeta` 命中直接返回，**否定结论也是缓存**，键是 `baseUrl\0loaderName` | `cm:722-723`、`cm:726/734`、`cm:810-812`、`cm:121-122` | **最可能** |
| 9 | 同一包被两个活跃 source 解析到 → 抛「multiple active Loader sources」，两边都进不去 | `cm:893-896` | 否（只有一个行） |
| 10 | 调用 id 与 manifest `name` 不一致（表键是 manifest name） | `cm:902-903` | 否（两者一致） |
| 11 | 包在 `dependencies` 里但不在 `dsh.profile.bundles` 里 → 压根没有行 | profile `package.json`（`dsh.profile.bundles` 含 `dsh-mini-superagent`） | 否 |

补充：`dsh.client.inject` 只原样透传给浏览器（`cm:743`），**不参与**宿主侧判定——它坏不坏都不影响 `clientPath`，只会影响页面侧能不能挂上。本次已核实注入目标真实存在（`@deepseek-ai/dsh-client-ui-sidebar` 的 `dsh.client` 声明可读，`dsh-client-ui-layout` 为其 peer/dev 依赖）。

### 2.2 本机最可能的成因（时间线）

| 时间 | 事件 | 证据 |
| --- | --- | --- |
| 10:12:28 | 宿主主进程启动，**至今未重启** | `Get-Process` StartTime |
| 13:02:29 | profile 装成 link 依赖（`node_modules/dsh-mini-superagent` 符号链接创建） | 符号链接 CreationTime |
| 13:02:38 | host 半边激活、建状态目录 → **该时刻行第一次被 client-modules 扫到** | `.dsh/dsh-mini-superagent` CreationTime |
| 13:14:30 | 提交 `4de0af4` 改名 `dsh-mini-superagent`；`git show 4de0af4:dsh-mini-superagent/package.json` **没有** `dsh.client` 块 | git |
| 13:56:11 | 提交 `9d7a75d` 才加入 `dsh.client` + `client/index.js` | `git show --stat 9d7a75d` |
| 18:43:38 | 当前 `client/index.js` 字节落盘 | mtime |
| 18:45:25 | profile `package.json`/`pnpm-lock.yaml` 被 pnpm 重写（行会被 reconcile 重挂一次） | mtime |

推论：**首次扫描发生在 client 半边存在之前**，`resolveMeta` 走到 `cm:733` 的「decl 为 undefined」分支，执行 `this.pkgMeta.set(sourceKey, null)`（`cm:726`）。此后再发生多少次行重挂（改名、pnpm 重装、disable/enable），`processOne` 都会在 `cm:722-723` 直接命中这个 `null`——`dsh.client` 后来的出现对它不可见，因为**缓存语义是「进程生命周期内有效」，注释原文即 `cached per Loader specifier and owning-tree base URL until restart`（`cm:121-122`）**。

替代解释（无法排除）：13:56 之后该行**一次 fiber 事件都没发生过**，所以始终没人去 reconcile。这与观察一致但更弱——任务背景里已经做过 disable/enable，若那次确实发生在 13:56 之后，则「否定缓存」已被事实确认。

### 2.3 我卡在哪 / 缺什么

- `pkgMeta` **没有公开读接口**（Service 契约只有 `graph/clientPath/fetchBundle/artifactBaseline/rebuilt/onRebuilt/onGraphChanged`）。我无法直接证明 `null` 被缓存，只能由代码路径 + 时间戳反推。
- 我没有跑可控实验（任务约束：不改配置、不重启、不 toggle）。
- 我不知道那次 disable/enable 的准确时间（无宿主日志：`.dsh` 下没有 log 目录，`AppData\Roaming\DeepSeek Harness` 不存在）。

**一次 30 秒的判定实验**（需要 Lead 做，我不动手）：现在做一次 plugin 行 disable→enable，然后 `GET /dsh-mini-superagent/board/selfcheck`（`src/dispatch.js:513-557`，读 `client.inGraph` 与 `client.probes`）。
- 变 true → 成因是「事后没有 fiber 事件」，toggle 就是修法；
- 仍为 false 且 `probes` 里其它包正常 → **否定缓存**确认，必须重启。

---

## 3. 能不能不重启就重建

### 3.1 只有两个写入点，都不解决问题

| 入口 | 能做什么 | 对本例 |
| --- | --- | --- |
| `internal/plugin` → dirty → `flush()`（`cm:545-557`、`cm:912`） | 增/删/改表行，然后 `compose()` | 会 flush，但 `resolveMeta` 吃缓存 → 无变化 |
| `rebuilt(id)`（`cm:625-643`） | 只更新**已存在**记录的 rev 并重组合 | `this.table.get(id)` 为 undefined → 直接 `return undefined`（`cm:626-627`） |

通知面是单向的：`onRebuilt`（`cm:649-654`）、`onGraphChanged`（`cm:661-666`）只把 id/空参回调给订阅者，**没有任何方法能反向要求重建或重扫**。`graph()` 返回的是 `this.composed` 这个稳定对象（`cm:579-581`）。

### 3.2 那些「看起来能救」的路，逐条排除

- **刷新页面 / 重开浏览器 tab**：`__DSH_BOOT__` 来自 `this.composed`（`cm:571-573`），`composed` 只在 flush/rebuilt 时换（`cm:559`、`cm:635`、`cm:930`）。无效。
- **HMR**：只针对**表里已有的 id** 装 watch（`artifactBaseline` 的用途见 `cm:606-617`），并通过 `rebuilt(id)` 发布；表里没有的 id，HMR 连 watch 都不会装，`rebuilt` 也返回 undefined。无效。
- **删某个缓存 json**：`pkgMeta`/`sources`/`table`/`composed` 全是内存 Map/字段（`cm:520-531`），磁盘上没有任何模块图缓存。profile 下的 `stardustlc-plugin-update-cache.json` 是插件更新检查缓存，与模块图无关。无效。
- **改插件 `package.json` / 改 `client/index.js`**：内容变化只能经 `rebuilt(id)` 进图（`cm:124-125`），而 id 不在表里。无效（除非同时绕过 3.3 的缓存键）。
- **重启 web 服务 / 换端口**：webServer 只是入口，图在 clientModules 服务实例里，随进程走。无效。

### 3.3 唯一有理论可能的变通路（都不推荐，且未验证）

**换 sourceKey 骗过缓存。** 缓存键 = `baseUrl + "\0" + loaderName`（`cm:810-812`）。把 Loader 行的 `name` 从裸包名改成**路径式说明符**（`./node_modules/dsh-mini-superagent/src/index.js` 或 `file:` 绝对路径），`exactPackageSpecifier` 会放弃匹配（`cm:83-89`），改走 `nearestPackage` 按目录找 `package.json`（`cm:793-809`），仍会把 id 归到 manifest 的 `dsh-mini-superagent` → 新键、无缓存、`table.set` 成功。
- 前提 A（**未验证**）：bundle patch 的改动能否在运行期被 reconcile（`app-boot/config-reload` 事件存在，但「bundle 自带 patch 是否会重读磁盘」我没读到实现）。
- 风险 B：行名同时是 Loader 的模块说明符与 HMR 身份，改掉会影响插件身份与热更；
- 风险 C：若旧行残留，`cm:893-896` 会抛「multiple active Loader sources」，启动期直接变 FAILED fiber（`cm:562`），比现在更糟。

**重新实例化 clientModules 自身**：构造函数会 seed 全量行并同步 flush（`cm:537-562`），等价于清空 `pkgMeta`。但它是 Web 基础 bundle 的行、代码在 asar 内不可 HMR，禁用它等于打断整个 Web UI——实际成本 ≥ 重启。**不构成可行路径。**

### 3.4 结论

> 在不重启宿主、不改配置、不改源码的约束下：**没有任何公开触发点能让一个「已被否定缓存」的包重新进入 `clientModules` 表**。
> 若只是「client 半边晚于首次扫描落盘、且之后再无 fiber 事件」，一次 plugin 行 disable→enable 即可自愈——这是唯一的免重启机会，且必须先用 selfcheck 验证（见 2.3）。
> 否则：**让用户重启桌面应用**。

---

### 3.5 「改什么」→「要不要重启」对照（给后续迭代用）

| 改动 | 需要重启宿主？ | 原因 |
| --- | --- | --- |
| 给已装插件**新增** `dsh.client` 或 `exports["./client"]` | **要**（若该包已被扫过） | 否定缓存在进程内（`cm:121-122`） |
| 已装插件**改** `dsh.client.inject` / `immediately` / `external` | 不要 | 元数据在解析时读出，行重挂即生效；`external` 影响图排序（`cm:422`） |
| 改写 `client/index.js` 字节 | 不要 | HMR 走 `rebuilt(id)`，只换 rev（`cm:625-643`） |
| **新增一个包**（带完整 `dsh.client`） | 不要 | 新行名 → 新 sourceKey → 无缓存 |
| 修改插件 `cordis.patch.yml` 的行 `name` | 不要（但**等于换键**，见 3.3 风险） | `cm:810-812` |
| `platform` 从非 `web` 改成 `web` | **要** | 同一条否定缓存 |

注：表的前两行就是本机踩坑的精确形状——包先以「无 client 清单」被扫，后补 client 半边。

---

## 4. 工程结论（以后避免踩同一个坑）

1. **先有 client 半边，再装进 profile。** `dsh.client` 的解析结果是 per-(baseUrl, loaderName) 一次性缓存，首次扫描时清单不合格就被永久记为「不是 client 包」。
2. profile 里从 link 依赖（本地开发）开始迭代时尤其危险：v1（无 client）→ v2（加 client）是**最典型的踩法**，也是本机的实际情况。
3. 打包发布版不会有这个问题（安装即完整清单），但**升级一个已装插件的 `dsh.client.inject` 列表不需要重启**；**新增/删除 `dsh.client` 或 `exports["./client"]` 一定需要重启**。
4. 自检探针要坚持：`probes` 必须包含已知正常包（如 `dsh-ppt`），否则「没有 clientPath」既可能是本包问题也可能是探测方法问题。本仓库 `src/dispatch.js:543-551` 已经这么做了。

---

## 附录 · 未验证 / 限制

- `pkgMeta` 内容与键没有读接口，2.2 是「代码路径 + 时间戳」的推断，不是直接观测。
- 13:02:38 那次扫描时行的名字是 `dsh-mini-superagent` 还是改名前的 `dsh-dispatch` 无法确定；两种情况下只要 13:14–13:56 之间以新名字重挂过一次，结论相同（未逐条验证重挂时刻）。
- `app-boot/config-reload` 是否重读 bundle 自带 patch：未读实现，标未验证。
- 客户端服务侧（`inject` 声明的两个 client 服务 id 是否都在浏览器里存在）未能 inspect——当前没有打开的 Harness 页面（`client` inspect 查询超时）。这不影响 `clientPath` 的宿主侧判断，但会影响「图修好后面板能否挂上」。
- 本次全程只读：没有改任何源码/配置，没有重启或 toggle 任何东西。
