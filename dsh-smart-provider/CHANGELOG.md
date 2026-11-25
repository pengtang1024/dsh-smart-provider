# Changelog

本项目所有显著变更都记录在本文件中。格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [1.1.0] - 2026-11-25

### Added

- **延迟度量**：`cost.jsonl` 每条记录新增 `started_at` / `first_token_at` / `finished_at`（ISO 时间戳）、`ttft_ms`（首 token 延迟）、`duration_ms`（尝试总耗时）与 `tokens_per_second`（输出吞吐）字段；缺数据时整段不写（不留 0 或 null），无延迟键的旧行聚合行为不变。
- **实测速度因子**：账号择优 ranking 的速度因子改为「实测优先 → `speedTier` → 中性回退」三级取值——优先用本次会话账本的真实延迟证据（`ctx.speedEvidence`，按 `account_id` 归集），无实测再选手填档位，两者皆无取中性值；未启用 routing 时评分与旧版逐字节一致（回归测试锁定）。

### Changed

- **定价产品化（用户数据不再随包分发）**：随包默认表 `lib/pricing.json` 降级为仅含零价免费档声明（当前 4 行，由 `scripts/gen-custom-routes.mjs` 从本地注册表生成）；作者 151 行真实价格导出降级为 `lib/pricing.example.json`，仅作导入格式示例、不在默认加载路径。
- 新增价格表解析顺序：`DSH_SMART_PRICING_FILE` 环境变量 → `registry/pricing.user.json` → 产品默认表；无表可查的模型返回 tier 粗估（`known:false` / `estimated:true`，金额恒 0），绝不用账号历史价格冒充单价。
- `scripts/gen-custom-routes.mjs` / `scripts/validate-custom-routes.mjs` 对「无 providers 锚点」的 app-managed cordis 形态诚实降级（可见 WARN + 跳过 providers 块 + 退出码 0），不再静默失败。
- README / docs/DETAIL.md 同步以上功能点、包结构（`pricing.example.json`、`test/pricing.test.mjs`、`test/latency.test.mjs`、`test/compaction.test.mjs`）与验证数字（npm test 109/109、test:unit 79/79）；§十一删除「自动测速属于未来计划」的旧口径，改为已落地说明（实测优先 → `speedTier` → 中性回退）。

### Fixed

- 修复价格查询在默认表缺失真实单价时的行为：此前可能回退到账号历史价格，现在明确走 tier 粗估并标记 `estimated:true`。
- 修复延迟数据缺失时的账本污染：时间戳无效或不有序时不再写出无意义的 `ttft_ms` / `duration_ms`。
- **虚拟模型 contextWindow（task-5，工作树内验证）**：`lib/adapter.js` 为虚拟模型声明真实 `contextWindow`（首跳 catalog 缺失时取保守下限 128000），修复宿主压缩预检因 `context === undefined` 报 "no context capacity" 的问题；`test/compaction.test.mjs` 锁定该行为，全套测试 109/109 通过。
