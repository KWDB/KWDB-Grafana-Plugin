# KWDB TSDB 数据源插件 — 代码侧待优化项梳理

**日期**：2026-10-28
**范围**：`kwdb-tsdb-datasource` 仓库，分支 `fix/code-quality-hardening`（自 `master` 切出）
**基线**：v1.2.2，插件 ID `lumingsun-kwdbtsdb-datasource`
**说明**：本文档把对比评估和静态检查中发现的问题重新归类，区分"已在本次改动中修掉"和"还需要人工决策或真实环境验证的"。每条都给了出处，方便逐条核对。

---

## 一、本次已修掉的问题

### 1. 前端核心逻辑没有单测（已修）

`src/sqlBuilder.ts`（276 行，5 种模式的 SQL 生成）和 `src/variableQuery.ts`（模板变量查询解析）是全仓库最核心的两段纯逻辑，此前**零单元测试**——原有的 58 个 jest 用例集中在 `aggregations.test.ts` 一个文件里。

补了两份测试，合并进仓库原有的 `tests/` 目录（该目录本来就有这两个模块的旧测试文件，新文件是旧文件的超集，直接替换、避免同一模块两份测试）：

| 文件                          | 用例数 | 覆盖率                              |
| ----------------------------- | ------ | ----------------------------------- |
| `tests/sqlBuilder.test.ts`    | 69     | 语句 98.5% / 分支 97.2% / 函数 100% |
| `tests/variableQuery.test.ts` | 37     | 语句 100% / 行 100%                 |
| `src/variableSupport.test.ts` | 6      | 新增的变量支持类                    |

### 2. 测试过程中暴露出的真实代码缺陷（已修）

写测试时发现了 15 处问题，其中**会直接产生错误 SQL 或破坏往返一致性**的已经修掉：

