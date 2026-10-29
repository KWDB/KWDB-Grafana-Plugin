# 真实 KWDB 实例全功能验证报告

- 日期：2026-10-29
- 目标实例：KWDB `10.110.105.80:26267`，数据库 `factory`（TIME SERIES 类型），用户 `root`
- 版本：`KaiwuDB CCLV3.3.0-dev30-10-gca756f2085-dirty (x86_64-linux-gnu, built 2026/09/15, go1.24.3)`
- 验证对象：`fix/code-quality-hardening` 分支（含本轮 3 个真实缺陷修复），前端 `dist/module.js` 与后端 `gpx_*` 均为修复后重新构建
- Grafana：本地 `docker compose` 容器 `kaiwudb-kwdbtsdb-datasource`，grafana-enterprise 13.1.0，数据源 `kwdb-tsdb` 已指向 `10.110.105.80:26267/factory`

## 数据规模

| 表                    | 行数      | 时间范围                            | 说明                                                |
| --------------------- | --------- | ----------------------------------- | --------------------------------------------------- |
| `equipment_telemetry` | 1,002,988 | 2026-10-26 01:06 ~ 2026-10-29 01:01 | 7 个数据列 + 3 个 tag，主 tag `device_id`，4 个设备 |
| `factory_environment` | 103,406   | 同上                                | 2 个主 tag                                          |
| `production_status`   | 0         | —                                   | 空表                                                |
| `sensor_readings`     | 0         | —                                   | 空表，带列注释                                      |

本次验证全部查询落在 `equipment_telemetry` 的 `2026-10-27 00:00:00 ~ 06:00:00`（UTC）这 6 小时窗口内，共 83,710 行原始数据。选它是因为它同时具备：非空的可空列（`rpm`/`vibration`/`temperature`/`status_code`）、多 tag、多设备，能覆盖空值、分组、宽表转换三条最容易出问题的路径。

## 一、这一轮实际连过什么（先说清楚，不含糊）

| 层级                             | 是否连真实库 | 说明                                                                                                                |
| -------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------- |
| SQL 语句级                       | **是**       | 56 条 SQL 由 `src/sqlBuilder.ts` / `src/variableQuery.ts` 真实代码生成，逐条在 `10.110.105.80:26267/factory` 上执行 |
| 后端 Go 管线                     | **是**       | `pkg/plugin` 全部处理器对真实实例跑通：建池、健康检查、宏展开、只读拦截、查询执行、Data Frame 转换、元数据资源      |
| Grafana 查询 API                 | **是**       | 通过 `/api/ds/query` 走完整 `Grafana → 插件后端 → KWDB` 链路                                                        |
| E2E（Playwright）                | **是**       | 21/21 通过，跑在真实数据上                                                                                          |
| 告警链路                         | **是**       | 建规则 → 调度 → 插件查询 → 阈值 → Alerting → 通知，全链路走通                                                       |
| TLS（`verify-ca`/`verify-full`） | **否**       | 该实例未启用 TLS，端口 26267 是明文。**这一项目前仍无任何端到端证据**                                               |
| 认证失败提示                     | **否**       | 该实例对任意密码、任意库名都放行（trust 认证），无法构造失败场景。相关代码路径只做了单元测试                        |

`docs/quality-review-2026-10-22.md` 记录的是上一轮在另一套环境上的真机验证，两轮不要混为一谈。

## 二、发现并修复的真实缺陷（3 个）

这三个问题在真机之前**只靠读代码是发现不了的**：单测全绿、CI 全绿、validator 全绿，因为单测用的是 mock 行，CI 用的是 compose 容器里的演示数据——演示数据恰好不会触发这三条路径。

### 缺陷 1：`aggregation: none` 在分组模式下生成非法 SQL

**现象**（真机复现）：

```sql
SELECT time_bucket("k_timestamp", '5m') AS "time", "current_val"
FROM "equipment_telemetry" WHERE ... GROUP BY "time" ORDER BY "time"
-- ERROR: column "current_val" must appear in the GROUP BY clause
             or be used in an aggregate function
```

**影响面**：降采样、gapfill、窗口三种模式都提供 `none` 选项（`AGGREGATIONS` 数组对 numeric 列全量放开），用户在编辑器里选 `none` 就直接拿到一条必错的语句，且预览里看不出问题。

**修复**：非聚合列加入 `GROUP BY`。

- 降采样 / gapfill：`GROUP BY "time", "device_id", "current_val"`
- 窗口：`GROUP BY "device_id", "current_val", TIME_WINDOW(...)` —— 窗口函数必须排在最后，否则 KWDB 报 `no other columns can follow grouped window function`

