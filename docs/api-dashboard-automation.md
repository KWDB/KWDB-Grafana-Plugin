# Grafana API 自动化使用指南（KWDB 数据源）

通过 Grafana HTTP API 完成「接入 KWDB 数据源 → 创建图表（SQL / time_bucket 降采样 / latest 最新值）→ 获取分享与嵌入链接」的全流程说明。本文中的所有示例均已在 Grafana 13.1.0 + KWDB 时序引擎上实际验证通过（2026-09）。

## 1. 认证方式

```bash
# 推荐：Service Account Token（Service accounts → 新建 token）
curl -H "Authorization: Bearer <token>" http://localhost:3001/api/...

# 本地调试可用 Basic（admin 账号）
curl -u admin:admin http://localhost:3001/api/...
```

保存 dashboard / 数据源需要 **Editor 及以上**权限；只读访问 Viewer 即可。

## 2. 接入 KWDB 数据源：`POST /api/datasources`

### 请求体

```json
{
  "name": "KWDB-API",
  "type": "lumingsun-kwdbtsdb-datasource",
  "access": "proxy",
  "uid": "kwdb-api",
  "jsonData": {
    "host": "db.example.com",
    "port": 26257,
    "database": "example_db",
    "user": "readonly_user",
    "sslMode": "disable",
    "maxConns": 8,
    "connectTimeout": 5
  },
  "secureJsonData": { "password": "your-password" }
}
```

### 要点

- `type` 固定为插件 ID `lumingsun-kwdbtsdb-datasource`，插件须已在 Grafana 注册并启用。
- 非敏感配置一律放 `jsonData`，密码只放 `secureJsonData`。
- **`uid` 强烈建议显式指定**：后续建图直接引用该 uid；重复 POST 同 uid 内容即更新（幂等）。
- 创建后立刻验证连通性：

```bash
curl -u admin:admin http://localhost:3001/api/datasources/uid/kwdb-api/health
# {"message":"Data source is working","status":"OK"}
```

- 修改连接信息用 `PUT /api/datasources/uid/{uid}`，不传 `password` 时保持原值不变。

### 常用资源接口（插件自带）

| 接口 | 用途 |
| --- | --- |
| `GET /api/datasources/uid/{uid}/resources/tables` | 列表，区分 `TIME SERIES TABLE` 与普通表 |
| `GET /api/datasources/uid/{uid}/resources/columns?table=X` | 列 / tag / 时间列信息 |
| `GET /api/datasources/uid/{uid}/resources/tag-values?table=X&column=Y` | tag 值 |

## 3. 创建图表：`POST /api/dashboards/db`

### 顶层请求体

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `dashboard` | object | Dashboard JSON 本体（必填） |
| `overwrite` | bool | `true` 时同 title 已存在则直接覆盖 |
| `message` | string | 保存说明，写入版本历史 |
| `folderUid` / `folderId` | — | 存入指定文件夹，缺省为根目录 |

版本冲突规则：title 已存在且不带 `version` → 412；带 `dashboard.version` 走乐观锁；`overwrite: true` 直接覆盖。

**幂等技巧**：给 `dashboard.uid` 固定值，反复 POST 即"存在则更新，不存在则创建"。

### Dashboard 主体常用字段

```json
{
  "title": "...",
  "uid": "apiflow",
  "tags": ["api-demo"],
  "schemaVersion": 41,
  "time": { "from": "now-6h", "to": "now" },
  "refresh": "1m",
  "templating": { "list": [] },
  "panels": []
}
```

注意：**保存会整体替换 `tags`**，脚本更新时须把旧 tags 一并带上。

### Panel 字段速查

