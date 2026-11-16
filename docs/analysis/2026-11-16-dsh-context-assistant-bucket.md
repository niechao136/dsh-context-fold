# dsh-context 助手桶虚高 74% 的成因与修复路径

调查日期：2026-11-16
调查对象：`dsh-context@0.83.0`（`C:\Users\nie.chao\.dsh\profiles\desktop\node_modules\dsh-context`）
关联会话：`session-2a7190d7-f222-42ef-a79e-900f97285c04`
结论速览：**能在我们这边修，首选改 dsh-context；根因是它绕过了宿主的消息投影，读了原始事件。**

---

## 0. 环境事实（先说清楚版本，后面结论都依赖它）

| 位置 | 包 | 版本 |
| --- | --- | --- |
| `C:\Users\nie.chao\.dsh\profiles\node_modules\@deepseek-ai\` | `dsh-session` 等 | **0.1.0-rc.5**（旧，无消息投影 API） |
| `D:\Deepseek\resources\app.asar` 内 `dsh/node_modules/@deepseek-ai/` | `dsh-session`、`dsh-session-query`、`dsh-session-projection` | **0.2.2-rc.1**（桌面端真实运行版本） |

这一点极易踩坑：`profiles/node_modules` 下那份 0.1.0-rc.5 的 `dsh-session` 里根本搜不到 `SessionMessageProjection` / `registerMessageProjection` / `projectedMessages`。真正的运行时在 `app.asar`。
本报告中所有"宿主能力"结论均取自 **asar 内 0.2.2-rc.1 的解包产物**（`D:\Deepseek\resources\app.asar`，header JSON 5748124 字节，数据区起始偏移 `5748140`）。

---

## 1. 数据来源确认：dsh-context 读的是原始事件

### 1.1 它怎么读会话

`lib/index.js` 里有一个很薄的包装：

```js
function G(e){let t=e.get(`sessionQuery`),
  n=typeof t?.observeSession==`function`?t.observeSession.bind(t):void 0;
  return n===void 0?void 0:(e,t)=>n(e,t)}
