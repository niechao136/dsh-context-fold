# dsh-context-fold

> **Not an official DeepSeek product.** 第三方 DSH 插件，与 DeepSeek 官方无关。

阶段边界的 tool 结果折叠：**结论留在窗口里，正文落到 spill 文件，一跳可达。**

长会话里最贵的东西不是历史，是「已经用完的正文还在每一步重发」。这个插件在阶段边界
（回合结束，或单回合里结果已经够旧）把已完成的 tool 结果换成 `结论 + spill 路径 +
同批清单`，通过 DSH 自带的替换协议落盘，因此可回放、可审计、不会破坏 tool-call 配对。

- **规则驱动，不调模型。** 同一份日志 + 同一份配置必然得到同一个结论。
- **结论内联，指针次要。** 永远不是一个裸指针：结论写在一行里，路径只是细节入口。
- **错误结果永不折叠。** 错误文本是窗口里价值最高的内容。
- **不新增召回工具。** `read` / `grep` 就是召回原语，spill 存储本来就返回检索提示。
- **先量后信。** `dryRun` 只报告候选与阈值，不改任何东西；`/context-fold` 从日志里
  重新算出折叠量、省下多少字符、以及被重新读了几次。

## 它折叠什么

候选是一个**当前 surface 上的 `tool/result` 节点**，必须同时满足：

| 条件 | 意图 |
| --- | --- |
| `node.turn < currentTurn` 或 `currentStep - node.step >= staleSteps` | 已经「完成」：回合结束，或单回合里够旧 |
| `node.step > currentStep - keepRecentSteps` 不成立 | 最近几步还在用，不动 |
| 不是错误结果 | 错误永不折叠 |
| 未被更晚的事件引用（`callId` 出现在后续 tool 参数或消息文本里） | 还在被引用就不动 |
| `chars >= minFoldChars`，且结论确实比原文短 | 折叠必须有净收益 |
| 文本节点尚未带折叠标记 | 幂等：折过的不会再折 |

候选按 `turn` 分批；一个回合超过 `batchSpanSteps` 步就按连续 step 区间切成多批。
只有当一批候选的原始字符数达到 `minBatchChars` 才真正动手 —— 一次前缀缓存失效，
换一整批的收益。

## 折叠后的样子

批头节点带整批清单，其余节点只带一行回指（总开销 O(n) 而不是 O(n²)）：

```
[context-fold] [tool: ops_grep] 73,447 chars folded at turn 1, step 12. (batch head)
Conclusion: pattern "surfaceOp" — 47 matches across 12 files; first "src/a.ts:12"
Full result: /home/me/.dsh/spill/session-abc/9f8e7d6c5b4a-ops_grep.txt
Same batch (1 more):
  - ops_bash (callId a1b2): /home/me/.dsh/spill/session-abc/1c2d3e4f5a6b-ops_bash.txt
```

```
[context-fold] [tool: ops_bash] 6,266 chars folded at turn 1, step 12.
Conclusion: exit 0; first "=== deps ==="; 41 lines, 6,266 chars
Full result: /home/me/.dsh/spill/session-abc/1c2d3e4f5a6b-ops_bash.txt
Batch head: a0f9 (callId) — lists 1 more result from this batch.
```

结论由工具族决定（`src/rules.ts`）：

| 工具族 | 结论里保留 |
| --- | --- |
| `ops_bash`、`pwsh`、`bash`、`wsl` | exit code、stdout 首行、stderr 末行、行数与字符数 |
| `read`、`ops_read_files`、`wsl-read`… | 路径、行范围、首个内容行 |
| `grep`、`glob`、`ops_grep`、`ops_glob`… | pattern、命中行数、匹配到的文件 |
| `cordis_inspect_*` | 小节标题，丢掉声明正文 |
| `web_fetch`、`web_search`… | URL、首段 |
| 其他 | 首行 + 行数字符数 |

## 安装

```yaml
# profile 的 cordis.patch.yml
- id: context-fold
  name: dsh-context-fold
  config:
    minFoldChars: 1000       # 小于这个字符数的结果不折叠（下限 300，低于它没有净收益）
    minBatchChars: 8000      # 一批候选合计达到这个量才动手
    keepRecentSteps: 6       # 最近 N 步永不折叠
    staleSteps: 12           # 单回合内的年龄阈值
    batchSpanSteps: 20       # 超长回合按连续 step 区间切批
    enabled: true
    dryRun: false            # 只算不改，候选与阈值写到日志
```

插件需要 `ctx.spillStore` 与 `ctx.tokenMeter`；缺 `spillStore` 时**整体不动**并打一条
warning（折叠后原文不可达就是有损，那违反这个插件的承诺）。

## 报告

```
/context-fold
```

从日志重算，不依赖插件内部状态：

```
[context-fold] 2 folded node(s) on the surface.
Characters removed: 12,345
Re-read signals: 1 across 1 folded node(s)

| seq | turn.step | tool | before | after | re-reads |
| --- | --- | --- | ---: | ---: | ---: |
| 12 | 1.4 | ops_grep | 73447 | 412 | 1 |
| 18 | 1.9 | ops_bash | 6266 | 380 | 0 |
```

「被重新读了几次」是反目标（折叠反而让模型重读）的直接度量，也是这个插件值不值得继续
加码的唯一证据。

## 协议与安全

替换严格复用 `dsh-compaction-tool-result-pruner` 的形状：先 `compaction/prune` 记下被遮蔽
节点的影子价格，再追加一条只改 `content` 的 `tool/result` 替换，`sourceEventSeqs` 指回原
节点。宿主 `assertToolResultRewrite` 强制「只能改 content」，所以 `toolCallId`、`isError`、
`turn`、`step`、`error`、`meta` 全部逐字节保留 —— tool-call 配对不可能被破坏。

- 原文永远在日志里（只追加），`sourceEventSeqs` 让回放拿得回精确输入。
- 折叠标记写在文本里而不是消息字段里，因为替换不允许改字段。
- 单节点替换失败只影响该节点，同批已经落地的替换保持有效，不重试整批。
- spill 失败则该节点不折叠，保持原样内联。

### 已知限制

- 只按 `callId` / 工具名做引用检测。模型若用完全相同的参数**重跑原工具**来重读，
  这里检测不到（设计文档 §6.2 记录的已知缺口）；re-read 指标专门用来暴露它。
- 图片与文件块不折叠：占位文本不是内容本身，phase 1 不拿附件换一句话。
- 不折叠 assistant 文本、reasoning、user 消息、system prompt。
- UI 与 reasoning 折叠分别是设计文档的 phase 3 与 phase 2，本包不含。

## 开发

```bash
pnpm typecheck   # tsc --noEmit
pnpm test        # vitest run
pnpm build       # tsdown -> lib/
pnpm check       # 三者依次
```

设计文档：[`docs/specs/2026-11-12-context-fold-design.md`](docs/specs/2026-11-12-context-fold-design.md)。

## 许可

MIT。
