# kwdb-tsdb-datasource 技术评审报告

- 评审日期：2026-10-22
- 评审对象：`lumingsun-kwdbtsdb-datasource`（`kwdb-tsdb-datasource`，`v1.2.0-1-g8824cd1`）
- 评审角色：架构与扩展性 / 应用安全 / 验收边界与质量（三方独立评审 + 主理人交叉核验）
- 评审方式：只读源码评审 + 本地测试执行 + 真实 Grafana 13.1.0 与真实 KWDB 实例实测
- 运行时环境：Grafana 13.1.0（`localhost:3001`，dist 挂载加载）；KWDB `10.110.105.80:26267/factory`，`equipment_telemetry` 4,683,904 行

> 说明：本报告区分「已执行」「读码事实」「推断」「未验证」。凡未实际执行过的检查，一律标注为未验证，不当作通过。

---

## 1. 总体判断

**结论：这是一个工程质量明显高于一般 AI 生成项目、但尚未达到交付/上架标准的插件。**

| 维度 | 评级 | 判断 |
| --- | --- | --- |
| 功能覆盖 | B | 5 种查询模式 + 元数据 + 宏 + 宽表转换，核心链路在真实 KWDB 大表上跑通；2 个 UI 选项是坏的 |
| 代码质量 | B- | 分层清楚、测试真实存在、静态检查全绿、dist 与源码 hash 一致；但契约靠字符串对齐、存在死 API |
| 安全 | D | 「只读」是字符串黑名单，默认账号 `root`，缺 DB 级兜底；一条 SELECT 可杀进程 |
| 生产 / 上架就绪 | F | dist 未签名、无 `MANIFEST.txt`，默认配置无法安装；版本与 CHANGELOG 不一致 |

**可用范围**：内网、专用只读账号、受控看板与预研演示。
**不可用范围**：生产告警、`root` 账号部署、对外宣传为「只读安全数据源」、上架 Grafana Catalog。

---

## 2. 评审环境与执行记录

### 2.1 实际执行过的检查

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| Go 单测 | `GOCACHE=/private/tmp/kwdb-gocache go test -count=1 ./pkg/...` | 48 PASS + 1 SKIP（`TestRemoteKWDBIntegration` 需 `KWDB_TEST_DSN`） |
| Go vet | `go vet ./pkg/...` | exit 0 |
| golangci-lint | `golangci-lint run ./pkg/...` | 0 issues |
| TS 类型检查 | `tsc --noEmit`（node 22.18.0） | exit 0 |
| ESLint | `eslint --no-cache .` | 0 errors / 26 warnings（deprecated API） |
| Jest | `jest --ci` | 5 suites / 42 tests PASS（有 React `act()` 警告） |
| Playwright 默认环境 | `yarn e2e` | 3 passed / 2 failed（写死 `demo_ts.sensors`） |
| Playwright 真实 schema | `KWDB_E2E_*` 覆盖 | 4 passed / 1 failed（`smoke.spec.ts` 写死 `ts`） |
| 制品溯源 | `shasum -a 256` vs `dist/go_plugin_build_manifest` | 9/9 MATCH |
| 签名状态 | `GET /api/plugins/<id>/settings` | `signature: unsigned`，`dist/` 无 `MANIFEST.txt` |

### 2.2 真实 KWDB 上的功能实测矩阵

**通过**：健康检查、`/tables`、`/columns`、`/tag-values`、raw SQL、downsampling builder SQL、gapfill（`linear`/`prev`/`next`/`null`）、latest（`last`/`last_row`/`first`/`first_row` 均可执行）、time_series 自动识别时间列 + 4 路 device 宽表、`TIME_WINDOW`/`SESSION_WINDOW`/`COUNT_WINDOW`/`EVENT_WINDOW`/`STATE_WINDOW`、10 万行截断 + warning notice、只读拒绝（`DELETE`/多语句/`SELECT INTO`/`WITH ... DELETE` → 400）、同请求并发多查询。

**异常行为**：gapfill `constant` → 400；latest `first` 值时间错位；宽表 86,470 行却提示截断；DB 执行期错误被标为 `errorSource: plugin`；指定不存在 `timeColumn` 静默回退；`/columns?table=不存在` → 500 且回显 SQLSTATE。

### 2.3 未验证范围

