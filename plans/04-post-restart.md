# 04 · 重启宿主后的验收清单

> 为什么必须重启：`dsh.client` 的解析结果按 Loader 行缓存在宿主进程内存里，**否定结论也缓存**。
> 本包在 13:02 首次被扫时 `package.json` 还没有 `dsh.client`（13:56 才加），那次 null 一直有效。
> 证据与全部免重启尝试的排除过程见 [03-client-graph.md](03-client-graph.md)。

## 一、重启后的三关

按顺序跑，每一关失败都指向不同的原因，别跳。

```bash
# 第 1、2 关：模块进图了吗 / apply 跑完了吗
node scripts/http-smoke.mjs
```

看输出里的三行：

```
client.inGraph = true
client.ready   = {"at":"…","ok":true,"registered":["sidebar.panellist","main","conversation.input.left","@workspace"]}
注册项: sidebar.panellist / main / conversation.input.left / @workspace
```

| 现象 | 含义 | 下一步 |
| --- | --- | --- |
| `inGraph=false` | 模块仍没进 Web 图 | 清单问题，按 03 文档的 11 条判据查；先确认 `package.json` 里 `dsh.client.platform === 'web'` 且 `exports["./client"]` 存在 |
| `inGraph=true` 且 `ready` 缺省 | 进了图但页面没自报 | 刷新页面（Ctrl+R）再跑一次；仍缺省说明模块执行时抛错，看 DevTools Console |
| `ready.ok=false` | `apply` 抛错了 | 读 `client.ready.error`，按错误定位 |
| `ready` 齐全 | 浏览器半边跑起来了 | 进第 3 关 |

```bash
# 第 3 关：槽真的挂上了吗（离线断言，不能替代真机）
node scripts/client-smoke.mjs   # 71 项，应当全过
```

## 二、主会话侧的分步验证

第 3 关之后，用 `cordis_inspect_query(platform="client", provider="Slots", method="listSubTree", input={"root":"<槽名>"})`
逐个确认 occupants 里出现我们的注册：

| 槽 | 期望 occupants 含 |
| --- | --- |
| `sidebar.panellist` | `dsh-mini-superagent.board`（order 60，label 任务看板） |
| `conversation.input.left` | `dsh-mini-superagent/target`（order 60，label 派发目标） |
| `main` | key `dsh-mini-superagent.board` |

三者都在，说明代码路径全通；剩下的都是视觉问题。

## 三、只能目视的清单

这些没有任何脚本能替，必须看：

1. 侧边栏图标位置、点击是否切到面板、选中态高亮
2. 看板：4 个 chip 计数、工作区下拉、归档行透明度、批次徽标、窄栏截断
3. 点任务行是否真的跳到子会话（`uiWorkspace.openSession` 是唯一没验证过的服务调用）
4. 输入框「派发 →」控件：28px 是否与工具行齐平、下拉是否稳定向上展开、边缘夹取
5. `@` 与官方 `@reference` 混排的分组观感；插入的 chip 刷新后能否从草稿恢复
6. 深浅两套主题的对比度；`prefers-reduced-motion` 下脉动是否关闭

## 四、已知的「不是 bug」

- 空白会话（hero）里看不到「派发 →」控件：它在 `conversation.input.left`，该槽只在有活跃输入壳时渲染。
- 语音输入展开时工具行整体隐藏，控件跟着消失。
- 点已插入的 `@工作区` chip 不会打开选择器：没实现 `openReference`，目前是无反应。
- 归档行点击会先提示「可能已不在会话列表里」，这是有意的。

## 五、验收通过后

1. 把上面三关的实际输出记进 `dsh-mini-superagent/CHANGELOG.md` 的 0.5.0「验证」小节
   （把「未在真机跑过」改成实测结论）；
2. `node scripts/http-smoke.mjs` 的 `inGraph` 提示文案可以从「需要重启」改成历史说明；
3. 目标可以标完成。