```json
{
  "id": 1,
  "type": "timeseries",
  "title": "...",
  "datasource": { "type": "lumingsun-kwdbtsdb-datasource", "uid": "kwdb-api" },
  "gridPos": { "h": 9, "w": 12, "x": 0, "y": 0 },
  "targets": [ … ],
  "fieldConfig": {
    "defaults": {
      "unit": "celsius",
      "min": 0, "max": 100,
      "thresholds": { "mode": "absolute", "steps": [ {"color":"green","value":null}, {"color":"red","value":90} ] },
      "custom": { "drawStyle": "line", "lineInterpolation": "smooth", "fillOpacity": 20 }
    },
    "overrides": []
  },
  "options": { "legend": { "displayMode": "list", "placement": "bottom" } },
  "repeat": "变量名", "repeatDirection": "h"
}
```

`timeseries` 面板的显示配置主要在 `fieldConfig.custom`（line/bar/points、fill、width 等）；`table` 面板的 `options` 里配置 `showHeader` / `footer` 等。

## 4. Target 写法（核心）

### 4.1 Target 通用字段

| 字段 | 说明 |
| --- | --- |
| `refId` | 查询引用 id（A/B/C…） |
| `hide` | `true` 时不画出来 |
| `version` | 可选，数据源自行维护 |
| `mode` | **插件查询模式字段，决定 UI 编辑器与后端 frame 行为**，见 §5 |
| `format` | `time_series` / `table` |
| `rawSql` | **真正执行的 SQL，后端只看这个** |
| `maxDataPoints` | 建议传，配合统一的 interval 计算 |

### 4.2 SQL（raw）模式示例

```json
{
  "refId": "A", "mode": "raw", "format": "time_series",
  "rawSql": "SELECT time_bucket(k_timestamp, '1m') AS time, avg(env_temperature) AS \"温度\", avg(env_humidity) AS \"湿度\" FROM example_environment WHERE workshop_id = 'WS-01' AND $__timeFilter(k_timestamp) GROUP BY time ORDER BY time"
}
```

_macros_ 宏（保留微秒精度）：

| 宏 | 展开 |
| --- | --- |
| `$__timeFilter(k_timestamp)` | `k_timestamp >= '<from>' AND k_timestamp <= '<to>'` |
| `$__timeFrom` / `$__timeTo` | 单边时间比较 |
| `$__timeGroup(time_col, '5m')` | `time_bucket(time_col, '5m')` |
| `$__interval` / `$__interval_ms` | Grafana 动态步长 |

### 4.3 插件 downgrade（downsampling）/ gapfill / latest / window 模板模式

这几种模式在 UI 里有低代码编辑器，保存时前端用 `sqlBuilder.ts` 自动生成 `rawSql`。**通过 API 保存时必须把等价的 `rawSql` 一并写进 target**，规则同 `sqlBuilder.ts`（实例见下）。

`downsampling`（表内降采样，内部 `time_bucket`）：

```json
{
  "refId": "A", "mode": "downsampling", "format": "time_series",
  "table": "example_environment", "timeColumn": "k_timestamp",
  "interval": "5m", "tags": ["workshop_id"],
  "metrics": [{ "column": "env_temperature", "aggregation": "avg", "alias": "温度" }],
  "rawSql": "SELECT time_bucket(\"k_timestamp\", '5m') AS \"time\", \"workshop_id\", avg(\"env_temperature\") AS \"温度\" FROM \"example_environment\" WHERE \"k_timestamp\" >= $__timeFrom AND \"k_timestamp\" <= $__timeTo GROUP BY \"time\", \"workshop_id\" ORDER BY \"time\", \"workshop_id\"" }
```

`gapfill`（补零/插值）：把 `time_bucket` 换成 `time_bucket_gapfill`，metric 外包 `interpolate(expr, 'linear'/'PREV'/'NEXT'/'constant'/'NULL')`，其余同上。

`latest`（最新值，对应 `last/last_row/first/first_row` 函数）：

```json
{
  "refId": "A", "mode": "latest", "format": "table",
  "table": "example_environment", "timeColumn": "k_timestamp",
  "latestFunc": "last", "splitByTag": true,
  "metrics": [{ "column": "env_temperature", "aggregation": "last", "alias": "latest_env_temperature" }],
  "rawSql": "SELECT \"workshop_id\", last(\"env_temperature\") AS \"latest_env_temperature\", last(\"k_timestamp\") AS \"time\" FROM \"example_environment\" WHERE \"k_timestamp\" >= $__timeFrom AND \"k_timestamp\" <= $__timeTo GROUP BY \"workshop_id\"" }
```