签名与上架流程、真实 TLS（`sslRootCert`/`verify-full`）、Grafana 12.3 兼容、annotations/alerting 实际路径、查询取消与超时的压测、依赖 CVE 扫描、`.config/`（生成文件，按约定未审）、发布 workflow 实际产出。

---

## 3. 风险清单

严重度定义：**P0** 阻断发布或可造成数据库不可用；**P1** 影响生产可用性/安全边界；**P2** 功能缺陷或可维护性问题。

### P0

| ID | 问题 | 位置 | 证据 | 最小修复 |
| --- | --- | --- | --- | --- |
| SEC-01 | 默认账号 `root` + 守卫放行 `kwdb_internal.*` 管理函数：`SELECT kwdb_internal.force_log_fatal('x')` → `checkPrivilegedUser(root)` → `log.Fatal` → 节点 `os.Exit(255)` | `pkg/plugin/connection.go:21`（`defaultUser = "root"`）、`pkg/plugin/executor.go:29`、`datasource.go:56-61` | 守卫判定隔离复现放行；KWDB `kwbase/pkg/sql/sem/builtins/builtins.go:4479`、`:7508` 源码确认（破坏性效果未执行） | 文档/默认值要求专用只读账号；`AfterConnect` 设置 `default_transaction_read_only=on`；守卫拒绝危险函数；文档把只读校验降级为「护栏」 |
| SEC-02 | 守卫可被 E-string 反斜杠绕过，多语句藏匿（`SELECT E'\''; DROP TABLE t; --'` 判为只读）；合法 `$$...$$` 被误杀 | `pkg/plugin/executor.go:71-160` | 隔离复现 8 条用例 | 正确词法：支持 E-string 反斜杠、dollar-quote、嵌套块注释；保留 DB 侧只读兜底 |
| SEC-10 | `dist/` 无 `MANIFEST.txt`，`signature: unsigned`，默认 Grafana 不加载 | `dist/`、`.github/workflows/release.yml` | 实测 | 走 Release workflow 签名；仓库不交付未签名产物 |

### P1

| ID | 问题 | 位置 | 证据 | 最小修复 |
| --- | --- | --- | --- | --- |
| SEC-03 | 无 `statement_timeout`、无查询取消、无服务端 LIMIT；`pg_sleep` 可占满 `MaxConns=8`；后端插件单进程，影响同插件所有数据源 | `pkg/plugin/connection.go:40-53`、`pkg/plugin/frame.go:116-120` | 读码 + KWDB `vars.go:900` | `SET statement_timeout`；截断即取消查询；`queryTimeout` 可配置 |
| A3 | 10 万行上限只停止缓冲，pgx `ResultReader.Close()` 仍读空全量 | `pkg/plugin/frame.go:35,116-120` | pgx v5.10.0 `pgconn.go:1800` | 同上，截断后 `cancel()` |
| A2 | `$__timeFilter` 正则按首个 `)` 截断且展开不加括号：`CAST(...)` 语法错误；`NOT $__timeFilter(ts)` 静默改变语义 | `pkg/plugin/macros.go:14,19-27` | 本地复现 | 展开体加括号 + 括号配对扫描 |
| SEC-04 | 默认 `sslMode=disable`，文档示例为「私网 IP + root + 空密码 + disable」 | `pkg/plugin/connection.go:22`、`README.md` | 读码 | 文档要求 `verify-full`，删除危险示例 |
| A1/F1 | gapfill `constant` 必然失败（`interpolate(..., 'constant')` 不在 KWDB 白名单） | `src/sqlBuilder.ts:22-28`、`src/components/querybuilder/GapfillEditor.tsx` | 真机 400 + KWDB 源码 | 改为数值常量输入 |
| F2 | latest 选 `first`/`first_row` 时值与时间错位（时间列硬编码 `last(...)`） | `src/sqlBuilder.ts:155` | 真机复现 + 读码 | 时间列跟随 `latestFunc` |
| F5 | 发布阻断：未签名、制品陈旧（`artifacts/` 仍 1.0.0）、CHANGELOG 仅到 1.1.0 | `dist/`、`artifacts/`、`CHANGELOG.md` | 实测 | 重建并签名、清陈制品、补 CHANGELOG |

### P2