| #   | 位置                                              | 问题                                                                                                                                                                                                                                                                                                               | 修法                                                                                                                                                        |
| --- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `src/sqlBuilder.ts` `timeExpr`                    | `timeColumn` 未 trim 就进了 `time_bucket(...)`，而 WHERE 子句用的是 trim 后的值。列名带首尾空格时 SELECT 与 WHERE 引用的列名不一致，SQL 直接报错                                                                                                                                                                   | `timeExpr` 改为接收已 trim 的 timeColumn                                                                                                                    |
| 2   | `src/sqlBuilder.ts` `aggregationExpr`             | 指标列名同样从不 trim（`table` 和 `tags` 都 trim 了，只有指标列漏了），会静默生成 `avg(" temperature ")`                                                                                                                                                                                                           | 统一 trim                                                                                                                                                   |
| 3   | `src/sqlBuilder.ts` `timeExpr` / `windowTimeExpr` | `interval \|\| '5m'` 只对 `undefined`/`''` 兜底，纯空白字符串会原样进 SQL，`time_bucket(ts, '   ')` 是硬错误                                                                                                                                                                                                       | 空白一律视为未设置                                                                                                                                          |
| 4   | `src/sqlBuilder.ts` `windowTimeExpr`              | `EVENT_WINDOW`/`STATE_WINDOW` 的条件表达式和 `COUNT_WINDOW` 的行数**原样拼接、零校验零转义**。`COUNT_WINDOW(10; DROP TABLE sensors)` 这类输入会被完整拼进语句                                                                                                                                                      | 条件片段拒绝 `;`、`--`、`/*`、`*/`；COUNT_WINDOW 参数限制为数字。后端只读校验是最后一道防线，编辑器这一层负责在用户写错时给出可预期的行为而不是让数据库报错 |
| 5   | `src/sqlBuilder.ts` `metricAlias`                 | L55/L58 是**不可达死代码**（两个调用点都已提前判断 alias 并用短路求值），也正是覆盖率里唯一没覆盖到的两行                                                                                                                                                                                                          | 删掉不可达分支，函数收敛为单一职责                                                                                                                          |
| 6   | `src/sqlBuilder.ts` `quoteQualified`              | 按 `.` 无条件切分，合法引号标识符 `"my.table"` 被改写成 `"my"."table"`                                                                                                                                                                                                                                             | 只在引号外的点才算分隔符                                                                                                                                    |
| 7   | `src/variableQuery.ts`                            | `split(',')` 不识别引号，`tag_values("my,sensors", device_id)` 被误判成参数个数错误                                                                                                                                                                                                                                | 改成引号感知的切分                                                                                                                                          |
| 8   | `src/variableQuery.ts`                            | `buildVariableQueryString` 的 switch 没有 default，运行时可能返回 `undefined`（声明类型是 `string`）；缺 table/column 时会生成 `columns()`、`tag_values(sensors, )` 这类**自己 parse 不回去**的字符串，Grafana 变量列表里显示的查询插件自己会拒绝                                                                  | 补齐 default 分支抛错；缺字段时抛错；含逗号的参数加引号保证往返                                                                                             |
| 9   | `src/variableQuery.ts`                            | 分号剥离发生在 trim 之后且不再 trim，`tables() ;`（分号前有空格）会报"不支持的变量查询"，错误信息有误导性                                                                                                                                                                                                          | 空白和分号一起从尾部剥离                                                                                                                                    |
| 10  | `src/variableQuery.ts`                            | 结构化输入只校验 `columns`/`tagValues`，其他 queryType 原样放行；且返回的是**入参对象引用**，调用方改动会污染解析结果                                                                                                                                                                                              | 穷举校验 + 返回拷贝                                                                                                                                         |
| 11  | `src/variableQuery.ts`                            | 正则过松，`columns(a)(b)` 会被当成表名 `a)(b` 接受                                                                                                                                                                                                                                                                 | 参数中拒绝括号                                                                                                                                              |
| 12  | `src/README.md` / `README.md`                     | 文档写"Table: long format"，但 `KwdbQueryFormat` 只有 `time_series \| table`，没有 `long`                                                                                                                                                                                                                          | 改掉表述                                                                                                                                                    |
| 13  | `src/sqlBuilder.ts` `windowTimeExpr`              | **COUNT_WINDOW 的行数没有默认值，而编辑器"Row limit"字段显示 `100`**。刚切到 COUNT_WINDOW 时模型里 `windowInterval` 是 `undefined`，生成的 SQL 是空字符串——用户看着字段里写着 100，SQL 预览却是空的。而且因为是 React 受控组件，把字段设成它已经显示的值不会触发 `onChange`，用户想靠输入"100"把预览弄出来也做不到 | 生成侧默认 `100`，与编辑器一致。这一条是 e2e 跑出来的（在 Grafana 容器 + KWDB 容器环境）                                                                    |
| 14  | `tests/queryChanges.test.ts`（新增）              | `tableChangePatch` / `windowTypeChangePatch` 这两个切换表/窗口类型时重置字段的纯逻辑模块没有测试，而它们的语义（`windowInterval` 在 TIME_WINDOW 是时长、在 COUNT_WINDOW 是行数，所以切换时必须清掉）很容易被后来人改错                                                                                             | 补 8 个用例                                                                                                                                                 |

> 第 13 条说明一件事：**e2e 跑一遍能发现单测发现不了的问题**。受控输入框"显示值和模型值不一致"这类问题，单元测试只会按给定的模型算 SQL，永远不会撞上。

### 3. 变量支持 API 已废弃（已修）

`src/module.ts` 用了 `setVariableQueryEditor`，Grafana 已标记为 deprecated，建议改用数据源实例上的 `variables` 属性。这是全仓库最后一个 deprecation 警告（eslint 从 26 条降到 25 条，剩下 25 条是 UI 组件 deprecation，见第三节）。

迁移方式：新建 `src/variableSupport.ts`，继承 `CustomVariableSupport`，在 `KwdbDataSource` 构造函数里赋给 `this.variables`。变量查询的执行路径从 Grafana 的 legacy `metricFindQuery` 分支切到 `variables.query()`，所以补了 `src/variableSupport.test.ts`（6 个用例）覆盖：target 透传、scopedVars/range 转发、空 target、错误传播、text/value 映射。

