# KWDB Grafana Data Source Plugin - Design Spec

**Date:** 2026-08-04
**Status:** Approved (pending spec review)
**Plugin type:** Grafana data source plugin (backend + frontend)
**Target database:** KWDB time-series engine

## 1. Overview

This plugin enables Grafana to query and visualize time-series data stored in KWDB's time-series database engine. KWDB exposes a PostgreSQL wire protocol on port 26257; the plugin connects via `pgx/v5` + `pgxpool` in the Go backend and provides a visual query builder on the frontend for KWDB-specific time-series SQL patterns.

### Scope decisions

- **Full-featured first version:** Config page, multi-mode visual query builder, read-only enforcement, Data Frame type mapping, time_series long-to-wide conversion, query macros, Docker dev setup, and tests.
- **Visual query builder with full multi-mode:** Downsampling, Gapfill (interpolation), Latest Values, Window/Event, and Raw SQL modes.
- **Time-series databases only:** The builder surfaces TS tables and their tag/data columns. Cross-model queries are available in Raw SQL mode but not in the visual builder.
- **Two output formats:** Time series (long-to-wide via SDK `LongToWide`) and Table (long format as-is).
- **Username/password authentication only:** sslMode selector included, but no TLS certificate file fields in this version.

## 2. Architecture

The plugin follows Approach B: layered with per-mode decomposition. Each concern has its own file on the backend, and each query mode has its own component on the frontend. SQL generation lives in a testable utility module separate from React components.

### 2.1 Directory structure

```
kwdb-tsdb-datasource/
  src/                                # Frontend
    plugin.json                       # Plugin manifest (backend: true)
    module.ts                         # Plugin entry point
    types.ts                          # Shared TS types (query model, config options)
    datasource.ts                     # DataSourceApi (delegates to backend)
    sqlBuilder.ts                     # Structured query model -> SQL (pure functions)
    components/
      ConfigEditor.tsx                # Data source config page
      QueryEditor.tsx                 # Top-level router by query mode
      config/
        ConfigFields.tsx              # Individual config form field components
      querybuilder/
        QueryEditorToolbar.tsx        # Format selector, refId, mode selector wrapper
        shared/
          TableSelector.tsx           # Dropdown of TS tables (from /metadata resource)
          ColumnPicker.tsx            # Tag + data column multi-select
          IntervalPicker.tsx          # time_bucket interval selector
          TimeColumnPicker.tsx         # Timestamp column selector
          MetricRow.tsx               # Aggregation + column + alias row
        DownsamplingEditor.tsx        # Mode: time_bucket + agg
        GapfillEditor.tsx             # Mode: time_bucket_gapfill + interpolate
        LatestValueEditor.tsx        # Mode: last/first_row
        WindowEventEditor.tsx        # Mode: TIME_WINDOW/SESSION_WINDOW/EVENT_WINDOW/etc
        RawSqlEditor.tsx             # Mode: raw SQL (advanced, syntax-highlighted)
        SqlPreview.tsx               # Read-only generated SQL preview panel
  pkg/                                # Go backend
    main.go                           # Plugin entry (datasource.Manage)
    plugin/
      datasource.go                  # QueryDataHandler + CheckHealthHandler + CallResourceHandler
      connection.go                  # pgxpool lifecycle (NewDatasource, Dispose)
      macros.go                      # $__timeFilter, $__timeFrom, $__timeTo, $__timeGroup
      executor.go                    # Read-only enforcement + SQL execution via pgxpool
      frame.go                       # Query results -> Grafana Data Frame (OID mapping, long-to-wide)
      metadata.go                    # Resource handlers: /tables, /columns?table=X
    models/
      settings.go                    # Plugin config structs (jsonData + secureJsonData)
      query.go                       # Query model structs for each mode
  Magefile.go                        # Build: build, test, sign
  go.mod
  package.json
  docker-compose.yaml               # KWDB + Grafana dev environment
  provisioning/
    datasources/
      datasources.yml               # Auto-provision KWDB data source
  tests/                            # Frontend Jest tests
    sqlBuilder.test.ts
    queryEditor.spec.ts
    configEditor.spec.ts
```