```

即 `ctx.get('sessionQuery').observeSession`。它的调用点一律显式关闭投影：

```js
let e=await n(a,{projectionMode:`none`})     // 92644
let e=await r(l,{projectionMode:`none`})     // 116436
let n=await this.coldReads.admit(()=>r(e,{projectionMode:`none`}))   // 118440
```

bundle 中 `projectionMode` 共出现 **9 次，全部是 `"none"`**。也就是说 dsh-context 是**主动**关掉投影的，不是拿不到。

### 1.2 它怎么把事件变成消息

`lib/index.js` 顶部 import：

```js
import{deriveEventMessage as n}from"@deepseek-ai/dsh-session";
```

调用点（`$n()`，单事件 → surface 条目）：

```js
function $n(e,t,n,r,i){let a=Ln(n,r??void 0),o={seq:t.seq,time:t.time,cat:a,
  tokens:_e(r,n===`assistant/message`||n===`developer/message`)};
```

关键：**单参数调用 `n(e)`，第二个参数 `projectedMessages` 没传。** 全 bundle 中 `foldSurface` 出现 **0 次**，`n(` 的 29 个调用点没有一个带上投影 map。

### 1.3 分桶累加的地方

```js
function pe(e){ ... for(let n of e){ ... switch(e.type){
  case`text`: case`reasoning`: t+=ue(e); break;
  case`tool-call`: t+=de(e); break; ...
```

`case 'text': case 'reasoning':` 共用同一个累计分支 —— 这正是"按 block 类型累加、reasoning 全量计入"的那段。`me()` = reasoning 子计数、`ge()` = text 子计数：

```js
function me(e){return fe(e,`reasoning`,ue)}
function ge(e){return fe(e,`text`,ue)}
function he(e){return fe(e,`tool-call`,de)}
```

`$n()` 把它们塞进 surface 条目：

```js
if(a===`assistant`){let e=me(r?.content);e>0&&(o.reasoning=e); ...}
```

累加器初始形状（`un()`）：

```js
return{surface:[],sums:{user:0,inject:0,skill:0,assistant:0,tool:0},
  assistantReasoning:0,assistantAnswerTokens:0,assistantCallTokens:0,...}
```

### 1.4 顶栏为什么准

顶栏的 190.0k 与分桶**不同源**：顶栏取真实 `usage` 回执（`requests[]` 里记的是 provider 返回的 `inputTokens`），分桶取上面的字符估算（`E(e)=Math.ceil(e.length/4)+4` 这一族）。
所以"顶栏对、分桶虚高"不矛盾 —— 一个来自实测，一个来自对**原始事件全文**的估算。

面板反推比例（助手 3.92、工具结果 3.71、工具定义 4.00）与 `ceil(len/4)` 一致，也印证了它数的是日志原文而非投影后文本。

---

## 2. 三个问题的答案

### Q1：dsh-context 从哪里取消息？

**`deriveEventMessage(原始事件)`，单参数，且通过 `projectionMode:'none'` 主动拒绝宿主投影。**
不是"拿不到投影"，是**主动绕开**。它构建 surface 的路径是：
`sessionQuery.observeSession(id, {projectionMode:'none'})` → 遍历 `observation.events` → `$n()` 逐事件 `deriveEventMessage(event)` → `pe()` 按 block 累加 token。

### Q2：DSH 宿主有没有"让插件感知投影"的公开机制？

**有，而且是第一等公民，只是 dsh-context 没用。**

(a) `deriveEventMessage` **有第二个参数**（asar `dsh-session/lib/types/surface.js`）：

```js
export function deriveEventMessage(event, projectedMessages) {
    const projected = projectedMessages?.get(event.seq);
    if (projected !== undefined) return projected;
    ...
```

其 JSDoc 明确写着：
> A caller reconstructing model input supplies the same prefix's `projectedMessages` from `foldSurface`; without that map this function reads original event content. **Session instance methods apply the live projection.**

(b) `foldSurface` 会产出这个 map：

```js
export function foldSurface(events, projections = []) { ...
  return { nodes: [...state.nodes], replacements, projectedMessages: new Map(state.projectedMessages) };
```

(c) `Session` 实例方法自动带投影 —— `sessions`（`dsh-session/lib/index.js`）：

```js
registerMessageProjection(projection) { ... }
get messageProjections() { return this.projections; }
deriveEventMessage(event) { return this.surfaceManager.deriveEventMessage(event); }
```

注意 `Session.deriveEventMessage()` **无参调用也会应用投影**，与自由的 `deriveEventMessage(event)` 行为不同 —— 这正是 dsh-context 踩空的地方。

(d) `sessionQuery` 的 observation 本来就带投影值（`dsh-session-query/lib/index.js`）：

```js
live(session, projectionMode) {
  projections = projectionMode === "none" ? void 0 : this.ctx.get("sessionProjections")?.snapshot(session);
  ...
  ...projections === void 0 ? {} : { projections },
```

即 **`projectionMode` 默认（不传）就会返回 `observation.projections`**，传 `'none'` 才抹掉。dsh-context 每次都传了 `'none'`。

**结论：宿主侧能力完备，无需新增 API。** 缺的只是 dsh-context 愿不愿意读。

### Q3：dsh-context-fold 有没有暴露可读的折叠状态？

**有，两套，都够用。**

1. **Journal 事件**：`REASONING_EVENT = 'plugin:context-fold/reasoning'`（`src/reasoning.ts:46`），由 `recordReasoningFolds()` 写入，data 为 `ReasoningFoldData`（`targets[]`，每项含 `seq`、`indexes[]`、`locators?[]`）。任何插件扫 `session.log` 都能读到，据此把对应 block 的字符数换成折叠后的长度。
2. **公开投影定义**：`reasoningProjection`（`src/reasoning.ts:492`）实现 `type/project(event, context)`，返回 `ReadonlyMap<SessionSeq, Message>`；已通过 `ctx.sessions.registerMessageProjection(reasoningProjection)` 注册（`src/index.ts:252`）。**宿主内部已经在用它**，所以宿主的 `deriveMessages()` / `observation.projections` 看到的本来就是折叠版。

因此 (b) 方案其实**不需要 dsh-context-fold 额外写任何新东西** —— 现成的两套都有。

---

## 3. 结论：能不能在我们这边修？

### 判断：**(a) 能，改 dsh-context。首选。**

理由链：
- 宿主侧 API 齐全（`projectedMessages` 参数、`foldSurface`、`sessionProjections.snapshot`、`observation.projections`、`Session.deriveEventMessage`）。
- `dsh-context` 是唯一"错"的一方：它明确传 `projectionMode:'none'`，又用单参数 `deriveEventMessage(event)`。
- 面板语义上**本来就该**展示"请求里实际长什么样"，所以读投影才是正确行为，读原文才是 bug。

### (b) 也可行，但属于绕路

`dsh-context-fold` 能**额外**写一份 dsh-context 可读的摘要（例如在 `plugin:context-fold/reasoning` 已存在的前提下再加一个 `plugin:context-fold/assistant-char-delta` 事件，直接给"该 assistant 节点折叠后字符数"）。
但这要求 dsh-context 主动去读这个事件 —— **仍然要改 dsh-context**。所以 (b) 不能单独成立，只是 (a) 的一种实现变体（减少 dsh-context 自己重算折叠的工作量）。

### (c) 不成立

宿主不缺 API。不需要在 DSH 层加 `messageProjection` / `llm/request` 之类的 hook —— `projectedMessages` 和 `sessionProjections` 已经是那个机制。

---

## 4. 具体补丁思路

### 方案 A（推荐）：改 dsh-context，读宿主投影

目标文件：`bowenliang123/dsh-context` 的源码（当前只有 bundle，需先 fork + checkout 上游）。

**A-1 最小改动（一处）**：把 `G()` 包装与调用点的 `projectionMode:'none'` 去掉，改用 `observation.projections`，并在构造 surface 时把投影 map 传给 `deriveEventMessage`。

需要的信息：
- `observation.projections` —— `sessionProjections.snapshot(session, keys)` 的返回，按 projection `key` 索引的 wire 值。注意 **context-fold 的投影是 `type: 'plugin:context-fold/reasoning'` 的 message projection，不是 wire/summary projection**，它的产出走的是 `deriveEventMessage` 的第二参数通道，不经过 `snapshot()` 的 `values`。

因此更准确的落法是 **A-2**。

**A-2（正确落法）**：dsh-context 不要自己 `deriveEventMessage`，改用宿主 Session 实例方法。

- 拿到 Session 实例：`ctx.sessions.get(sessionId)`（live）；或对冷读用 `ctx.sessions.prepare(...)`（`dsh-session-query` 内部就是这么做的）。
- 调 `session.deriveMessages()` 或 `session.deriveEventMessage(event)` —— 两者都会自动应用已注册的 `messageProjections`。
- 具体改这三处函数：
  1. `G()` —— 保留 `observeSession` 用于拿 `events`/`header`/`seq`，但**不要传 `projectionMode:'none'`**。
  2. `$n(e,t,n,r,i)` —— 把 `n(r)`（即 `deriveEventMessage(event)`）换成 `session.deriveEventMessage(event)`，或接受一个 `projectedMessages` map 透传。
  3. `pe()` / `me()` / `ge()` / `_e()` —— 不需要改逻辑：只要传入的 message 已经是折叠后的内容，`case 'reasoning'` 自然数到 240 字符头。
- 若不想依赖 Session 实例（冷读/归档场景），备选：`foldSurface(events, ctx.sessions.messageProjections)` 取 `.projectedMessages`，再 `deriveEventMessage(event, projectedMessages)`。

**风险（A）**：
- 需 fork 上游 + 提 PR，周期长；`bowenliang123/dsh-context` 是否接受取决于维护者。
- 改 `observeSession` 的 `projectionMode` 会影响**所有** 9 处调用点（attachment/detail/facts/heads/fleet/overview/snapshot/backfill 等），不止分桶。需要逐个确认这些地方是否也期望原文（比如"附件"页可能真需要原文）。**建议只改分桶/snapshot 那一条路径，其余保留 `'none'`。**
- token 数会变化：助手桶 254.4k → 约 47k 量级，与顶栏 190.0k 自洽。这是修好了，但用户会看到数字"掉下来"，需要在 release note 说明。

### 方案 B：bundle 热补丁（临时）

直接改 `node_modules/dsh-context/lib/index.js`：把 `projectionMode:'none'` → 删掉该属性，并把 `n(r)` 改为带投影。
**风险高**：bundle 是 minified 单行 177KB，改完无法回溯；`dsh-context` 每次升级/重装都会被覆盖；且它破坏了 `projectionMode` 的其他 8 个调用点语义。**不推荐作为长期方案，只适合临时验证。**

### 方案 C（如果上游不愿改）：在 dsh-context-fold 侧"喂"正确的数

让 `dsh-context-fold` 额外注册一个 **wire/summary 类型**的 session projection（`key: 'context-fold/assistant-tokens'`），`wire.view(state)` 直接返回 `{ foldedChars: number }` 这类摘要。dsh-context 只要 `sessionProjections.snapshot(session, ['context-fold/assistant-tokens'])` 就能拿到"应该扣多少"。
**仍要改 dsh-context 才会生效**，所以不解决根本问题；仅在 dsh-context 愿意加一个可选读取口时有用。

### 方案 D：不修数值，改文案（最低成本兜底）

如果短时间不打算动 dsh-context：在面板上把分桶标注为"日志原文估算（不含投影折叠）"，或给助手桶加一个 `⚠` 提示。这只是诚实化，不解决虚高。

---

## 5. 一句话总结

数据源是 `deriveEventMessage(原始事件)` + 显式 `projectionMode:'none'`；宿主 0.2.2-rc.1 **已有**完整投影机制（`deriveEventMessage(event, projectedMessages)`、`foldSurface`、`Session.deriveEventMessage`、`observation.projections`），是 dsh-context **主动关了**。要修就 fork 上游改那条取数路径，让它走宿主投影；bundle 热补丁只能临时验证，会被下次安装覆盖。