> `KwdbVariableQuery` 故意不继承 `DataQuery`（变量查询没有 refId，Grafana 也只读 `queryType`/`table`/`column`），所以泛型参数用 `any` 并在 request target 上重新断言具体类型，这一点在文件注释里写明了。

### 4. 健康检查的错误提示对普通用户不友好（已修）

原来 `CheckHealth` 直接返回脱敏后的原始数据库错误（带 SQLSTATE）。对 DBA 有用，但配错密码/端口/库名的用户看到的是 `ERROR: password authentication failed for user "root" (SQLSTATE 28P01)` 这种。

新增 `pkg/plugin/health.go`：按 SQLSTATE 和错误类型分类，在原始错误**前面**加一句人话判断，原始错误保留（DBA 仍然看得到 SQLSTATE）。覆盖：认证失败、库不存在、权限不足、连接异常类（08）、超时、连接被拒、TLS 握手/证书失败。

配套新增 `pkg/plugin/health_test.go`（19 个用例）和 `pkg/models/settings_test.go`。

### 5. 连接参数没有前置校验（已修）

`port` 是自由整数，用户填 99999 时 `pgxpool.ParseConfig` 才报错，错误信息难懂；`sslmode` 如果被手工改成 pgx 的 `allow`/`prefer`，会**静默降级成明文连接**——正是这个插件刻意避免的行为。

在 `models.DataSourceSettings` 上新增 `Validate()`，`NewDatasource` 在应用默认值之后调用：端口限制 1–65535，sslmode 只接受 UI 提供的四种（`disable`/`require`/`verify-ca`/`verify-full`），池参数不允许负值。查询超时和行数上限的 0/负数是有意义的取值（"用默认值"/"不限制"），不拦截。

### 6. CI 只跑元数据校验（已修）

`.github/workflows/ci.yml` 里插件校验只有 `-analyzer=metadatavalid` 一项，全量校验只在 `release.yml`，而发版流程**从未实跑过**。

新增独立的 `plugin-validator` job：复用 build 产物打包，跑 `@grafana/plugin-validator@0.50.0` 全量 analyzer，和 release.yml 用同一条命令。产物是未签名的，所以 `unsigned plugin` analyzer 会报一条 warning——这是每个 PR 都会出现的预期结果，不会让 job 失败。

顺带修了 `docker logs kaiwudb-kwdbtsdb-datasource` 这个硬编码容器名（名字由 create-plugin 生成进 `.config`，不该在这里重复），改成 `docker compose logs`。

### 7. 插件元数据（已修）

- `src/plugin.json` 的四个链接还指向改名前的 `LumingSun/kwdb-tsdb-datasource`，已更新为 `LumingSun/KWDB-Grafana-Plugin`；`README.md` 和 `src/README.md` 里的绝对图片/文档链接一并更新。
- 补了 `"category": "tsdb"`（之前没声明，影响 Grafana「Add new connection」页的分类位置）。

---

## 二、还需要人工决策或真实环境验证的

> **先说清楚这一轮到底连过什么库。** 本次改动（2026-10-28）的验证全部是：单元测试（不连库）、静态检查、构建、plugin-validator，以及 CI 上的 e2e——CI 用 `docker-compose` 自己拉 `kwdb/kwdb` 容器、以 `scripts/init.sql` 建 `demo_ts.sensors`，21 个用例在 4 个 Grafana 版本上通过。**那是容器里的演示数据。**
>
> 本地这次也起过 Grafana，但工作区到 KWDB 的 26257/26267 都不通，数据相关用例全部 skip，没有真跑。
>
> 真正的真实库实测在 `docs/quality-review-2026-10-22.md`：Grafana 13.1.0 + KWDB `10.110.105.80:26267/factory`、`equipment_telemetry` 468 万行。下面标"已在真实库上复现并修复"的条目，依据的是那份记录，不是本轮。

### 1. 窗口表达式没有进 SELECT 列表（设计问题，非正确性风险）