### 2.2 Data flow

```mermaid
graph TD
  A["User picks query mode + fills form"] --> B["QueryEditor.tsx"]
  B -->|structured query model| C["sqlBuilder.ts generates SQL"]
  C -->|query.rawSql stored in query.JSON| D["Grafana sends to backend"]
  D --> E["datasource.go QueryDataHandler"]
  E --> F["macros.go expands $__ macros"]
  F --> G["executor.go validates read-only + executes SQL"]
  G --> H["pgxpool -> KWDB on port 26257"]
  H --> I["frame.go converts rows to Data Frame"]
  I --> J["response.Frames back to Grafana"]
```

Key design principle: the frontend `sqlBuilder.ts` generates the actual SQL from the structured query model, so users can see exactly what will be executed. The backend receives the pre-built `rawSql` string and its job is macro expansion, read-only validation, execution, and frame conversion. Metadata resources let the frontend populate its dropdowns dynamically.

## 3. Query Model & SQL Builder

### 3.1 TypeScript query model

Each query mode maps to fields within a single `KwdbQuery` type that extends Grafana's `DataQuery`:

```typescript
type KwdbQueryMode = 'downsampling' | 'gapfill' | 'latest' | 'window' | 'raw';

interface KwdbQuery extends DataQuery {
  mode: KwdbQueryMode;
  format: 'time_series' | 'table';
  // Common fields
  table?: string;
  timeColumn?: string;        // e.g. "ts" or "k_timestamp"
  tags?: string[];            // tag columns to GROUP BY
  metrics?: MetricSpec[];     // aggregation specs
  // Downsampling
  interval?: string;          // '1m', '5m', '1h', '1d'
  // Gapfill
  interpolateMode?: 'linear' | 'PREV' | 'NEXT' | 'constant' | 'NULL';
  // Latest
  latestFunc?: 'last' | 'last_row' | 'first' | 'first_row';
  // Window/Event
  windowType?: 'TIME_WINDOW' | 'SESSION_WINDOW' | 'EVENT_WINDOW' | 'COUNT_WINDOW' | 'STATE_WINDOW';
  windowInterval?: string;
  windowSlide?: string;
  eventStartCond?: string;
  eventEndCond?: string;
  // Raw SQL
  rawSql?: string;
}

interface MetricSpec {
  column: string;
  aggregation: 'avg' | 'sum' | 'count' | 'min' | 'max' | 'stddev' | 'none';
  alias?: string;
}
```

### 3.2 SQL generation patterns

`sqlBuilder.ts` is a set of pure functions, one per mode, that take a `KwdbQuery` and return a SQL string.

**Downsampling mode:**
```sql
SELECT time_bucket("ts", '5m') AS "time",
       "device_id",
       avg("temperature") AS "avg_temperature"
FROM "ts_db"."sensor_data"
WHERE "ts" >= $__timeFrom AND "ts" <= $__timeTo
GROUP BY "time", "device_id"
ORDER BY "time", "device_id"
```

**Gapfill mode:**
```sql
SELECT time_bucket_gapfill("ts", '5m') AS "time",
       "device_id",
       interpolate(avg("temperature"), 'linear') AS "avg_temperature"
FROM "ts_db"."sensor_data"
WHERE "ts" >= $__timeFrom AND "ts" <= $__timeTo
GROUP BY "time", "device_id"
ORDER BY "time", "device_id"
```

**Latest Values mode:**
```sql
SELECT "device_id",
       last("temperature") AS "latest_temperature",
       last("ts") AS "time"
FROM "ts_db"."sensor_data"
WHERE "ts" >= $__timeFrom AND "ts" <= $__timeTo
GROUP BY "device_id"
```