`window`（TIME/SESSION/EVENT/COUNT/STATE_WINDOW）：模板字段 `windowType` / `windowInterval` / `windowSlide` / `eventStartCond` / `eventEndCond`，同样按 `sqlBuilder.ts` 的 `buildWindowSql` 样式补 `rawSql`。

## 5. mode 字段的语义边界（重要）

**后端只执行 `rawSql`**（`datasource.go`：`sql := ExpandMacros(qm.RawSql, timeRange)`）；`table`/`metrics`/`interval` 等模板字段后端不消费。mode 的实际作用只有 3 处：

1. **前端 UI**：按 mode 切换 Downsampling/Gapfill/Latest/Window/SQL 编辑器（`QueryEditor.tsx`）。
2. **format 兜底**（`resolveFormat`）：builder 模式在未显式传 `format` 时默认 `time_series`；`raw` 保持原样。
3. **latest 拆分**（`frame.go`）：`mode: 'latest'` 且有 tags 时才按 tag 组合把结果拆成多 frame；`mode: 'raw'` 不会。

因此：

| 场景 | 推荐 |
| --- | --- |
| API 自动化建图 | 全用 `mode: 'raw'` + `rawSql`，可控且不踩隐式行为 |
| 需要 last 值按 tag 拆 series | 才保留 `mode: 'latest'` + 同款 rawSql |
| UI 编辑 | 模板模式好上手，随时用 SqlPreview 看最终 SQL |

**API 使用模板模式时的隐性坑**：只送模板字段而不写 `rawSql`，后端会拿空 SQL 执行，直接报错 `only read-only queries (SELECT/SHOW/EXPLAIN/WITH) are allowed`。

## 6. 验证查询：`POST /api/ds/query`

```json
{
  "from": "1790131017818",
  "to": "1790131117818",
  "queries": [ { "refId": "A", "datasource": {"type":"...","uid":"..."}, "...target字段同面板..." } ]
}
```

响应按 refId 回 frame，可检查 `frames[0].data.values` 行数与列名。

### ⚠️ from / to 必须是字符串

Grafana 的 `MetricRequest.from/to` 是 string 类型，传数字会 `400 bad request data`。GMT epoch 毫秒当成 **字符串** 传。

## 7. KWDB SQL 书写注意（实测踩过的坑）

- **`time_bucket` 参数顺序**：`time_bucket(k_timestamp, '1m')` —— 时间列在前、间隔在后（与 TimescaleDB 相反）。写反会报 `unknown signature: time_bucket(STRING, TIMESTAMPTZ)`。
- **字符串大小写敏感**：表里的 `WS-01` 与 `'ws-01'` 不同，where 条件写错大小写会得到 0 行而不是报错。建议 tag 值用 `tag-values` resource 拉取后再代入。
- **时间列别名名为 `time` 且升序**，才能被转换成 Grafana 时序 frame。
- 后端只接受 `SELECT/SHOW/EXPLAIN/WITH` 开头的单条只读 SQL，带写关键字会被拒绝。

## 8. 分享链接与嵌入

API 层面没有专门的"分享接口"，链接由 dashboard URL 拼参数而成：

| 目的 | URL |
| --- | --- |
| 普通分享 | `http://host:3001/d/{uid}/{slug}?from=now-6h&to=now` |
| 大屏（隐藏侧栏） | `...?kiosk=tv&from=now-6h&to=now` |
| **单面板嵌入** | `http://host:3001/d-solo/{uid}/{slug}?panelId=<panel.id>&from=now-6h&to=now&theme=light` |