三条都已在真机验证通过。gapfill 是例外：`interpolate()` 的第一个参数必须是聚合函数，`interpolate("current_val", 'linear')` 会报 `the first parameter of interpolate must be agg func`，所以 gapfill 编辑器直接把 `none` 从下拉里去掉，并在加载旧查询时把残留的 `none` 纠正为 `avg`。

**遗留观察**：降采样选 `none` 语义上等于"返回桶内原始值"，6 小时窗口会产出 32,136 行（而不是 72 行）。SQL 合法，但图表会被打爆。默认 100,000 行的帧上限能兜住，更合理的做法是后续版本把 `none` 从降采样里也去掉，或改名为"原始值"并配上醒目提示。

### 缺陷 2：宏在字符串字面量和注释里被展开，导致 SQL 语法错误

**现象**（真机复现）：

```sql
SELECT 'range: $__timeFilter(ts)' AS note
-- 被展开成
SELECT 'range: (ts >= '2026-10-27 00:00:00'::TIMESTAMP AND ts <= ...)' AS note
-- ERROR: at or near "2026": syntax error
```

`ExpandMacros` 只对 `$__timeFilter`/`$__timeGroup` 做了括号匹配扫描，`$__timeFrom`/`$__timeTo` 是裸 `strings.ReplaceAll`，两者都不识别字面量边界。

**修复**：改成单一扫描器，字符串字面量、双引号标识符、行注释、块注释、dollar-quoted 字符串原样拷贝；宏调用整体消费（参数里的字面量不会被切开）。

**注意一个实现细节**：第一版按"先切字面量、再在代码段里展开"实现，结果 `$__timeGroup(ts, '5m')` 反而不展开了——参数里的 `'5m'` 把代码段切断，括号匹配找不到闭合括号。所以必须是宏优先的单一扫描，不能两遍走。

### 缺陷 3：最新值帧的时间列不在第一位，Grafana 不认它是时序帧

**现象**：`buildLatestSql` 的 SELECT 顺序是 `[tags..., metrics..., time]`，时间列在最后。`prepareTimeSeries` 只改名列、不调整顺序。带 tag 时帧是 Long 型，`data.LongToWide` 会把时间列提到最前，问题被掩盖；**不带 tag 时帧本身就是 Wide 型，`LongToWide` 根本不会被调用**，时间列就留在最后一位。

真机复现：`last(current_val)` 单指标查询产出的帧是 `[latest_current_val, time]`。Grafana 时序面板要求首字段是时间字段，否则按表格处理——也就是说**不带 tag 的最新值查询（Stat/Gauge 面板最典型的用法）在真机上渲染不出时序**。

**修复**：`moveTimeFirst` 在帧转换前把时间列移到首位。带 tag 和不带 tag 两条路径现在都输出 `[time, ...]`，真机已验证。

### 附带修正

`interpolate(avg(col), 0)` 改成 `interpolate(avg(col), '0')`。两种写法真机都接受，但 KWDB 文档的官方示例用的是带引号形式（`interpolate(avg(temperature), '25')`），裸数字没有文档背书，故选文档形式。原来的 `'constant'` 关键字是真机硬错误（`Interpolate/imputation method not supported`）。

## 三、SQL 语句级验证结果

`verify-real/gen.ts` 用真实源码生成 SQL，`verify-real/run.ts` 逐条执行。

**56 条：51 通过、0 失败、4 条按设计返回空串、1 条按设计被 KWDB 拒绝。**

| 分组         | 条数 | 结果                                                                                                       |
| ------------ | ---- | ---------------------------------------------------------------------------------------------------------- |
| 降采样       | 10   | 全通过（含空 interval 回退 `5m`、`1h` 前后空格、限定表名 `factory.equipment_telemetry`、可空列、`stddev`） |
| 插值         | 12   | 全通过（`linear`/`prev`/`next`/`null`/常量、大写 `PREV` 归一化、未知模式回退 `linear`、带 tag）            |
| 最新值       | 6    | 全通过（`last`/`last_row`/`first`/`first_row`、带 tag 分组、别名优先）                                     |
| 窗口/事件    | 17   | 16 通过 + 1 条按设计失败                                                                                   |
| 原始 SQL     | 8    | 全通过（含 `SHOW TABLES`、`SHOW CREATE TABLE`、`WITH` CTE、`EXPLAIN`、`$__timeFrom/$__timeTo`）            |
| 模板变量 SQL | 4    | 全通过                                                                                                     |