**Window/Event mode (TIME_WINDOW example):**
```sql
SELECT first("ts") AS "time",
       "device_id",
       avg("temperature") AS "avg_temperature"
FROM "ts_db"."sensor_data"
WHERE "ts" >= $__timeFrom AND "ts" <= $__timeTo
GROUP BY "device_id", TIME_WINDOW("ts", '1h', '15m')
ORDER BY "time", "device_id"
```

**Raw SQL mode:** passes through `rawSql` as-is.

All identifiers are double-quoted for safety. The generated SQL is stored in `query.rawSql` and sent to the backend via `query.JSON`.

The visual builder runs entirely on the frontend and produces `rawSql`, so users can switch to raw mode to see/edit the generated SQL. This gives transparency and avoids duplicating SQL generation logic on both sides.

### 3.3 Go query model

The backend parses `query.JSON` into a struct containing at minimum a `RawSql` field:

```go
type QueryModel struct {
    Mode       string   `json:"mode"`
    Format     string   `json:"format"`
    RawSql     string   `json:"rawSql"`
    TimeColumn string   `json:"timeColumn"`
    Tags       []string `json:"tags"`
}
```

The backend does not re-generate SQL; it only uses `RawSql` for macro expansion, read-only validation, and execution. However, `TimeColumn` and `Tags` are used by `frame.go` for the `time_series` long-to-wide conversion: `TimeColumn` identifies which result column is the time field, and `Tags` identifies which columns become field labels in the wide-format frame. For Raw SQL mode where these fields may be empty, the frame converter falls back to heuristic detection (OID-based timestamp detection for the time column; non-numeric, non-time string columns as labels).

## 4. Backend Design

### 4.1 `connection.go` -- pgxpool lifecycle

`NewDatasource` reads `host`, `port`, `database`, `user`, `password`, `sslMode` from the data source settings and builds a connection string:

```
postgresql://user:password@host:26257/defaultdb?sslmode=disable
```

It creates a `pgxpool.Pool` and stores it in the `Datasource` struct. The pool is instance-scoped (one per configured data source) and is automatically created/disposed by the SDK's `instancemgmt` wrapper. `Dispose` closes the pool when settings change.

### 4.2 `macros.go` -- query macro expansion

Expands Grafana query macros before execution. Four macros supported:

| Macro | Expansion |
|-------|-----------|
| `$__timeFilter(col)` | `col >= $__timeFrom AND col <= $__timeTo` |
| `$__timeFrom` | `'2026-08-04 00:00:00'::TIMESTAMP` (from query time range `From`) |
| `$__timeTo` | `'2026-08-04 01:00:00'::TIMESTAMP` (from query time range `To`) |
| `$__timeGroup(col, 'interval')` | `time_bucket(col, 'interval')` |

Macro replacement uses regex matching (not naive string replacement) to handle macros in any position within the query. SQL with no macros is returned unchanged.

### 4.3 `executor.go` -- read-only enforcement & SQL execution

Validates SQL is read-only by checking the first keyword:

- **Allowed:** `SELECT`, `SHOW`, `EXPLAIN`, `WITH`
- **Rejected:** `INSERT`, `UPDATE`, `DELETE`, `DROP`, `CREATE`, `ALTER`, `TRUNCATE` and all others

Leading whitespace and SQL comments are stripped before keyword classification. Rejected queries return a `backend.DataResponse` with an `Error` field; they are not sent to the database.

After validation, executes the SQL via `pool.Query(ctx, sql)` where `ctx` is the context from the Grafana query request. This ensures queries are cancelled when the user navigates away or the request times out. Returns `pgx.Rows` plus column OID metadata from `rows.FieldDescriptions()`.

**Error handling:** Execution errors (connection failures, SQL syntax errors, timeouts) are caught and returned as `backend.DataResponse{ Error: err }`. The error message from pgx is passed through to Grafana, which displays it in the panel error state. Connection pool errors (e.g., pool exhausted) are also caught and surfaced the same way. Read-only validation failures return `backend.ErrDataResponse(backend.StatusBadRequest, "only read-only queries (SELECT/SHOW/EXPLAIN/WITH) are allowed")`.

