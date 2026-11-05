# reference/ — 本机参考克隆（不随本仓库分发）

这个目录里放的是第三方代码，**不是本仓库的一部分**，`.gitignore` 有意不跟踪它。
只有本文件（`README.md`）作为指针被提交，用来记录「当初参考的是哪个版本」。

## 里面是什么

DSH 官方发布的超智能体研究原型：

| 项 | 值 |
| --- | --- |
| 上游 | https://github.com/deepseek-ai/dsh-superagent-prototype |
| 参考时的提交 | `8c32a9d`（`main`，浅克隆，仅 1 个提交） |
| 体积 | 约 3.3 MB / 245 个文件（其中 `.git` 约 0.8 MB） |

它是 `dsh-mini-superagent` 的架构来源。写这个插件之前读了它三处实现，我们的投递机制是从那里定下来的：

- `src/executor/dsh.ts` —— 一个任务一个 Session，怎么建、怎么取消、怎么在回合结束时收尾
- `src/app/sessions.ts` —— 怎么按角色装配提示词、skills 与工具白名单
- `src/app/delivery.ts` —— `freezeMessage` + 稳定 `MessageId` 的幂等投递

`dsh-mini-superagent/docs/api-contracts.md` 里的取证引用（形如
`reference/.../src/app/sessions.ts:138-155`）就是对着这个版本的行号写的。换了上游
版本，那些行号可能对不上。

## 怎么取回来

在网络可达 github.com 的机器上：

```bash
# 只要这一个快照（跟当初参考时一致）
git clone --depth 1 https://github.com/deepseek-ai/dsh-superagent-prototype.git reference/dsh-superagent-prototype

# 想钉到当初参考的那个提交，再补一步
git -C reference/dsh-superagent-prototype fetch --depth 1 origin 8c32a9d
git -C reference/dsh-superagent-prototype checkout 8c32a9d
```

`git clone` 本仓库**不会**带来这些文件——这是有意的：

- 它是别人的代码，历史和许可是上游的；
- 它是可再生的，没必要在我们的提交历史里存一份副本；
- 它自带 `.git`，直接 `git add` 只会留下一个空的 gitlink。

## 移除

不再需要对照时直接删，不影响插件运行（`src/` 与 `client/` 不依赖这里任何文件）：

```bash
rm -rf reference/
```

删掉之后，`docs/api-contracts.md` 里的行号引用会失去本地副本，但仍可按上文命令取回。