`buildWindowSql` 把窗口表达式只放在 `GROUP BY`，SELECT 里只有 `first(time) AS "time"`、tag 列和指标列。结果是**结果集里没有任何一列能标识每行属于哪个 window/session/event/state**。KWDB 自己的参考示例都会把窗口表达式 select 出来（例如 `TIME_WINDOW(ts,'1h') AS window`）。

注意这条**不是"改之前必须实测"**：`docs/quality-review-2026-10-22.md` 的真实 KWDB 矩阵里，`TIME_WINDOW`/`SESSION_WINDOW`/`COUNT_WINDOW`/`EVENT_WINDOW`/`STATE_WINDOW` 五种都执行成功了，说明现在的 SQL 是真能跑的。要改是为了可用性（让用户看出每行属于哪个窗口），代价是改变所有窗口查询的输出结构并影响 `frame.go` 的列识别。属于产品决策，不是阻塞项。

### 2. `last_row` / `first_row` 的语义不一致 —— 已在真实库上复现并修复

`latestTimeExpr` 曾经在 `latestFunc` 为 `last_row`/`first_row` 时仍然对时间列用 `last()`/`first()`（排除 NULL），而指标列用 `last_row()`/`first_row()`（包含 NULL），导致值与时间错位。这一条**在 2026-10-22 已经于 `10.110.105.80:26267/factory` 的 `equipment_telemetry`（468 万行）上真机复现**（评审报告 F2），当前代码已改为跟随 `latestFunc` 映射，并有单测固定。

仍未验证的只剩：时间列本身可能为 NULL 时 `last()` 与 `last_row()` 的取值差异，以及 `last_row_ts()`/`first_row_ts()` 在目标版本是否可用。这需要一台时间列可空的表才能触发，不是常见场景。

### 3. `interpolate` 常量模式 —— 已在真实库上复现并修复

曾经生成 `interpolate(avg(v), 'constant')`，**在 2026-10-22 的真机实测中返回 400**（评审报告 A1/F1：`'constant'` 不在 KWDB 插值白名单）。当前代码已改为输出数值常量 `interpolate(avg(v), 0)`，`tests/sqlBuilder.test.ts` 有"renders the constant mode as a numeric literal"固定该行为。

遗留的小问题：`normalizeInterpolateConstant` 把 NaN/Infinity 一律静默变成 0，UI 填错了不报错而是默默补 0。

### 4. 模板变量不支持级联（功能缺口，非缺陷）

`metricFindQuery` 没有调用 `getTemplateSrv().replace()`，所以 `tag_values($schema.$table, $column)` 这种用其他变量拼出来的表名不会生效。Grafana 官方指南明确建议做这件事。改动不大，但会改变变量查询的行为，需要单独一个改动加测试。

### 5. `Select` / `MultiSelect` / `VerticalGroup` 已被废弃（25 条 eslint warning）

`@grafana/ui` 13 里这些组件标记为 deprecated，建议改用 `Combobox` / `Stack`。涉及 10 个文件，且 e2e 的 `pickOption` helper 依赖 `getByRole('combobox')` 的选择器语义——换成 `Combobox` 后 e2e 选择器很可能要跟着改。**不建议在发布前做**，风险收益不划算；`grafanaDependency` 声明的是 `>=13.1.0`，这些 API 在 13.x 全系列都还能用。建议作为发布后的第一个专项。

### 6. `.config/` 里残留脚手架时期的旧插件 ID

`.config/docker-compose-base.yaml`、`.config/supervisord/supervisord.conf` 里到处是 `kaiwudb-kwdbtsdb-datasource`（最初脚手架用的 org 是 `kaiwudb`）。`.config/` 由 create-plugin 管理、不能手改，正确做法是用当前 org 重新生成后整目录覆盖。

实际影响有两处，都不是功能故障：