### 4.4 `frame.go` -- result-to-Data-Frame conversion

Converts `pgx.Rows` into a Grafana `data.Frame`:

1. Read column names and OIDs from `rows.FieldDescriptions()`
2. Map each column's PG OID to a Grafana field type:

   | PG OID | Type | Grafana FieldType |
   |--------|------|-------------------|
   | 20, 21 | int8, int2 | int64 |
   | 23, 26 | int4, oid | int32 |
   | 700, 701 | float4, float8 | float64 |
   | 16 | bool | bool |
   | 25, 1043 | text, varchar | string |
   | 1083, 1114, 1184 | time, timestamp, timestamptz | time.Time |

3. Create `data.NewField` with the inferred type for each column
4. Iterate rows, scanning values into correctly-typed slices
5. If `format` is `time_series`:
   - Identify the time column: first check if `QueryModel.TimeColumn` is set and matches a result column name; otherwise fall back to OID matching (timestamp/timestamptz) or column name matching (`time`/`ts`/`k_timestamp`/`timestamp`)
   - Rename the time column to `time`
   - Sort rows by time ascending
   - Use the `Tags` field from `QueryModel` to identify label columns. For each result column whose name matches a tag in `Tags`, set the field's `Labels` property. For Raw SQL mode where `Tags` is empty, fall back to using non-numeric, non-time string columns as labels (SDK default `LongToWide` behavior)
   - Call SDK's `data.LongToWide` to pivot label columns into field labels, producing a wide-format time series frame
6. If `format` is `table`:
   - Return the frame as-is (long format)

Unknown OIDs default to string type to avoid data loss.

### 4.5 `metadata.go` -- resource handlers

Implements `backend.CallResourceHandler` using the SDK's `httpadapter` package with `http.ServeMux` routing:

| Route | Method | Behavior |
|-------|--------|----------|
| `/tables` | GET | Executes `SHOW TABLES FROM {database}` on the configured database, returns JSON array of table names. |
| `/columns` | GET | Takes `?table=X` query param, executes `SHOW CREATE TABLE {database}.{table}`, parses the DDL to extract column metadata (name, type, isTag, isTimeColumn, isPrimaryTag), returns JSON array of `ColumnInfo` objects. |

The DDL parser in the `/columns` handler recognizes KWDB's CREATE TABLE syntax with `TAGS (...)` and `PRIMARY TAGS (...)` clauses:

```sql
CREATE TABLE ts_db.sensors (
    ts TIMESTAMP NOT NULL,
    temperature DOUBLE,
    humidity DOUBLE
) TAGS (
    device_id INT NOT NULL,
    location VARCHAR(100)
) PRIMARY TAGS (device_id);
```

Parser output:
```json
[
  { "name": "ts", "type": "TIMESTAMP", "isTag": false, "isTimeColumn": true, "isPrimaryTag": false },
  { "name": "temperature", "type": "DOUBLE", "isTag": false, "isTimeColumn": false, "isPrimaryTag": false },
  { "name": "humidity", "type": "DOUBLE", "isTag": false, "isTimeColumn": false, "isPrimaryTag": false },
  { "name": "device_id", "type": "INT", "isTag": true, "isTimeColumn": false, "isPrimaryTag": true },
  { "name": "location", "type": "VARCHAR(100)", "isTag": true, "isTimeColumn": false, "isPrimaryTag": false }
]
```

If the DDL parser encounters an unexpected format (e.g., a relational table without `TAGS` clause, or a DDL the parser cannot fully understand), it falls back to returning all columns as data columns with `isTag: false`. This ensures the builder still populates its dropdowns even for edge cases. If `SHOW CREATE TABLE` itself fails (table not found, permission error), the resource handler returns HTTP 500 with the error message in the response body.