| ID | 问题 | 位置 | 最小修复 |
| --- | --- | --- | --- |
| F3 | DB 执行期错误被归为 `errorSource: plugin`，日志误报「frame conversion failed」 | `pkg/plugin/datasource.go:61-77` | 区分下游错误与转换错误 |
| SEC-05 | 错误原文回显（`/columns` 500 带 SQLSTATE、健康检查直出 `err.Error()`） | `pkg/plugin/metadata.go`、`datasource.go:93` | 统一脱敏包装，细节进日志 |
| A6 | 关系表 `/columns` 解析出幽灵列（`INDEX`/`CONSTRAINT` 当列名） | `pkg/plugin/metadata.go:221,294-323` | 保留字黑名单跳过 |
| A5 | 类型映射缺口：UUID/DATE/INTERVAL/数组显示为 Go 结构体串；前后端「时间列」判定不一致 | `pkg/plugin/frame.go:291-310` | 补 OID 映射与可读化 |
| A8 | 空 SQL 返回误导性错误（「only read-only queries allowed」） | `pkg/plugin/datasource.go:56-59` | 空查询单独报错 |
| F9 | 截断按长表行数判定，宽表未超限也提示截断 | `pkg/plugin/frame.go:116-141` | 文档说明或宽化后判定 |
| F10 | 指定不存在 `timeColumn` 静默回退 | `pkg/plugin/frame.go:421-442` | 明确报错 |
| A7 | 切换 `windowType`/换表不重置类型专属字段，生成非法 SQL | `src/components/querybuilder/WindowEventEditor.tsx:163-172` 等 | 变更时重置相关字段 |
| F8/A16 | `queryOptions.maxDataPoints/minInterval` 声明但从不读取；`alerting`/`annotations` 声明无测试 | `src/plugin.json` | 移除无效声明或实现 |
| A9 | `grafanaDependency >=12.3.0` 但只在 13.1.0 验证 | `src/plugin.json` | 收紧或补兼容测试 |
| F7 | README「微秒精度」与 Grafana ms 时间范围、`::TIMESTAMP` 默认精度 3 冲突 | `README.md`、`pkg/plugin/macros.go:11` | 文档改为毫秒 |
| F4 | E2E 写死 `demo_ts.sensors`/`ts`，且 `expect(response.ok())` 不能证明查询成功 | `tests-e2e/*.spec.ts` | 参数化 + 断言响应体 |
| SEC-06 | `/tag-values` 无 LIMIT，高基数拉爆内存 | `pkg/plugin/metadata.go:175-201` | 加 LIMIT + 截断提示 |
| SEC-07 | `SHOW`/`EXPLAIN ANALYZE` 全放行（`EXPLAIN ANALYZE` 会真正执行） | `pkg/plugin/executor.go:61-63` | SHOW 白名单 + 文档说明 |
| A13 | 模式切换时 raw SQL 被覆盖且无 undo | `src/components/querybuilder/QueryEditorToolbar.tsx:69-75` | 保留最后一份手写 SQL |
| A10/F6 | 版本混乱：tag `v1.2.0-1-g8824cd1`、CHANGELOG 1.1.0、artifacts 1.0.0、dist 1.2.0 | 仓库全局 | 统一版本与变更日志 |
| SEC-11 | CI 无 SAST/SCA；Dependabot 仅跟踪 SDK；release action 未固定 SHA | `.golangci.yml`、`.github/` | 加 gosec/govulncheck，放开 gomod 依赖更新 |

---

## 4. 专家分歧与核验结论

| 分歧 | 架构师 | 验收工程师 | 主理人复测结论 |
| --- | --- | --- | --- |
| gapfill 插值模式 | 仅 `linear` 可用，`PREV/NEXT/NULL` 发裸标识符必失败 | `linear`/`PREV`/`NEXT`/`NULL` 实测 200，仅 `constant` 失败 | **验收工程师正确**：裸 `PREV`/`NULL`、`'prev'`/`'null'` 均成功；`'PREV'`（大写引号）与 `'constant'` 失败。缺口仅 `constant` |

其余交叉核验在真实环境完成并相互印证：错误来源分类（F3）、截断语义（F9）、未签名（SEC-10）、E2E 断言强度（F4）。

---

## 5. 验收清单

### 5.1 正常路径

