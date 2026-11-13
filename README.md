# dsh-context-fold

> **Not an official DeepSeek product.** 第三方 DSH 插件，与 DeepSeek 官方无关。

阶段边界的 tool 结果折叠：**结论留在窗口里，正文落到 spill 文件，一跳可达。**
第二阶段再把历史 reasoning 折叠掉（见下文「第二阶段」）。

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
    foldReasoning: true      # 折叠历史 tool-call 回合的 reasoning（第二阶段）
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
- 不折叠 assistant 文本、user 消息、system prompt。
- reasoning 折叠走**另一套机制**（消息投影，见下节），原文只留在日志里，不落 spill 文件。
- UI 是设计文档的 phase 3，本包不含。

## 第二阶段：reasoning 折叠

助手思考过程是窗口里第二贵的东西。两个决定性实测事实决定了做法：

1. **只有 tool-call 回合的 reasoning 会真的重发。** DeepSeek adapter 的 `serializeAssistant`
   只在消息同时带 tool_calls 时才写 `reasoning_content`（普通回合的 reasoning 被主动丢弃）。
   所以普通回合的 reasoning 折叠**收益为零**，直接跳过。实测三份真实会话：
   tool-call 回合的 reasoning 占 surface 的 12–19%，普通回合只占 0.03–2.7%。
2. **`assistant/message` 根本不能做 surface 替换。** 宿主强制替换必须引用所有被遮蔽节点，
   但 assistant 消息「embeds its source stream」不允许带 `sourceEventSeqs`。
   所以 phase 1 的替换协议在这里结构上不可用。

替代方案是宿主官方给的**消息投影**（`ctx.sessions.registerMessageProjection`，
`dsh-compaction-image-offload` 用它处理图片）：

- 追加一条持久决策事件 `context-fold/reasoning`，指明折哪个节点的几个 reasoning 块；
- 注册一个纯函数投影，在 `deriveMessages()`（也就是组请求的消息来源）时把 reasoning
  换成 `240 字原文开头 + 省略说明`；
- **日志一个字节不改**，原文永远在 append-only 事件里，块数量与块类型保持不变，
  所以 replay 校验依然成立。

规则：`MIN_REASONING_CHARS = 1200`（低于它标记本身比正文还长）、保留原文开头 240 字
（不发明任何内容，开头是原文的真前缀）、沿用 phase 1 的年龄与「最近 N 步不动」规则、
带标记的块永不二次折叠。

投影对**过期目标宽容**：compaction 可能遮蔽决策点名的节点，此时抛错会让之后每一次
`deriveMessages()` 都失败、把会话彻底弄死；所以过期目标跳过而非报错。决策本身形状
非法（空 `targets`）仍然直接抛错，坏日志不会静默少折。

投影**即使 `foldReasoning: false` 也注册**：决策事件是持久的，日志里已有决策的会话
若没有对应投影会拒绝继续派生。开关只停止产生**新**决策，不能让旧日志读不出来。

**已知缺口**：phase 2 不写 spill 文件。原文可从日志恢复，但没有「一跳可达」的
`read`/`grep` 路径，链式召回对 reasoning 尚未成立（设计文档 §12.7）。

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