### 4.6 `datasource.go` -- main handler

Combines all backend concerns into one struct:

```go
type Datasource struct {
    pool    *pgxpool.Pool
    handler backend.CallResourceHandler
}
```

Implements:
- `backend.QueryDataHandler` -- loops over queries, unmarshals `QueryModel`, calls macro expansion, executor, and frame converter
- `backend.CheckHealthHandler` -- executes `SELECT 1` to verify connectivity
- `backend.CallResourceHandler` -- delegates to `metadata.go`'s handler
- `instancemgmt.InstanceDisposer` -- closes the pool on dispose

### 4.7 `models/settings.go` -- configuration structs

```go
type DataSourceSettings struct {
    Host    string `json:"host"`
    Port    int    `json:"port"`
    Database string `json:"database"`
    User    string `json:"user"`
    SSLMode string `json:"sslMode"`
}

type SecretDataSourceSettings struct {
    Password string `json:"password"`
}
```

`LoadSettings` unmarshals `jsonData` into `DataSourceSettings` and reads `password` from `decryptedSecureJSONData`.

## 5. Frontend Design

### 5.1 Configuration page (`ConfigEditor.tsx`)

Simple form with these fields:

| Field | Storage | Default | Component |
|-------|---------|---------|-----------|
| Host | `jsonData.host` | `localhost` | Grafana UI `Input` |
| Port | `jsonData.port` | `26257` | Grafana UI `Input` (number) |
| Database | `jsonData.database` | `defaultdb` | Grafana UI `Input` |
| User | `jsonData.user` | (empty) | Grafana UI `Input` |
| SSL Mode | `jsonData.sslMode` | `disable` | Grafana UI `Select` (disable/require/verify-ca/verify-full) |
| Password | `secureJsonData.password` | (empty) | Grafana UI `SecretInput` |

Extends `DataSourcePluginOptionsEditorProps<KwdbDataSourceOptions, KwdbSecureJsonData>`. All components are standard from the `@grafana/ui` library.

### 5.2 Query editor

`QueryEditor.tsx` is a top-level router. At the top sits `QueryEditorToolbar` with:
- **Mode selector** (dropdown): Downsampling / Gapfill / Latest Values / Window/Event / Raw SQL
- **Format selector**: Time series / Table

Below the toolbar, the mode-appropriate component renders.

**Shared components:**

`TableSelector.tsx` calls `datasource.getResource('/tables')` on mount and populates a dropdown of table names. On table selection, triggers a callback so the parent can re-fetch column metadata via `datasource.getResource('/columns?table=X')`.

`ColumnPicker.tsx` displays available columns from the selected table's metadata, grouped by type (tag columns vs data columns). Multi-select for tag selection; single-select for metric column.

`IntervalPicker.tsx` provides preset intervals (`1m`, `5m`, `15m`, `1h`, `6h`, `1d`) plus a custom text input.

`TimeColumnPicker.tsx` filters to only TIMESTAMP-typed columns from the table metadata.

`MetricRow.tsx` renders a single metric spec: column picker (data columns only), aggregation function selector, optional alias input. Multiple `MetricRow` instances are managed by the parent mode component.

**Mode components:**

`DownsamplingEditor.tsx` -- TableSelector, TimeColumnPicker, ColumnPicker (tags for GROUP BY), MetricRow[] for data columns + aggregation. Calls `sqlBuilder.ts` on every change to update `query.rawSql`. Generated SQL preview shown at the bottom via `SqlPreview.tsx` (read-only).

`GapfillEditor.tsx` -- Same as Downsampling, plus an Interpolation Mode dropdown (`linear` / `PREV` / `NEXT` / `constant` / `NULL`). SQL preview shows generated `time_bucket_gapfill` + `interpolate` syntax.