- `GF_PLUGINS_ALLOW_LOADING_UNSIGNED_PLUGINS` 列的是旧 ID，但生成的 Dockerfile 里 `GF_DEFAULT_APP_MODE=development` 是硬编码的，dev 模式下未签名插件一律放行，所以本地和 CI e2e 都不受影响（已核对 Grafana 源码 `pkg/plugins/manager/signature/authorizer.go`）。
- `GF_LOG_FILTERS: plugin.kaiwudb-kwdbtsdb-datasource:debug` 指向一个不存在的 logger 名，**我们插件的 debug 日志实际上被丢掉了**。这是个真实的观测性缺陷。

建议等插件 ID 方案定了（是否沿用 `kwdb-datasource`）之后，连同 ID 切换一起重新生成 `.config/`，一次做完。

### 7. TLS 的真实链路没实测过

`verify-ca` / `verify-full` 需要一台开了 TLS 的 KWDB 才能验证，2026-10-22 的评审也把这条列在未验证范围里。逻辑上 `sslrootcert` 已经透传、`sslMode` 白名单已收紧，但没有端到端证据。这是发布前唯一还完全空白的链路，建议上线前找一台开 TLS 的实例补一次。

### 8. 告警/注解的测试覆盖

`plugin.json` 声明了 `alerting: true` 和 `annotations: true`，后端确实复用同一条查询链路。本次补了 3 个 e2e spec，在 CI 的容器环境（4 个 Grafana 版本）上通过；2026-10-22 的评审则把 annotations/alerting 的实际路径列为未验证。**告警规则本身（创建规则 → 触发 → 收到通知）至今没有任何覆盖**，提交审核时几乎一定被问到。

### 9. e2e 跑出来的三个新发现

e2e 是在 **Grafana 容器 + KWDB 容器**（`docker-compose` 起的 `kwdb/kwdb`，数据来自 `scripts/init.sql` 的 `demo_ts.sensors`）上跑的。子代理报告它当时拿到过 13 passed / 21 passed，但**没有记录连的是哪台 KWDB**；CI 上的 21 passed 可以确认是容器库。这三件事都是在有真实 KWDB 引擎参与的条件下发现的，但**不是在 80 服务器上**：

1. **窗口查询在长时间范围上会撑爆 KWDB 的内存预算。** `TIME_WINDOW(ts, '1h', '15m')` 跑 30 天直接报 `group-window-func: memory budget exceeded`，滑动窗口和 `COUNT_WINDOW` 最严重。这是数据库侧限制，不是插件的问题，但用户一定会撞上，所以两个 README 的 Troubleshooting 里都加了说明（缩窄时间范围，或者去掉 slide 让窗口边界和范围对齐）。e2e 的窗口用例因此用短的配置化时间范围。
2. **注解查询必须用 Table 格式。** Grafana 从 `time` 列加一个文本列推导注解事件，构建器查询默认给的是 `time_series` 格式，会报 `could not convert frame to time series`。后端已有的错误信息写得很清楚（"select Table format for non-time results"），README 也补了说明。没有改成自动降级——静默换格式会掩盖真正的配置错误，明确报错更好。
3. **`AnnotationEditPage.runQuery()` 本身有竞态。** Grafana 的注解编辑器每次变更都会重发 `/api/ds/query`，`runQuery()` 可能拿到另一个在途请求的响应体。这是 `@grafana/plugin-e2e` 的问题，spec 里改成按请求体里的 SQL 片段匹配响应绕过了。

### 10. 发布流程遗留

- `GRAFANA_ACCESS_POLICY_TOKEN` 还没配到仓库 Secrets，`release.yml` 的签名步骤目前是跳过的。
- tag `v1.2.2` 还没打；本次改动对应 `v1.2.3`。
- `docs/api-dashboard-automation.md` 原先一直未跟踪，本次已提交（它是一份已在 Grafana 13.1.0 + KWDB 上验证过的 API 自动化指南）。
- `docs/plugin-comparison-2026-10-28.md`（给研发/开源负责人的对比报告）**故意没有提交**，留在工作区，由你决定是否归档。

---

## 三、本次新增/改动的文件

**新增**