- [x] 健康检查通过（真实环境 `/health` 200）
- [x] raw SQL table 查询返回数据
- [x] downsampling builder SQL 生成并执行
- [ ] gapfill 五种插值模式全部执行成功
- [ ] latest `first`/`first_row` 值与时间戳一致
- [ ] 五类窗口查询执行
- [ ] 模板变量（`tables`/`columns`/`tag_values`）在变量 UI 中可用
- [ ] annotations 查询返回时间/文本字段
- [ ] alerting 规则执行

### 5.2 异常路径

- [x] 写语句/多语句/`SELECT INTO`/`WITH ... DELETE` 被拒绝
- [x] 未知表返回可读错误且分类正确
- [ ] 空查询返回明确提示
- [ ] 连接失败的健康检查提示可读且不泄漏凭据
- [ ] 查询超时在配置时限内返回
- [ ] 元数据错误不泄漏 DB 内部细节
- [ ] 只读函数级绕过（`kwdb_internal.*`、`pg_sleep`）被拒绝

### 5.3 边界

- [x] 10 万行截断 + notice
- [x] 0 行结果
- [x] NULL 值与 NULL 标签
- [x] 同请求多 refId 并发
- [ ] 引号/特殊字符标识符在真实库执行
- [ ] 无 LIMIT 超大结果的资源占用可控

### 5.4 兼容

- [x] Grafana 13.1.0 加载与查询
- [ ] Grafana 最低声明版本实测
- [ ] 真实 TLS 连接
- [ ] UUID/DATE/JSON/INTERVAL 列显示

### 5.5 回滚

- [ ] 插件降级到 1.1.0 后看板兼容
- [ ] 数据源配置回退
- [ ] 插件目录删除/恢复

---

## 6. 行动项

### 必须先修

1. 只读安全模型：专用只读账号 + `default_transaction_read_only` + 危险函数拒绝 + 词法修复（SEC-01/02）。
2. 资源护栏：`statement_timeout` + 截断取消 + 可配置查询超时（SEC-03/A3）。
3. 宏括号与嵌套（A2）。
4. gapfill `constant`（F1）与 latest 时间语义（F2）。
5. 签名与制品一致性（SEC-10/F5/F6）。
6. E2E 参数化与断言强化（F4）。

### 可以后置

错误分类与脱敏（F3/SEC-05）、关系表幽灵列（A6）、类型映射（A5）、编辑器状态（A7）、空查询文案（A8）、`queryOptions`/兼容声明（F8/A9/F16）、文档精度表述（F7）、`/tag-values` 限流（SEC-06）、CI 安全扫描（SEC-11）。

---

## 7. 作为 AI coding 产物的评价

**优点（在 AI 生成项目中不常见）**：分层真实（builder 生成 SQL → 后端宏展开/守卫/执行/Frame，职责不混）；测试不是摆设（28 组只读守卫、7 组宏、13 组 Frame 转换、42 个前端断言）；`dist/go_plugin_build_manifest` 与源码 sha256 一致。

**系统性短板**：「能力声明」跑在「实现验证」前面——gapfill 声称 5 种、alerting/annotations 只写进 `plugin.json`、`queryOptions` 从不读取、`>=12.3.0` 未在该版本验证、README 声称微秒精度。根因不是个别 bug，而是缺少「功能 × 数据库函数 × Grafana 面板」的验收矩阵。

**建议**：把能力矩阵固化进 README 与测试 ID；前端 `sqlBuilder.ts` 与后端 `macros.go` 双处生成/改写 SQL，建议加 golden 测试锁住最终展开 SQL。

---

## 8. 修复状态（v1.2.1）

评审后按本报告执行了修复，逐项状态如下。

### 已修复并验证