按设计返回空串的 4 条：EVENT_WINDOW/STATE_WINDOW 条件里带 `;` 或 `--`、COUNT_WINDOW 行数或滑步非数字。按设计失败的 1 条：gapfill + `none`（见缺陷 1）。

### 有文档依据的行为确认

查了 `docs/sql-reference` 和 `kaiwudb-agent-skills/skills/kwdb-text2sql-aiot`，几条关键约束都对上了：

- "group window queries must be used with the GROUP BY clause, and **grouping columns must precede the window function**" —— 与缺陷 1 的窗口侧修复一致，且对五种窗口函数一体适用。
- `STATE_WINDOW` 只接受单列或 `CASE WHEN ... END`。插件编辑器的 placeholder 写的正是 `CASE WHEN voltage >= 225 THEN 1 ELSE 0 END`，是对的；用户手敲 `status_code = 1` 会拿到 KWDB 的报错，提示语可以再友好一些。
- `EVENT_WINDOW` 文档说"流结束时未闭合的窗口自动视为完成"，但真机上 `EVENT_WINDOW(current_val > 20, current_val < 5)`（结束条件永不满足，该列最小值 12.7）返回 0 行。本地文档只到 3.2.1，没有 3.3.0 的文档集，**这是文档与实现的出入，不是插件缺陷**，但用户侧要知道：结束条件必须可达，否则窗口查询静默返回空。

### 模板变量查询

8 种原始写法全部正确往返（`tables() ;`、`columns("equipment_telemetry")`、`tag_values('a', 'b')`、`TABLES()`、多余空格），6 种非法写法全部被拒并给出可读错误。

## 四、后端 Go 管线验证结果

`pkg/plugin/realserver_verify_test.go`（`KWDB_VERIFY_DSN` 未设置时自动跳过），全部通过：

| 测试         | 真机结果                                                                                                                                                                                                                          |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 健康检查     | `Data source is working`                                                                                                                                                                                                          |
| 连接被拒提示 | `KWDB refused the connection - check the host and the port...` + 原始 dial 错误                                                                                                                                                   |
| 宏展开       | 5 条全对；字面量里的 `$__timeFilter` 保持原样（缺陷 2 修复后）                                                                                                                                                                    |
| 只读拦截     | 11 条放行（含 `SHOW CREATE TABLE`、字符串里的 `insert into`、标识符 `"insert"`、尾随分号注释）+ 16 条拦截（写关键字、多语句、`pg_sleep`/`nextval`、`crdb_internal`/`kwdb_internal`、`SHOW SESSIONS`/`SHOW ALL`、`GRANT`、`COPY`） |
| 会话级只读   | `default_transaction_read_only = on`、`statement_timeout = 30000`；实测 `CREATE TABLE` 被拒：`cannot execute CREATE TABLE in a read-only transaction (SQLSTATE 25006)`                                                            |
| 五种查询模式 | 全部产出正确帧；时间列均在最前                                                                                                                                                                                                    |
| 最新值分帧   | time_series 下单宽帧 + 4 个设备标签字段；table 格式下 `splitByTag` 才切 4 帧                                                                                                                                                      |
| 行数截断     | `maxRows: 1000` 精确截断并附带 warning notice                                                                                                                                                                                     |
| 元数据资源   | `/tables` 4 张表；`/columns` 正确区分数据列/主 tag/普通 tag/时间列；`/tag-values` 返回 4 个设备；非 tag 列返回 400                                                                                                                |

只读拦截这一项值得单独说：`scanForbiddenSQL` 的词法扫描在真机上和 16 条攻击样本逐一比对通过，同时 11 条合法语句（包括 `SHOW CREATE TABLE` 这种含 `CREATE` 关键字的描述性语句）没有被误杀。

## 五、Grafana 端到端验证结果

通过 `/api/ds/query` 对 `10.110.105.80:26267/factory` 实跑：

| refId | 模式             | 帧形状                                                         | 行数 |
| ----- | ---------------- | -------------------------------------------------------------- | ---- |
| A     | 降采样 + tag     | `[time, avg_current_val ×4]`（带设备标签）                     | 72   |
| B     | gapfill 常量填充 | `[time, avg_current_val]`                                      | 72   |
| C     | 最新值 + tag     | `[time, latest_current_val ×4]`（时间列在最前，缺陷 3 修复后） | 1    |

### Playwright E2E：21/21 通过

这是本地 E2E **第一次跑在真实数据上**（此前本地运行全部 skip，CI 用的是 compose 容器演示数据）。覆盖：

