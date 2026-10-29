# KWDB Grafana Data Source Plugin - Implementation Plan

**Date:** 2026-08-04
**Spec:** [2026-08-04-kwdb-tsdb-datasource-design.md](./2026-08-04-kwdb-tsdb-datasource-design.md)

## Phase 1: Scaffold & Project Setup

**Goal:** Initialize the plugin project using the official `@grafana/create-plugin` CLI, get it to compile and load in Grafana.

### 1.1 Scaffold with create-plugin CLI
- Ensure Node 22 is active: `PATH=<node-22-bin>:$PATH`
- Install yarn: `corepack enable && corepack prepare yarn@1.22.22 --activate`
- Run the create-plugin CLI from the `kwdb-tsdb-datasource` parent directory:
  ```
  cd /Volumes/external/kwdb-grafana
  npx @grafana/create-plugin@latest
  ```
- Answer the interactive prompts:
  - **Plugin name:** `kwdb-tsdb-datasource`
  - **Organization:** `kaiwudb`
  - **Plugin type:** `datasource`
  - **Has backend:** Yes
- The CLI generates the full project structure under `kaiwudb-kwdb-tsdb-datasource-datasource/` (or similar, depending on prompt answers). Rename the generated directory to `kwdb-tsdb-datasource` if needed.
- The CLI handles all template rendering: `plugin.json` with correct ID/name/backend/executable, `go.mod` with correct module path, `.config/` build tooling, `Magefile.go`, `package.json`, `tsconfig.json`, src/ and pkg/ scaffolding, and `img/` placeholder logo.

### 1.2 Install dependencies
- `cd kwdb-tsdb-datasource && yarn install` (requires network -- escalate if sandboxed)
- `GOCACHE=/private/tmp/kwdb-gocache go mod tidy` (requires network for SDK deps)

### 1.3 Add pgx/v5 dependency
- `GOCACHE=/private/tmp/kwdb-gocache go get github.com/jackc/pgx/v5 github.com/jackc/pgx/v5/pgxpool`

### 1.4 Verify scaffold compiles
- `yarn build` (frontend webpack bundle)
- `GOCACHE=/private/tmp/kwdb-gocache MAGEFILE_CACHE=/private/tmp/kwdb-magefile mage -v build` (backend Go build)

## Phase 2: Backend Core (Connection, Settings, Health Check)

**Goal:** Get the backend to connect to KWDB and pass a health check.

### 2.1 `pkg/models/settings.go`
- Define `DataSourceSettings` struct (Host, Port, Database, User, SSLMode) with JSON tags
- Define `SecretDataSourceSettings` struct (Password)
- `LoadSettings(source backend.DataSourceInstanceSettings)` function

### 2.2 `pkg/plugin/connection.go`
- `NewDatasource(ctx, settings)`: read settings, build connection string, create `pgxpool.Pool`
- Store pool in `Datasource` struct
- `Dispose()`: close pool

### 2.3 `pkg/plugin/datasource.go` (initial version)
- `Datasource` struct with `pool *pgxpool.Pool` and `handler backend.CallResourceHandler`
- Implement `QueryDataHandler` (stub -- return empty response for now)
- Implement `CheckHealthHandler` -- execute `SELECT 1` via pool, return OK/Error
- Implement `CallResourceHandler` (stub for now)
- Implement `InstanceDisposer`

### 2.4 Verify
- `GOCACHE=/private/tmp/kwdb-gocache go test ./pkg/...`
- `GOCACHE=/private/tmp/kwdb-gocache go vet ./pkg/...`

## Phase 3: Backend Query Pipeline (Macros, Executor, Frame)

**Goal:** Full query execution pipeline from raw SQL to Grafana Data Frame.

### 3.1 `pkg/plugin/macros.go`
- `ExpandMacros(rawSql string, timeRange backend.TimeRange) string`
- Regex-based replacement for `$__timeFilter`, `$__timeFrom`, `$__timeTo`, `$__timeGroup`
- `macros_test.go`: test all four macros with fixed time range, edge cases

### 3.2 `pkg/plugin/executor.go`
- `IsReadOnly(sql string) bool` -- strip whitespace/comments, check first keyword
- `ExecuteQuery(ctx, pool, sql) (pgx.Rows, error)` -- execute via pool.Query with ctx
- `executor_test.go`: test allowed/rejected SQL patterns, leading whitespace, comments

### 3.3 `pkg/plugin/frame.go`
- `RowsToFrame(rows pgx.Rows, format string, timeColumn string, tags []string) (*data.Frame, error)`
- OID-to-FieldType mapping table
- Time column identification (from QueryModel or heuristic)
- Long-to-wide conversion for time_series format
- `frame_test.go`: test with mock rows (int4, float8, timestamptz, varchar), assert field types and LongToWide output