| ID | 修复内容 | 验证方式 |
| --- | --- | --- |
| SEC-01 | 每个连接以 `default_transaction_read_only = on` 启动；默认账号仍兼容 `root`，但 README 明确要求使用只读账号 | 真机 `SHOW default_transaction_read_only` = `on`；`DROP`/`CREATE` 被 KWDB 以只读事务拒绝（SQLSTATE 25006） |
| SEC-01 | 守卫拒绝 `kwdb_internal.*` / `crdb_internal.*` 及 `pg_sleep`、`pg_read_file`、`nextval`、`set_config` 等函数 | 真机提交 `kwdb_internal.force_log_fatal('x')` 被 400 拒绝且**从未下发数据库** |
| SEC-02 | 词法扫描支持 `E'...'` 转义、dollar-quote、嵌套块注释 | 单测 8 条绕过/误报用例 + 真机 `SELECT E'\''; DROP TABLE t; --'` 被拒 |
| SEC-03 / A3 | 连接级 `statement_timeout`（默认 30s，可配置）+ 查询 ctx 截止时间；触顶行数上限即取消查询 | 真机 `SHOW statement_timeout` = 30000；`SELECT *` 达 10 万行后 1.4s 返回并取消 |
| SEC-07 | `SHOW SESSIONS/QUERIES/JOBS/TRACE/STATISTICS/BACKUP/ALL` 被拒 | 真机 400 |
| A2 | 宏改为括号配对扫描，展开体加括号 | 单测覆盖 `CAST(...)`、嵌套函数、`NOT $__timeFilter(...)` |
| F1 | gapfill 插值改为小写带引号字符串或数值常量，新增常量值输入 | 真机 `interpolate(avg(voltage), 0)` 成功（192 行）；jest 覆盖生成 SQL |
| F2 | latest 时间列随 `latestFunc` 选择 `first`/`last` | 真机逐 device 校验 `first(time)` == `min(time)`（4/4 一致） |
| F3 | 扫描期数据库错误归类为 `downstream` | 真机 `timeout`/`SQLSTATE` 错误均报 `downstream` |
| SEC-05 | 错误信息脱敏连接串中的凭据 | 单测 + 真机（元数据错误不再带 DSN） |
| A5 | `date` 映射为时间字段；`uuid`/`interval`/`time` 可读化 | 单测覆盖 OID 1082/2950/1186 |
| A6 | 关系表 DDL 中的 `INDEX`/`CONSTRAINT`/`FOREIGN KEY` 等不再被当作列 | 单测 + 保留字黑名单 |
| A8 | 空查询返回明确提示 | 真机 400「query is empty」 |
| F9 | 截断 notice 说明按「读取行数（透视前）」计 | 真机 `schema.meta.notices` 存在 |
| F10 | 指定时间列不存在时报错；builder 生成的 `time` 别名仍被接受 | 单测 + E2E downsampling/gapfill 通过 |
| SEC-06 | `/tag-values` 加 `LIMIT 10000` | 单测断言 SQL 形态 |
| F8/A16 | 移除 `queryOptions` 无效声明；`queryTimeout`/`maxRows` 可在配置页设置 | 配置页单测 + 真机 |
| A9 | `grafanaDependency` 收紧为 `>=13.1.0` | plugin.json |
| F7 | README 精度表述改为毫秒级并说明 `TIMESTAMP(6/9)` | 文档 |
| F4 | E2E 参数化（`KWDB_E2E_*`）并改为断言 `/api/ds/query` 响应体 | 真实 schema 9 passed；demo 默认 5 passed / 4 skipped；CI matrix（Grafana 13.1.8 / 13.2.4 / nightly）全绿 |
| F5/F6 | 版本统一为 1.2.1，CHANGELOG 补齐 1.2.1 | 构建产物 `dist/plugin.json` = 1.2.1 |
| SEC-11 | golangci-lint 启用 gosec；CI 增加 govulncheck；Dependabot 放开 gomod 依赖 | 本地 `golangci-lint run` 0 issues |

### 仍未完成（需要环境或权限）

| 项 | 原因 | 后续动作 |
| --- | --- | --- |
| 签名与 `MANIFEST.txt` | 需要 `GRAFANA_ACCESS_POLICY_TOKEN` | 用 Release workflow 出包并在默认 Grafana 上验证 |
| 真实 TLS（verify-ca/verify-full） | 没有启用 TLS 的 KWDB 实例 | 在隔离环境验证证书路径与失败提示 |
| Grafana 13.1 以外的版本 | 本机只有 13.1.0 | 已由 CI e2e matrix 覆盖 13.1.8 / 13.2.4 / nightly |
| annotations / alerting 实测 | 未配置真实告警与注解 | 补 E2E 与告警评估用例 |
| 依赖 CVE 扫描 | 本机无法下载新工具链；CI 扫描报告标准库 CVE 需更新的 Go 补丁版本 | 已加入 govulncheck（当前为 advisory）：待 Go 工具链升级到修复版本后改为阻断 |
| gapfill 长区间性能 | KWDB `time_bucket_gapfill` 在 470 万行上 30 天区间 > 30s | 已在 README 说明并给出超时建议；E2E 用 1 天区间 |