- `src/variableSupport.ts` — 变量支持类，替代废弃的 `setVariableQueryEditor`
- `src/variableSupport.test.ts` — 6 个用例
- `pkg/plugin/health.go` — 健康检查错误分类
- `pkg/plugin/health_test.go` — 19 个用例
- `pkg/models/settings_test.go` — 连接参数校验测试
- `tests-e2e/latest-value.spec.ts` — 最新值模式 3 个用例
- `tests-e2e/window-event.spec.ts` — 窗口/事件模式 6 个用例
- `tests-e2e/annotations.spec.ts` — 注解 3 个用例
- 本文档

**改动**

- `src/module.ts` — 移除废弃的变量编辑器注册
- `src/datasource.ts` — 构造函数里挂 `variables`
- `src/types.ts` — `KwdbVariableQuery` 注释说明；`format` 字段注释说明不影响 SQL
- `src/variableQuery.ts` — 上述 5 处修复
- `src/sqlBuilder.ts` — 上述 6 处修复，外加 COUNT_WINDOW 默认行数
- `src/plugin.json` — 链接地址、`category`
- `README.md` / `src/README.md` — 仓库地址、"long format" 表述、窗口内存预算与注解格式两条 Troubleshooting
- `pkg/plugin/datasource.go` — `CheckHealth` 用人话错误
- `pkg/plugin/connection.go` — 调用 `Validate()`
- `pkg/models/settings.go` — 新增 `Validate()`
- `tests/sqlBuilder.test.ts` / `tests/variableQuery.test.ts` — 用更完整的版本替换
- `tests/queryChanges.test.ts`（新增）— 表/窗口类型切换时的字段重置
- `.github/workflows/ci.yml` — 全量 validator job、去掉硬编码容器名

---

## 四、验证结果

| 项                         | 结果                                                                                                        |
| -------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `tsc --noEmit`             | 通过                                                                                                        |
| `eslint .`                 | 0 error，25 warning（均为 UI 组件 deprecation，见第二节 5）                                                 |
| `jest`                     | 7 suites / 148 tests 全通过                                                                                 |
| `go test ./pkg/...`        | 通过                                                                                                        |
| `go vet ./pkg/...`         | 通过                                                                                                        |
| `gofmt -l pkg/`            | 干净                                                                                                        |
| `webpack --env production` | 通过                                                                                                        |
| `mage buildAll`            | 6 个平台二进制通过                                                                                          |
| 全量 plugin-validator      | 仅 `unsigned plugin` 一条 warning（未发布插件的预期结果）                                                   |
| e2e（CI 容器库）           | 新 spec 13 passed；全套回归 21 passed / 0 failed                                                            |
| e2e（本机）                | 数据相关用例全部 skip——工作区到 KWDB 26257/26267 均不通                                                     |
| 真实 KWDB（80 服务器）     | **本轮未执行**。真实库实测见 `docs/quality-review-2026-10-22.md`（`10.110.105.80:26267/factory`，468 万行） |

> **CI 全量 validator 第一次实跑就抓到两个真问题**，这正是把它接进 CI 的理由：
> ① 改了 Go 文件没有重新 `mage buildAll`，`go_plugin_build_manifest` 里的 sha256 对不上，`go-manifest` analyzer 直接报错，LLM review 和 code diff 都被跳过；
> ② `actions/upload-artifact` **不保留文件权限**，后端二进制从 artifact 里取出来是 0644，而 `binarypermissions` analyzer 要求严格 0755。playwright job 里本来就有 `chmod +x ./dist/gpx_*` 这一步（同一个原因），validator job 漏了。
> 两个都在本地复现并修掉。`release.yml` 不受影响——它在同一个 job 里构建完直接打包，没有 artifact 往返。

> 沙箱内 Go 工具链需要用模块缓存里已有的 1.26.5，且 `GOMODCACHE` 指向 `/private/tmp/gomodcache`，否则会因为无法写锁文件而失败。命令：
> `GOCACHE=/private/tmp/kwdb-gocache GOMODCACHE=/private/tmp/gomodcache GOPROXY=off <toolchain>/bin/go test ./pkg/...`