- `panelId` 是建 dashboard 时 panel 的 `id`（也可 `GET /api/dashboards/uid/{uid}` 从返回里拿到）。
- `from=now-6h` 这类相对时间在 iframe 打开时才解析，所以是"动态时间"：不同时刻打开同一链接，看到的起点自动推移。
- 嵌入第三方页面需 `GF_SECURITY_ALLOW_EMBEDDING=true`（项目 compose 已开启），否则浏览器 `X-Frame-Options` 拦 iframe。
- 模板变量可用 `var-<name>=<value>` 传给链接。

## 9. 辅助 REST 接口

| 接口 | 用途 |
| --- | --- |
| `GET /api/dashboards/uid/{uid}` | 读完整 JSON（编辑的基础：GET→改→POST 回写） |
| `GET /api/search?query=` | 搜索 dashboard |
| `DELETE /api/dashboards/uid/{uid}` | 删除 |
| `GET /api/dashboards/id/{id}/versions` | 版本历史 |
| `POST /api/dashboards/id/{id}/restore` | 回滚 |
| `GET /api/datasources` / `POST` / `PUT` / `DELETE` | 数据源 CRUD |

## 10. 完整可复现的端到端流程（已在本地验证）

以仓库根目录的 `docker-compose` 环境为例（Grafana `localhost:3001`，admin/admin）：

```bash
# 1. 建数据源
curl -u admin:admin -H 'Content-Type: application/json' -X POST http://localhost:3001/api/datasources -d '{
  "name": "KWDB-API", "type": "lumingsun-kwdbtsdb-datasource", "access": "proxy",
  "uid": "kwdb-api",
  "jsonData": {"host": "db.example.com", "port": 26257, "database": "example_db", "user": "readonly_user", "sslMode": "disable"},
  "secureJsonData": {"password": ""}
}'
# 2. 验证健康
curl -u admin:admin http://localhost:3001/api/datasources/uid/kwdb-api/health
# 3. 建 dashboard（payload 含 4 种 target：raw time_bucket / downsampling / latest / raw table）
# 见 §4 示例，组装好的 dashboard JSON POST /api/dashboards/db
# 4. 拼分享/嵌入链接
# 5. 用 POST /api/ds/query 校验每个 target 的行数/列名
```

### 验证时的常见报错一览

| 报错 | 原因 | 解决 |
| --- | --- | --- |
| `only read-only queries …` | target 的 `rawSql` 为空（模板字段没带 SQL）或 SQL 含写关键字 | 把 builder 同款 SQL 补到 `rawSql` |
| `bad request data`（/api/ds/query 400） | `from`/`to` 传了数字 | 改为字符串 |
| `unknown signature: time_bucket(STRING, TIMESTAMPTZ)` | `time_bucket` 参数顺序写反 | 时间列在前 |
| 查询成功但 0 行 | 字符串过滤条件大小写不匹配 | 用 `tag-values` 检查真实值 |

## 11. MCP Server 封装（可选，不在本仓库）

> 本仓库不包含 MCP server 的实现；本节只描述一种可选的封装方式，代码不在这个仓库里。

可以把上述 API 封装成 MCP server（例如 Streamable HTTP，`POST /mcp`），让 AI 客户端直接调用工具完成本文件的流程。封装层需要自行负责：

- 模板模式自动补 `rawSql`（与 UI 保存等价，避免 §5 的坑）
- 参数校验 + `aggregation` 白名单（防 SQL 注入）
- 只读守卫（与插件后端的规则保持一致）
- dashboard 写保护（例如只允许 `mcp-*` uid / `mcp-managed` tag）
- 保存 dashboard 时自动绑定 datasource（不依赖 org 默认数据源）

## 12. 待改进项（插件侧）

1. 后端可考虑：当 target 为 builder 模式但 `rawSql` 为空时，在 Go 侧按 `sqlBuilder.ts` 逻辑兜底生成 SQL，避免「模板字段齐全却报只读错误」的体验断层。
2. `resolveFormat` 的隐式默认（builder 模式 → time_series）值得写进 README，API 用户常以「没写 format」踩坑。
3. （可选）`Interpolate` 相关：当前 gapfill 的 `interpolate()` 直接透传 KWDB，参数校验只在 UI 端做了有限校验，后端可加一层防御。