`LatestValueEditor.tsx` -- TableSelector, TimeColumnPicker, MetricRow[] (with function picker: `last()` / `last_row()` / `first()` / `first_row()` instead of aggregation functions), ColumnPicker (tags for GROUP BY).

`WindowEventEditor.tsx` -- TableSelector, TimeColumnPicker, window type selector (`TIME_WINDOW` / `SESSION_WINDOW` / `EVENT_WINDOW` / `COUNT_WINDOW` / `STATE_WINDOW`), window interval, optional slide interval (for `TIME_WINDOW` and `COUNT_WINDOW`), start/end condition expression inputs (for `EVENT_WINDOW`), tags for GROUP BY, MetricRow[]. Form adapts based on window type.

`RawSqlEditor.tsx` -- Grafana UI `CodeEditor` with SQL syntax highlighting. Passes `rawSql` directly. Macros still supported.

**SQL preview:**

`SqlPreview.tsx` -- a read-only panel below each visual mode showing the generated SQL string from `query.rawSql`. In Raw SQL mode, the editor itself is the input so no separate preview is shown.

### 5.3 DataSource class (`datasource.ts`)

Extends `DataSourceWithBackend<KwdbQuery, KwdbDataSourceOptions>`:

```typescript
class KwdbDataSource extends DataSourceWithBackend<KwdbQuery, KwdbDataSourceOptions> {
  getTables(): Promise<string[]> {
    return this.getResource('/tables');
  }
  getColumns(table: string): Promise<ColumnInfo[]> {
    return this.getResource(`/columns?table=${encodeURIComponent(table)}`);
  }
  getDefaultQuery(_: CoreApp): Partial<KwdbQuery> {
    return {
      mode: 'downsampling',
      format: 'time_series',
      interval: '5m',
      metrics: [{ column: '', aggregation: 'avg' }],
    };
  }
  filterQuery(query: KwdbQuery): boolean {
    if (query.mode === 'raw') return !!query.rawSql?.trim();
    return !!query.table;
  }
}
```

## 6. Development Environment & Provisioning

### 6.1 `docker-compose.yaml`

Two services:

**KWDB service:**
- Image: `kwdb/kwdb`
- Ports: `26257` (database), `8080` (admin UI)
- Persistent volume for data
- Init script creates a `demo_ts` time-series database and a `sensors` sample table with mock data so the builder has metadata to present immediately

**Grafana service:**
- Image: `grafana/grafana`
- Port: `3000`
- Mounts `./dist` to `/var/lib/grafana/plugins/kwdb-tsdb-datasource`
- Mounts `./provisioning` to `/etc/grafana/provisioning`
- `GF_DEVELOPMENT_MODE=true` (allows unsigned plugins)
- KWDB connection parameters passed as environment variables

### 6.2 `provisioning/datasources/datasources.yml`

```yaml
apiVersion: 1
datasources:
  - name: KWDB TSDB
    type: kwdb-tsdb-datasource
    access: proxy
    isDefault: true
    jsonData:
      host: kwdb
      port: 26257
      database: demo_ts
      user: root
      sslMode: disable
    secureJsonData:
      password: ""
```

Uses `host: kwdb` (the docker-compose service name) so the Grafana container resolves to the KWDB container.

### 6.3 Development workflow

- Backend: `mage build` (compiles Go binary to `dist/gpx_kwdb_tsdb_datasource`)
- Frontend: `yarn dev` (webpack watch mode bundles to `dist/`)
- Frontend changes reflect after webpack rebuild; backend changes require `docker compose restart grafana`
- `src/plugin.json` modifications require Grafana restart

### 6.4 Environment notes

- Node must be v22 (use `PATH=<node-22-bin>:$PATH`)
- `yarn` installed via `corepack enable && corepack prepare yarn@1.22.22 --activate`
- Go build: `GOCACHE=/private/tmp/kwdb-gocache`
- Mage: `MAGEFILE_CACHE=/private/tmp/kwdb-magefile GOCACHE=/private/tmp/kwdb-gocache`
- Backend tests: `go test ./pkg/...` and `go vet ./pkg/...` (not `go test ./...` which scans node_modules)