- 健康检查、数据源作为标注源、标注查询返回事件
- 可视化构建器：降采样、gapfill 线性插值、最新值（`last` 生成、切换函数重新生成 SQL、选 tag 后按 tag 分组）、窗口/事件六种（TIME_WINDOW、interval+slide、COUNT_WINDOW、SESSION_WINDOW、EVENT_WINDOW、STATE_WINDOW）
- 原始 SQL：table 格式、time_series 宽帧带标签
- 只读拦截：DELETE、多语句、`SELECT INTO`

### 告警链路：全链路走通

1. 通过 provisioning API 建规则（latest 查询 + reduce + threshold）
2. 调度器按 60s 周期执行，日志确认 `datasources ... Querying for data source` → `Data source queried responseType="single frame series"`
3. 阈值 `gt 13` 时：`Changing state previous_state=Normal next_state=Alerting`，`__values__ = {"B":13.23,"C":1}`（13.23 是从真实库读到的 `current_val`）
4. `Sending alerts to local notifier count=1` → alertmanager 中该告警为 `active`
5. 阈值改回 `lt 13` 后回到 `Normal`，验证完毕后规则已删除

**这意味着 `plugin.json` 里声明的 `alerting`、`annotations`、`queryOptions` 三项能力都有真机证据了。**

## 六、仍未验证 / 需要后续处理

1. **TLS（`verify-ca` / `verify-full`）**：该实例 26267 是明文端口，`health.go` 里的 TLS 错误分类、`sslRootCert` 透传、`settings.go` 的 sslMode 白名单都只有单元测试。要补这一项，需要一个开 TLS 的 KWDB 实例和对应 CA 证书。
2. **认证/库名不存在的提示**：该实例 trust 认证，任意密码和任意库名都放行，`28P01`/`3D000` 两条提示路径无法在真机触发。
3. **`last` 与 `last_row` 的空值语义**：文档说两者都取最大时间戳那一行，区别只在 `last` 排除 NULL、`last_row` 包含 NULL。`equipment_telemetry` 的 `current_val` 是 `NOT NULL`，真机上两者结果一致，无法观测差异。当指标列可空且末行为 NULL 时，`last(col)` 会退回更早的非空行，而 `last(k_timestamp)` 仍取真正的末行时间戳——两者可能不一致。**建议后续用可空列专门验一次**，必要时让时间列函数跟随 `latestFunc` 的空值语义。
4. **`EVENT_WINDOW` 结束条件不可达时静默返回空**：与本地文档（3.2.1）描述不符。建议在编辑器 placeholder 或文档里明示"结束条件必须可达"。
5. **降采样选 `none` 行数爆炸**：见缺陷 1 的遗留观察。
6. **`splitByTag` 只在 Table 格式下生效**：默认 time_series 格式下 `LongToWide` 已经按 tag 产出多个字段，语义上是自洽的，但 `types.ts` 里"default true"的注释容易让人以为它总是生效。建议在字段注释里写清。
7. **窗口区间下限**：文档要求 `TIME_WINDOW` 区间 ≥ 10ms 且只支持 ms~year（不支持 ns/us），`SESSION_WINDOW` 阈值只支持 s/m/h/d/w。插件编辑器未做校验，用户填 `500us` 会拿到数据库报错。可作为后续增强。

## 七、复现方式

```bash
cd kwdb-tsdb-datasource

# SQL 语句级（源码生成 + 逐条执行）
npx ts-node --compiler-options '{"module":"commonjs","moduleResolution":"node","target":"es2020","esModuleInterop":true,"strict":false}' verify-real/gen.ts
npx ts-node --compiler-options '{"module":"commonjs","moduleResolution":"node","target":"es2020","esModuleInterop":true,"strict":false,"types":["node"]}' verify-real/run.ts

# 后端 Go 管线
KWDB_VERIFY_DSN="postgres://root:passwd@10.110.105.80:26267/factory?sslmode=disable" \
  go test ./pkg/plugin/ -run TestRealServer -v

# E2E（数据源已指向 10.110.105.80:26267/factory）
KWDB_E2E_TABLE=factory.equipment_telemetry \
KWDB_E2E_TIME_COLUMN=k_timestamp \
KWDB_E2E_COLUMNS='k_timestamp, device_id, current_val' \
KWDB_E2E_TAG_COLUMN=device_id \
KWDB_E2E_METRIC=current_val \
GRAFANA_URL=http://localhost:3001 npx playwright test --reporter=line
```

`verify-real/` 与 `realserver_verify_test.go` 是本轮新增的验证设施，默认不跑（无 DSN 时跳过），不参与插件构建，不影响 `mage buildAll` 产物。