### 3.4 Update `pkg/plugin/datasource.go` QueryDataHandler
- Unmarshal query JSON into `QueryModel`
- Call `ExpandMacros` on rawSql
- Call `IsReadOnly` -- if not, return error response
- Call `ExecuteQuery` -- if error, return error response
- Call `RowsToFrame` -- append to response.Frames

### 3.5 Verify
- `GOCACHE=/private/tmp/kwdb-gocache go test ./pkg/...`

## Phase 4: Backend Metadata Resources

**Goal:** Resource handlers for table and column discovery.

### 4.1 `pkg/plugin/metadata.go`
- Implement `CallResourceHandler` using `httpadapter` + `http.ServeMux`
- `GET /tables` -- `SHOW TABLES FROM {database}`, return JSON array
- `GET /columns?table=X` -- `SHOW CREATE TABLE {database}.{table}`, parse DDL, return JSON
- DDL parser: extract column names, types, TAGS clause, PRIMARY TAGS
- Fallback: unrecognized DDL returns all columns as data columns
- `metadata_test.go`: test DDL parser with KWDB reference DDL examples

### 4.2 Update `datasource.go`
- Initialize metadata handler in `NewDatasource`
- Wire `CallResource` to delegate to metadata handler

### 4.3 Verify
- `GOCACHE=/private/tmp/kwdb-gocache go test ./pkg/...`

## Phase 5: Frontend Types & SQL Builder

**Goal:** TypeScript query model and SQL generation logic, fully testable.

### 5.1 `src/types.ts`
- `KwdbQueryMode` type
- `KwdbQuery` interface extending `DataQuery`
- `MetricSpec` interface
- `KwdbDataSourceOptions` extending `DataSourceJsonData`
- `KwdbSecureJsonData` interface
- `ColumnInfo` interface (name, type, isTag, isTimeColumn, isPrimaryTag)
- `DEFAULT_QUERY` constant

### 5.2 `src/sqlBuilder.ts`
- `buildDownsamplingSql(query: KwdbQuery): string`
- `buildGapfillSql(query: KwdbQuery): string`
- `buildLatestSql(query: KwdbQuery): string`
- `buildWindowSql(query: KwdbQuery): string`
- `buildRawSql(query: KwdbQuery): string`
- `buildSql(query: KwdbQuery): string` -- dispatcher by mode
- Double-quote all identifiers
- `tests/sqlBuilder.test.ts`: assert exact SQL output per mode, edge cases

### 5.3 Verify
- `yarn test tests/sqlBuilder.test.ts`

## Phase 6: Frontend Config Editor

**Goal:** Data source configuration page.

### 6.1 `src/components/ConfigEditor.tsx`
- Form with: Host, Port, Database, User, SSL Mode (Select), Password (SecretInput)
- Use Grafana UI components from `@grafana/ui`
- `onOptionsChange` wires to jsonData and secureJsonData
- `tests/configEditor.spec.ts`: verify fields render and update options

### 6.2 Verify
- `yarn test tests/configEditor.spec.ts`

## Phase 7: Frontend Data Source Class

**Goal:** DataSourceApi with backend delegation and resource methods.

### 7.1 `src/datasource.ts`
- Extend `DataSourceWithBackend<KwdbQuery, KwdbDataSourceOptions>`
- `getTables()` -> `this.getResource('/tables')`
- `getColumns(table)` -> `this.getResource('/columns?table=...')`
- `getDefaultQuery()` -> downsampling mode defaults
- `filterQuery()` -- by table selection or rawSql

### 7.2 `src/module.ts`
- Register plugin with `DataSourcePlugin` (ConfigEditor, QueryEditor, datasource class)

## Phase 8: Frontend Query Editor -- Shared Components

**Goal:** Reusable form primitives used by all mode editors.

### 8.1 `src/components/querybuilder/shared/TableSelector.tsx`
- Fetch tables via `datasource.getTables()` on mount
- Dropdown with table names
- `onChange` callback to parent

### 8.2 `src/components/querybuilder/shared/ColumnPicker.tsx`
- Multi-select for tag columns, single-select for metric column
- Group columns by type (tags vs data) from `ColumnInfo[]`

### 8.3 `src/components/querybuilder/shared/IntervalPicker.tsx`
- Preset intervals + custom input

### 8.4 `src/components/querybuilder/shared/TimeColumnPicker.tsx`
- Filter to TIMESTAMP-typed columns only

