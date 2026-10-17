# dsh-hippo

长期记忆插件，为 [DSH](https://github.com/deepseek-ai/deepseek-harness) 的陪伴型智能体设计。

一句话：**关系状态是产品，记忆库是基础设施。**

大多数「agent memory」把记忆当成检索问题——写进去、搜出来、塞回 prompt。这对客服机器人够用，对长期陪伴的人不够。一个人记住你，不只是记得你说过什么，还包括：什么时候开始记不清了、哪些是随口一说、哪些是真的要紧、你现在和上次说的不一样了、以及他更信任你了还是更小心了。

hippo 试图把这些都变成可计算的机制。

## 为什么不用现成的

DSH 生态里有十几个记忆插件。评估过的都缺同一组东西：

| 缺失 | 后果 |
| --- | --- |
| 没有遗忘 | 一年后的 prompt 里塞着第一天随口说的废话 |
| 没有巩固 | 原始对话堆着，没有从「他说过」变成「我知道」 |
| 没有情绪权重 | 「我妈住院了」和「今天天气不错」权重一样 |
| 没有矛盾演化 | 搬家之后旧地址还在，两个都"正确" |
| 没有关系状态 | 聊了三个月和第一天，说话方式一模一样 |
| 中文检索坏 | FTS5 的 `unicode61` 把整句中文当一个 token |

最后一条是实测的，不是推测：

```
unicode61 分词下 MATCH '加班' → []        # 整句中文被当成一个 token
bigram 预分词后 MATCH '加班' → 命中
```

所以 hippo 自己做分词（`lib/tokenize.js`），中文用重叠 bigram，索引串和查询串都过同一套。

## 它怎么工作

四层记忆，越往上越慢、越贵、越像"知道"：

```
L0 感觉   原始消息                        不直接读，只在需要时回查
L1 工作   当前上下文                      由 DSH 的 compaction 管，hippo 不碰
L2 情景   episodes  —— 谁在何时说了什么     不可变，只标记被谁吸收
L3 语义   facts     —— 提炼出的稳定认知     可修正，有版本链
L4 程序   relationship / open_loops       关系状态与未完成的事
```

### 写入：三级闸门

不是每句话都值得花 token 提炼。

1. **闸门一（零成本，每轮）**：原始消息直接落 `episodes`。规则词表判断是否值得往上走（`lib/gate.js`），命中显式记忆、自我披露、关系事件、承诺、更正、情绪中的任一类才开门。
2. **闸门二（攒批）**：未处理内容累计到 4 条、或超过 2000 token，才发一次抽取调用。一次调用看整批，硬 JSON 契约（`lib/extract.js`）。
3. **闸门三（审计）**：抽取结果再过一次廉价审计，拦掉"模型自己脑补"的条目。审计调用失败时**降权保留而不是丢弃**——丢掉一条真记忆比带一条软记忆糟。

### 决策：ADD / UPDATE / INVALIDATE / NOOP

mem0 的形状，两处不同：

- **矛盾只退休不删除。** 旧事实保留 `invalid_at` 和 `superseded_by`，belief 的历史可查。这是"改变主意"和"从来不记得自己想过别的"的区别。
- **单值性是谓词的性质，不是句子的性质。** `lives_in` 换了城市就是矛盾；`likes` 加了新爱好是并列。这套判断写在 `SINGLE_VALUED` 集合里，不交给模型每次现猜。

谓词走白名单归一（`PREDICATE_SYNONYMS`）。模型会顺手写成"养了"或"是"，而键一漂移，两条陈述就永远无法比较。

### 读取：三段

1. **常驻段**（system prompt，`lib/prompt.js`）：关系熟悉度 + 核心事实 + 还没聊完的事。预算 1200 token，压缩到 75% 就截断。渲染时 `interpolate: false`，不参与 DSH 的 `{{}}` 模板替换。
2. **召回段**（按需）：命中"你还记得吗"这类提问时，检索并按需注入。标记为 `form: 'recall'`，下一轮不会被当成新消息再记一遍。
3. **显式工具**：`memory_recall` / `memory_state` 等，给模型自己查。

激活分数是五个因子的乘积：

```
score = (0.5·activation + 1.0·relevance + 0.4·salience + 0.3·recency) · r · fan
  activation  ACT-R 基级激活 ln(Σ t_k^-0.5)
  relevance   BM25 归一
  salience    敏感度或置信度
  recency     指数衰减
  r           FSRS 可提取度
  fan         联想扇效应，撞太多条就降权
```

### 遗忘：FSRS-lite

`lib/fsrs.js` 是 FSRS-5 的简化实现，19 个权重 + 可提取度公式 `R(t) = (1 + FACTOR·t/S)^DECAY`。

关键设计：**物理删除默认关闭**。检索得越好，稳定性越涨、下次越难忘；长期不被触碰的事实会浮到"正在淡忘"的区间，然后在常驻段里被降权、最后只剩可检索。真的要走，走 `memory_forget`，那是显式动作。

### 巩固

三个触发点：闲了 15 分钟、agent 退场、或者未巩固内容攒够 50 条。做三件事：

1. **抽象**：把一批 episode 压成一条 reflection。
2. **链接**：共享主语的 facts 互相建边。
3. **冲突检测**：同谓词的候选过一遍 `decide()`。

⚠ 一次性会话（headless）在 turn 结束时就会退出进程，所以 turn boundary 也触发巩固并等待最多 4 秒；退场时再等最多 15 秒让在途的巩固落地。否则整个批次的记忆会随进程一起消失——这个 bug 实测踩过。

## 安装

```bash
dsh plugin add dsh-hippo
```

或者手工：

```yaml
# cordis.patch.yml
- insert:
    - id: hippo
      name: dsh-hippo
      config:
        provider: deepseek-official
        model: deepseek-flash
        language: zh
```

## 配置

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `path` | `$DSH_HOME/hippo/memory.db` | SQLite 文件位置 |
| `provider` / `model` | `deepseek-official` / `deepseek-flash` | 抽取与审计用的模型 |
| `language` | `zh` | 渲染语言 |
| `residentBudget` | `1200` | 常驻段 token 预算 |
| `recallBudget` | `1200` | 召回段 token 预算 |
| `recallOnEveryTurn` | `false` | 强制每轮召回 |
| `extraction` | `true` | 关掉只记录不提炼 |
| `consolidation` | `true` | 关掉只写不巩固 |
| `idleMs` | `900000` | 空闲多久触发巩固 |
| `dailyTokenBudget` | `200000` | 每天模型调用上限，0 = 不限 |

## 工具

模型可见的只有七个，刻意压得少——陪伴型对话里模型几乎不会主动调记忆工具，给多了只是占 prompt：

`memory_recall` `memory_remember` `memory_forget` `memory_open_loops` `memory_loop` `memory_state` `memory_consolidate` `memory_clarify`

## 成本

一条日常对话每天大约：抽取 2 次 × 6K in + 800 out，审计 1 次 × 3K in。约 **110K token/天**。用 `deepseek-flash` 级别的小模型跑，实际可以更低。

关掉 `extraction` 后是纯零成本：只落 episodes，不做提炼，召回仍然可用（走 FTS）。

## 开发

```bash
node test/smoke.mjs        # 纯算法，无 runtime 依赖
node test/extract.mjs      # 谓词归一与矛盾决策
node test/consolidate.mjs  # 巩固管线，stub 模型
node test/wiring.mjs       # 真插件 + 假 Cordis context，走一遍完整对话
```

`wiring.mjs` 是唯一能证明接缝对了的测试：事件名、工具 schema、注入位置错一个，前三个测试照样全绿。

## 不做的事

- **不碰 L1 工作记忆**。上下文窗口和压缩是 DSH 的事，hippo 只在 `agent/pre-step` 上挂一条。
- **不做向量检索**。中文 bigram + BM25 在这个规模上够用，加 embedding 就多一个模型、一个索引、一份 393MB 的依赖。可以后面作为可选层加上。
- **不跨用户**。一个库一个 owner，多人场景留给部署层。
- **不自动删数据**。

## 状态

0.1.0，M0–M3 已实现（表结构、落盘、抽取、巩固、FSRS 召回）。M4 澄清队列与关系演化在跑，M5 Web UI 未做。

已知缺口：

- 澄清问题会排队，但没有主动问出来的通路（要靠下一轮对话自然带出）。
- 巩固是抽取式的，没有真正的摘要归纳。
- 只有中文和英文的停用词表。

## License

MIT