## 7. Testing Strategy

### 7.1 Backend Go tests (`pkg/plugin/*_test.go`)

**`macros_test.go`** -- Verifies each macro expands correctly with a fixed time range (`2026-01-01T00:00:00Z` to `2026-01-01T01:00:00Z`):
- `$__timeFilter(ts)` produces `ts >= '...'::TIMESTAMP AND ts <= '...'::TIMESTAMP`
- `$__timeFrom` and `$__timeTo` substitute correct timestamp literals
- `$__timeGroup(ts, '5m')` produces `time_bucket(ts, '5m')`
- Quoted and unquoted parameters handled
- SQL without macros returned unchanged

**`executor_test.go`** -- Validates read-only enforcement without a real database:
- `SELECT`, `SHOW`, `EXPLAIN`, `WITH ... SELECT ...` pass
- `INSERT`, `UPDATE`, `DELETE`, `DROP`, `CREATE`, `ALTER`, `TRUNCATE` rejected
- SQL with leading whitespace/comments classified correctly

**`frame_test.go`** -- Tests OID-to-type mapping and long-to-wide conversion using mock rows with known column types (int4, float8, timestamptz, varchar). For `time_series` format, asserts `LongToWide` produces correctly labeled fields.

**`metadata_test.go`** -- Tests DDL parser with realistic KWDB `SHOW CREATE TABLE` output (from reference docs). Asserts parser identifies time columns, data columns, tag columns, and primary tags.

**`datasource_test.go`** -- Integration tests for `CheckHealth` (success: stub `SELECT 1` returns a row; failure: stub returns error) and `QueryData` (stubs executor and frame converter).

### 7.2 Frontend tests (`tests/*.spec.ts`)

**`sqlBuilder.test.ts`** -- Pure unit tests for each SQL generator. Asserts exact SQL string output per mode. Tests multiple metrics, custom intervals, edge cases (no tags, `none` aggregation), and verifies identifiers are double-quoted.

**`queryEditor.spec.ts`** -- Renders `QueryEditor` and verifies mode selector switches form layout. Uses Grafana's `render` test harness. Asserts each mode renders correct shared components.

**`configEditor.spec.ts`** -- Verifies config form fields exist and update `jsonData` and `secureJsonData` correctly.

### 7.3 E2E tests (deferred)

Uses `@grafana/plugin-e2e` against the running Docker compose environment. Tests: configure data source, create a panel with a downsampling-mode query, assert panel renders data. E2E tests require a KWDB container; unit tests run without a database.

### 7.4 Test priority

Tests run without a live database (macro expansion, read-only validation, OID mapping, DDL parsing, SQL generation, frontend component rendering). This keeps them fast and deterministic. Integration tests stub at the pool level so they also do not need a live database.

## 8. Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| Frontend generates SQL, backend only expands macros/validates/executes | Avoids duplicating SQL generation logic; gives users transparency into generated SQL; backend stays simple |
| Per-mode component decomposition | Each mode is understandable in isolation; adding modes later is additive; components are testable independently |
| `sqlBuilder.ts` as pure functions separate from React | Testable in plain Jest without rendering components |
| Backend split by concern (connection, macros, executor, frame, metadata) | Each concern is testable in isolation; follows Grafana SDK patterns |
| Metadata via `SHOW TABLES` + `SHOW CREATE TABLE` DDL parsing | No KWDB system catalog to query; DDL parsing is the reliable way to get table/column/tag metadata |
| `time_bucket` as `$__timeGroup` macro mapping | KWDB's `time_bucket` is the performance-optimized function for fixed-interval downsampling |
| Double-quote all identifiers in generated SQL | Prevents issues with reserved keywords as column/table names |
| Unknown OIDs default to string type in frame conversion | Ensures no data loss; user sees raw values rather than conversion errors |
