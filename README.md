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
    foldPlainTurnReasoning: false  # 额外折叠普通回合；router 路由应设为 true
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

助手思考过程是窗口里第二贵的东西。以下事实都是实测/读代码确认的，不是推测。

### 为什么不用 phase 1 的替换协议

**`assistant/message` 根本不能做 surface 替换**：宿主强制替换必须引用所有被遮蔽节点，
但 assistant 消息「embeds its source stream」不允许带 `sourceEventSeqs`。
不是难，是结构上不可能。

### 替代机制：消息投影 + plugin record

宿主官方给的是**消息投影**（`ctx.sessions.registerMessageProjection`）：追加一条持久
决策记录，在 `deriveMessages()`（也就是组请求的消息来源）时把 reasoning 换成
`240 字原文开头 + 省略说明`。日志一个字节不改。

**一个必须说清的关键修正**：持久记录必须用 `appendPluginRecord`，**不能用** `session.append`。

`dsh-compaction-image-offload` 不是「自己发明事件类型」的先例——`image/offload` 是
harness **核心**事件（在 `KNOWN_SESSION_EVENT_TYPES` 里），下游插件无法加入那个集合，
`SessionEventMap` 增强只影响 TypeScript。

而 `session.append` 写出的信封只有 `{type, seq, time, data}`，没有 `ignorable`；持久化
读取路径会因此拒绝整条日志：

> "contains event type … unknown to this harness and not marked ignorable; refusing to interpret the log"

也就是说，**用户只要折过一次 reasoning，会话就再也打不开**——正常使用就会丢光对话。
这个缺陷在第一版实现里真实存在过。`appendPluginRecord` 会打上 `ignorable: true`，
老版本读取器会保留并跳过该记录，而 `reasoningProjection` 依然能从它驱动
`deriveMessages()`（已端到端验证）。

### 规则

- 规则驱动，零模型调用；带标记的块永不二次折叠。
- `MIN_REASONING_CHARS = 1200`（低于它标记本身比正文还长），保留原文开头 240 字
  ——是真前缀，不发明任何内容。
- 沿用 phase 1 的年龄与「最近 N 步不动」规则。
- 决策记录**自描述**：存的是内容索引，不是「折几个」的计数，所以回放不依赖位置重推。

### 按路由决定折哪些回合

哪些回合的 reasoning 会真的重发，取决于序列化器：

| 路由 | 普通回合的 reasoning | 默认 |
| --- | --- | --- |
| `dsh-llm-deepseek` | 丢弃（只在有 tool_calls 时发） | 折了没有收益 |
| `dsh-router-core`（本 profile 实际在跑） | **无条件发送** | 折了是真省钱 |

所以：`foldReasoning`（默认开）折 tool-call 回合；`foldPlainTurnReasoning`（默认关）
额外折普通回合——在 router 路由上应当打开。

### 失败策略

投影对**过期目标宽容**：compaction 可能遮蔽决策点名的节点，此时抛错会让之后每一次
`deriveMessages()` 都失败。所以过期目标跳过而非报错；记录本身形状非法也只是一条无效
记录（不影响派生），因为**已经落盘的日志不能因为新版本校验变严就变得读不出来**。

投影**即使 `foldReasoning: false` 也注册**：开关只该管**新**决策，日志里已有决策的
会话应当继续享受它已经被计费的收益。实测也确认：没有投影时不报错，`deriveMessages()`
退回未折叠的原文（4000 字 vs 332 字）。宿主同一事件类型只允许注册一次，重复注册会被
捕获并告警，不会让 `apply()` 抛错。

### 已知缺口

**与 `compaction-basic` 的交互**：compaction 遮蔽 assistant 节点会让 reasoning 目标 seq
过期并被跳过（这是设计上的宽容，但还没有用真实 `/compact` 验证过）。

### 召回路径（已补齐）

reasoning 折叠时会同步把**原文**写进 spill，并把路径内联进标记：

```
[context-fold] [reasoning] 9,000 chars folded.
<240 字原文开头>
[… 8,760 chars of earlier reasoning omitted] Full text: /spill/…/reasoning-12-0.txt — use read (offset/limit) or grep on that path.
```

所以它和 tool 结果折叠共用同一条召回链，回放后路径依然在。spill 失败不阻塞折叠
（标记仍准确，只是没有提示），这与 phase 1 对 tool 结果的处理一致。

## 会话内标签页

会话里多一个 `conversation.view` 标签页（和 `dsh-context` 用同一个注册点，order 40 排在
它后面）。它显示：

- **被折叠的内容**：每条折叠的类型、turn.step、字符数变化、是否可恢复；展开时**懒加载**
  原文（折叠的意义就是这段文本很贵，不能预先加载）。
- **token 对比（估算）**：折叠后占用 / 如果不折会占用 / 每步省的 token / 前缀失效代价 /
  净收益，并明确标注这是估算。

### 为什么是估算，以及它修正了什么

实测四份真实会话：**972 个 `assistant/message` 一个 usage 字段都没有**。token 与缓存数据
来自 `dsh-token-meter` 的投影，不在日志的消息事件上。

而「启用前」永远不会发生——历史会话不是在关闭插件时跑的，也不会重跑。所以这是**重放
token 算术**，不是测量差值。它修正了两处朴素估算会算错的地方：

1. **省下的 token 本该按“缓存读”计价**（约 0.1×），不是按全价。一个热会话缓存命中率
   约 95%，所以真实收益比 `token × 步数` 低一个数量级。
2. **一次折叠会让前缀从被遮蔽处失效**，之后整段 prompt 重新按全价计一次。所以折叠有
   一次性成本，**折得太晚就是净亏**——面板会直接显示负数。

面板还会说明这个会话到底有没有报告过真实 usage，因为用启发式算出来的数字不该看起来
像账单。

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
