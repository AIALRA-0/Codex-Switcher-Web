# Model Effort Router

为连续代理项目推荐**下一轮**使用的模型、推理档位、范围合同和升级门

当前版本：`0.1.0`

## 1 解决什么问题

模型选择经常被压缩成一句“复杂就上最强模型”
这种做法忽略了三类不同决策

1. 选择模型能力层：Sol、Terra、Luna
2. 选择同一模型的推理档位：medium、high、xhigh
3. 判断何时应中止当前路线并升级、降档或重新定义任务

本 Skill 把三类决策拆开，并在每次迭代完成后给出一个主推荐和最多两个备选
它同时生成目标、非目标、允许范围、验收标准和停止条件，避免高档位在开放工具环境中无限调查或扩大修改范围

## 2 核心原则

- 推荐下一轮，不在长任务中边做边无限改路由
- 模型与 effort 分开判断
- 把 `xhigh` 作为有证据的升级，不作为情绪安慰
- 一个主推荐，最多两个备选
- 不把启发式置信度伪装成成功概率
- 推荐不等于切换，必须有宿主写接口和读回证据
- 用本地验收结果校准策略，而不是相信统一的性能折扣

## 3 默认策略

| 阶段 | quality_first | guarded_high 默认 | balanced |
| --- | --- | --- | --- |
| 首次外部调查 | GPT Pro + web/deep research | 同左 | 同左 |
| 立项收敛 | Sol xhigh | Sol xhigh | Sol high，硬门升 xhigh |
| 首个可运行版本 | Sol xhigh | Sol high，架构未决升 xhigh | Sol high，冻结切片可 Terra high |
| 日常实现 | Terra high | Terra medium，弱验证升 high | Terra medium |
| 复杂实现 | Terra xhigh | Terra high，证据触发升 xhigh | Terra high |
| 困难调试 | Terra xhigh 或 Sol xhigh 重新裁决 | Terra high，两假设失败升 Sol xhigh | Terra high |
| 常规审查与计划 | Sol xhigh | Sol high，硬门升 xhigh | Terra high 或 Sol high |
| 批量机械工作 | Luna medium | Luna medium | Luna low 或 medium |

`guarded_high` 是推荐默认值
它保留 high/xhigh 的质量保险，同时避免把 Sol xhigh 变成所有任务的全局默认

## 4 安装

把本目录复制到 Codex Skills 目录

```bash
mkdir -p ~/.codex/skills
cp -R model-effort-router ~/.codex/skills/model-effort-router
```

也可以把 `SKILL.md` 与其 `references/`、`scripts/` 一并安装到其他兼容 Agent Skills 的宿主

## 5 使用

在代理中调用

```text
$model-effort-router
请根据本轮结果，为下一轮实现推荐模型和 reasoning effort
```

使用确定性 CLI

```bash
python3 scripts/recommend.py --input config/example-task.json --pretty
```

标准输入也可用

```bash
cat config/example-task.json | python3 scripts/recommend.py --pretty
```

输出包含

- 主推荐和策略预设
- 去重后的备选路线
- 推荐证据
- 必须补齐的任务合同字段
- 验收门、停止条件、升级和降档触发器
- `recommendation_only`、`switch_available_but_unconfirmed` 或 `confirmed_switched`

## 6 输入示例

```json
{
  "phase": "first_runnable",
  "preference": "guarded_high",
  "goal": "完成一个端到端纵向切片",
  "non_goals": ["不重写既有数据层"],
  "allowed_scope": ["src/", "tests/"],
  "acceptance_checks": ["端到端测试通过", "没有范围外修改"],
  "ambiguity": 1,
  "complexity": 3,
  "blast_radius": 2,
  "irreversibility": 1,
  "verification_strength": 3,
  "evidence_conflict": false,
  "failed_hypotheses": 0,
  "cross_module": true,
  "public_interface_change": false,
  "security_or_data_boundary": false,
  "deployment_topology_change": false,
  "final_red_team": false,
  "host_can_switch": false,
  "host_switch_confirmed": false
}
```

## 7 用量计算

官方 credits 费率会变化，因此模型费率集中在 `config/model-catalog.json`

```bash
python3 scripts/estimate_usage.py --input config/example-scenario.json --pretty
```

脚本不会假定 `high = 1.3× medium` 或 `xhigh = 2× high`
这类倍数必须来自实际运行记录，或由场景文件明确标记为假设

## 8 结果校准

把每次任务的结果写成 JSONL

```json
{"task_id":"T-001","task_class":"routine_implementation","recommended_model":"terra","recommended_effort":"medium","actual_model":"terra","actual_effort":"medium","accepted":true,"severe_defect":false,"scope_violation":false,"regression":false,"rework_minutes":12,"input_tokens":82000,"cached_input_tokens":41000,"output_tokens":9000,"tool_calls":18}
```

汇总

```bash
python3 scripts/analyze_outcomes.py outcomes.jsonl --pretty
```

初期只把结果视为描述统计
要比较 high 与 xhigh，需要对同类任务做配对或随机交叉实验，固定任务合同、上下文、工具权限和验收器

## 9 研究结论边界

公开研究已经证明动态模型路由和动态 reasoning effort 有价值，但不存在可跨任务套用的“降一档损失 N%”
长程研究任务可能对 effort 极敏感，某些导航或工具任务又可能出现 medium 优于 high 的过度思考现象

因此本项目把路由规则当作可版本化先验，把真实验收数据当作最终证据
完整实验设计见 `references/evaluation-protocol.md`

## 10 目录

```text
model-effort-router/
├── SKILL.md
├── agents/openai.yaml
├── config/
│   ├── example-scenario.json
│   ├── example-task.json
│   └── model-catalog.json
├── references/
│   ├── evaluation-protocol.md
│   └── routing-policy.md
├── research/RESEARCH_PLAN.md
├── schemas/
│   ├── outcome.schema.json
│   ├── recommendation.schema.json
│   └── task-input.schema.json
├── scripts/
│   ├── analyze_outcomes.py
│   ├── estimate_usage.py
│   └── recommend.py
└── tests/
    ├── cases.json
    └── test_router.py
```

## 11 验证

```bash
python3 -m unittest discover -s tests -v
python3 scripts/recommend.py --input config/example-task.json --pretty
python3 scripts/estimate_usage.py --input config/example-scenario.json --pretty
```

所有脚本只依赖 Python 标准库

## 12 许可证

本目录遵循宿主仓库的 MIT License