### 8.5 `src/components/querybuilder/shared/MetricRow.tsx`
- Column picker (data columns), aggregation selector, alias input

### 8.6 `src/components/querybuilder/SqlPreview.tsx`
- Read-only display of `query.rawSql`

### 8.7 `src/components/querybuilder/QueryEditorToolbar.tsx`
- Mode selector dropdown
- Format selector dropdown (Time series / Table)

## Phase 9: Frontend Query Editor -- Mode Components

**Goal:** One component per query mode, each wiring shared components.

### 9.1 `src/components/querybuilder/DownsamplingEditor.tsx`
- TableSelector, TimeColumnPicker, ColumnPicker (tags), MetricRow[]
- Call `buildSql(query)` on every change, update `query.rawSql` via `onChange`
- Render SqlPreview

### 9.2 `src/components/querybuilder/GapfillEditor.tsx`
- Same as Downsampling + Interpolation Mode dropdown
- Use `buildGapfillSql` for SQL preview

### 9.3 `src/components/querybuilder/LatestValueEditor.tsx`
- TableSelector, TimeColumnPicker, MetricRow[] (with last/last_row/first/first_row picker), tags
- Use `buildLatestSql`

### 9.4 `src/components/querybuilder/WindowEventEditor.tsx`
- Window type selector, conditional fields per type
- Use `buildWindowSql`

### 9.5 `src/components/querybuilder/RawSqlEditor.tsx`
- Grafana UI `CodeEditor` with SQL syntax highlighting
- Bind to `query.rawSql`

### 9.6 `src/components/QueryEditor.tsx`
- Read mode and format from query
- Render QueryEditorToolbar
- Switch on mode to render correct mode component
- Pass `onChange` and `datasource` props down
- `tests/queryEditor.spec.ts`: verify mode switching renders correct components

### 9.7 Verify
- `yarn test tests/queryEditor.spec.ts`
- `yarn build` (full production build)

## Phase 10: Docker Dev Environment

**Goal:** One-command local dev environment with KWDB + Grafana.

### 10.1 `docker-compose.yaml`
- KWDB service: `kwdb/kwdb`, ports 26257/8080, volume, init script
- Grafana service: `grafana/grafana`, port 3000, plugin mount, provisioning mount
- `GF_DEVELOPMENT_MODE=true`

### 10.2 Init script
- Create `demo_ts` TS database
- Create `sensors` table with device_id tag, temperature/humidity/voltage data columns
- Insert sample rows with recent timestamps

### 10.3 `provisioning/datasources/datasources.yml`
- Auto-provision KWDB TSDB data source with env vars

### 10.4 Verify
- `docker compose up -d`
- Backend: `GOCACHE=/private/tmp/kwdb-gocache MAGEFILE_CACHE=/private/tmp/kwdb-magefile mage -v build`
- Frontend: `yarn dev`
- Open Grafana at http://localhost:3000, verify data source is provisioned and health check passes

## Phase 11: Integration Testing & Polish

**Goal:** End-to-end verification and final polish.

### 11.1 Manual integration test
- Start docker compose
- Verify config page saves and health check passes
- Create a dashboard with a downsampling query on `sensors` table
- Verify time series renders
- Switch to table format, verify table renders
- Switch to raw SQL mode, write a `time_bucket` query, verify it works
- Switch to gapfill mode, test interpolate
- Switch to latest values mode, test `last()`
- Switch to window/event mode if time permits

### 11.2 Fix issues found during integration
- Address any rendering, SQL generation, or connection issues

### 11.3 Final build verification
- `yarn build` (production frontend build)
- `GOCACHE=/private/tmp/kwdb-gocache MAGEFILE_CACHE=/private/tmp/kwdb-magefile mage -v build` (production backend build)
- `GOCACHE=/private/tmp/kwdb-gocache go test ./pkg/...` (backend tests)
- `yarn test` (frontend tests)

## Dependency Graph

```
Phase 1 (Scaffold)
  |
  +-> Phase 2 (Backend Core) -> Phase 3 (Query Pipeline) -> Phase 4 (Metadata)
  |
  +-> Phase 5 (Types & SQL Builder) -> Phase 6 (Config Editor)
  |                              \-> Phase 7 (DataSource Class)
  |                              \-> Phase 8 (Shared Components) -> Phase 9 (Mode Components)
  |
Phase 4 + Phase 9 -> Phase 10 (Docker Dev Env) -> Phase 11 (Integration)
```

Phases 2-4 (backend) and Phases 5-9 (frontend) can be developed in parallel after Phase 1. Phase 10 requires both sides. Phase 11 requires Phase 10.
