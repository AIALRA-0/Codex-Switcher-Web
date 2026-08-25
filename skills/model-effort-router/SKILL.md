---
name: model-effort-router
description: 为当前迭代收尾并为下一轮任务推荐 GPT Pro 联网调查、GPT-5.6 Sol、Terra 或 Luna 及其 reasoning effort，同时生成范围、停止条件、验收门、升级和降档证据。当用户询问下一轮该用什么模型或档位、要求自动模型路由、准备把一个长期项目拆成连续迭代，或需要评估 high 与 xhigh 是否值得时使用。不要把本 Skill 当成已经完成的模型切换，不用于替代测试、代码审查或用户授权，也不要在缺少宿主切换接口或读回证据时宣称模型已切换。
---

# Model Effort Router

在每轮工作结束时，先总结已验证事实，再对**下一轮任务**分类

目标不是永远选择最强配置，而是选择满足质量门的最低充分配置，并在高代价错误出现前升级

## 必须输出的结果

每次路由都输出以下内容

```text
NEXT_ITERATION_ROUTE
Primary: <surface/model + effort>
Profile: <quality_first | guarded_high | balanced>
Task class: <phase>
Why: <evidence-backed reasons>
Acceptance: <checks proving the next iteration is complete>
Allowed scope: <permitted files, systems, and mutations>
Stop when: <explicit stopping conditions>
Escalate when: <observable triggers>
Downgrade when: <observable triggers>
Alternatives: <zero to two non-duplicated routes>
Confidence: <policy confidence, not a success probability>
Execution: <recommendation_only | switch_available_but_unconfirmed | confirmed_switched>
```

只给一个主推荐和最多两个备选
不要把备选命名为“最好”和“较差”，使用“质量优先”“受控高推理”“均衡”

## 权限边界

- 路由建议不等于模型切换
- 只有宿主提供模型和 effort 写接口，并且能够读回确认时，才可输出 `confirmed_switched`
- 只看到 UI 标签、在文字中声明模型名称、创建普通子任务，均不构成切换证据
- 模型路由权限不授权部署、删除、付款、发送外部消息、修改生产数据或扩大任务范围
- `xhigh` 不能替代明确的目标、非目标、允许范围、验收标准和停止条件

## 先建立下一轮任务合同

在推荐模型前，提取或补齐以下字段

1. 下一轮目标
2. 非目标
3. 允许修改范围
4. 验收检查
5. 可逆性和爆炸半径
6. 当前未知项与证据冲突
7. 已失败且互不相同的假设数量
8. 是否涉及公共接口、数据或安全边界、部署拓扑

缺少关键字段时仍可给出临时建议，但必须把缺项放入 `required_before_execution`

## 三种策略预设

### quality_first

适合错误代价远高于令牌和时延的用户

- 初次外部调查：GPT Pro + web/deep research
- 立项收敛：Sol xhigh
- 首个可运行版本：Sol xhigh，除非任务已经是完全机械的纵向切片
- 日常功能迭代：Terra high
- 复杂但边界明确的实现：Terra xhigh
- 计划、评估、决策和审查：Sol xhigh
- 清晰批量工作：Luna medium

该策略仍必须执行停止门，因为更高 effort 可能增加无谓探索和范围漂移

### guarded_high

默认推荐策略

- 初次外部调查：GPT Pro + web/deep research
- 立项收敛：Sol xhigh
- 首个可运行版本：Sol high；架构、接口或安全边界仍未解决时升 Sol xhigh
- 日常功能迭代：Terra medium；存在跨模块不变量或弱测试时升 Terra high
- 复杂实现：Terra high；一个非显然假设失败或高影响且验证较弱时升 Terra xhigh
- 常规审查、计划和评估：Sol high；满足 xhigh 硬门时升 Sol xhigh
- 清晰批量工作：Luna medium

该策略保留用户对 high 和 xhigh 的偏好，但要求升级有证据

### balanced

适合有强测试和清晰任务合同的持续开发

- 初次外部调查：GPT Pro + web/deep research
- 立项收敛：Sol high；不可逆或证据冲突时升 xhigh
- 首个可运行版本：Sol high；完全冻结的纵向切片可用 Terra high
- 日常功能迭代：Terra medium
- 复杂实现或困难调试：Terra high
- 常规审查：Terra high；跨系统或发布审查用 Sol high
- 机械工作：Luna low 或 medium

## xhigh 硬门

以下任一条件成立，优先推荐 Sol xhigh 处理**判断或重新收敛**

- 需求、测试和现有实现互相冲突
- 两个不同根因假设均有执行证据且都失败
- 决策改变公共接口、数据或安全边界、部署拓扑，且回滚代价高
- 证据来源互相冲突，需要跨模块裁决
- 最终高价值红队审查需要主动寻找遗漏
- 不可逆性为最高级，且验证能力很弱

复杂实现若设计已经冻结，优先 Terra high 或 xhigh 执行，不要让 Sol 在同一长任务里同时调查、重做架构、实现和修复

## high 与 xhigh 的操作差别

把它们视为同一模型的不同测试时计算预算

- `high` 提供较深的规划、分析和检查，适合复杂但有边界的问题
- `xhigh` 通常允许更多替代假设、交叉检查、修订和工具循环，适合高歧义或高代价判断
- `xhigh` 不是不同权重，也不保证单调提高质量
- 对验证强、路径清楚的任务，额外推理可能饱和，甚至造成过度思考、格式错误或任务失焦
- 不使用统一百分比描述 high 到 xhigh 的增益，必须通过本地代表性任务校准

## 路由程序

优先用确定性脚本生成可审计建议

```bash
python3 scripts/recommend.py --input task.json --pretty
```

输入字段和完整矩阵见 `references/routing-policy.md`

## 每轮结束时记录结果

至少记录

- `task_class`
- 推荐和实际使用的模型、effort
- 验收是否通过
- 严重缺陷、范围外修改和回归
- 输入、缓存输入、输出与 reasoning tokens
- 工具调用次数和返工时间
- 用户是否覆盖推荐及原因

使用以下命令汇总

```bash
python3 scripts/analyze_outcomes.py outcomes.jsonl --pretty
```

路由器没有本地样本时，置信度只能写成 `policy_based`
不得把启发式分数伪装成成功概率

## 用量估算

```bash
python3 scripts/estimate_usage.py --input scenario.json --pretty
```

脚本使用模型的令牌费率计算 credits，不硬编码 high 或 xhigh 的倍数
只有输入真实观测 tokens，结果才是实测估算；使用 `effort_output_multiplier` 时必须标记为假设

## 进一步阅读

- 路由矩阵、硬门和反偏置设计：`references/routing-policy.md`
- 可量化研究方案：`references/evaluation-protocol.md`
- 研究问题与发布路线：`research/RESEARCH_PLAN.md`
