# Changelog

## Unreleased

### Fixed

Found by running the plugin against a live KWDB 3.3.0 instance; none of these
were reachable with the mock-based unit tests or the CI container dataset.

- Selecting `none` as the aggregation for a downsampling, gapfill or window
  query produced a statement the database rejects ("column ... must appear in
  the GROUP BY clause"). Non-aggregated metric columns are now added to the
  GROUP BY list. For window queries they are placed before the window
  expression, because KWDB requires a grouped window function to be the last
  GROUP BY entry. Gapfill cannot take a bare column at all (`interpolate()`
  requires an aggregate), so the gapfill editor no longer offers `none` and
  coerces a value left over from an older query to `avg`.
- Time macros are no longer expanded inside string literals, quoted identifiers
  or comments. `SELECT 'range: $__timeFilter(ts)'` used to be rewritten into a
  broken statement that failed with a syntax error inside the literal.
- A latest-values query without tags now produces a frame whose first field is
  the time column. The builder selects the metrics before the time column, and
  while the long-to-wide conversion hoists the time field for frames with tag
  columns, a frame without them is already wide and was left with the time field
  last, which Grafana treats as a table.

### Changed

- The constant interpolation fill value is emitted as a quoted string
  (`interpolate(avg(col), '0')`), the form used in the KWDB documentation,
  rather than a bare numeric literal. Both are accepted by the database.

### Documentation

- `docs/real-server-verification-2026-10-29.md` records the first end-to-end
  run against a live KWDB instance (`10.110.105.80:26267/factory`,
  `equipment_telemetry`, 1,002,988 rows): 56 generated SQL statements, the Go
  backend pipeline, 21/21 Playwright specs and the alerting path. It also lists
  what is still unverified, TLS above all.

## v1.2.3 (2026-10-28)

### Fixed

- The query builder no longer emits a statement that the database rejects when
  the time column, a metric column or an interval contains leading or trailing
  whitespace: the SELECT list and the WHERE clause now quote the same
  identifier, and a blank interval falls back to the 5m default instead of
  being interpolated verbatim.
- `COUNT_WINDOW` falls back to a row limit of 100, the value the "Row limit"
  field shows. Previously a newly selected `COUNT_WINDOW` generated an empty
  statement while the field read 100, and because the field is a controlled
  input, typing the value it already displayed did not regenerate the SQL.
- Window/event queries validate their free-form arguments. Event and state
  conditions that could terminate the statement or open a comment, and
  `COUNT_WINDOW` limits that are not numbers, are now rejected by the builder
  instead of producing a statement that fails inside the database.
- A schema-qualified table name that contains a dot inside quotes (for example
  `"my.table"`) is no longer rewritten into two separate identifiers.
- Template variable queries accept quoted arguments that contain a comma, and
  the definition string Grafana shows in the variable list is now always one the
  plugin can parse back. A trailing semicolon separated from the query by
  whitespace no longer produces a misleading "unsupported variable query" error.
- Structured variable queries are validated for every query type and returned as
  a copy, so a caller can no longer mutate the parsed result.

### Documentation

- Troubleshooting covers `group-window-func: memory budget exceeded` (sliding
  and count windows buffer the whole requested range in KWDB) and the
  requirement that an annotation query use Table format.

### Changed

- The data source now registers its template variable editor and query
  implementation through the `variables` property of the data source instance.
  `DataSourcePlugin.setVariableQueryEditor` is deprecated and is no longer used.
- Health check failures are prefixed with a short classification (authentication
  failed, database does not exist, connection timed out, TLS negotiation
  failed, ...). The original database error, including its SQLSTATE, is still
  shown.
- Connection settings are validated before the pool is created: the port must be
  in 1-65535 and `sslmode` only accepts the four modes offered by the
  configuration page. pgx's `allow` and `prefer` are rejected because they
  silently fall back to a plaintext connection.
- `plugin.json` links point at the renamed repository and the plugin declares
  `category: tsdb` for the Grafana connection directory.

### Added

- Unit tests for the SQL builder and the template variable query parser,
  covering all five builder modes, identifier quoting, macro injection and the
  parse/render round trip. These modules previously had no coverage.
- Unit tests for the field reset applied when the table or the window type
  changes, the variable support class, the health check error classification and
  the connection settings validation.
- End-to-end tests for the latest values and window/event builder modes and for
  annotation queries. The end-to-end suite runs in CI against a KWDB
  container seeded by scripts/init.sql and passes on Grafana 13.1, 13.2,
  13.3 and nightly.
- CI now runs the complete Grafana plugin validator on every pull request.
  Previously only the metadata analyzer ran in CI; the full validator ran only
  in the release workflow, which had never been executed.
- `RoadMap.md` and `RoadMap_en.md` describe the release plan and the items that
  are explicitly out of scope.

## v1.2.2 (2026-10-27)

### Changed

- The packaged plugin README now ships the full user documentation (query editor
  modes, time macros, output formats, read-only safety, troubleshooting) instead
  of the short summary, so the Grafana plugin catalog page shows the complete
  guide.
- `plugin.json` adds four screenshots (dashboard example, data source
  configuration, downsampling query, save & test) and `License` / `Support`
  links for the catalog detail page.

## v1.2.1 (2026-10-22)

### Security

- Every pooled connection now starts with `default_transaction_read_only = on`
  and a `statement_timeout` (default 30s, configurable), so a statement that
  slips past the lexical check still cannot write and runaway queries are
  cancelled.
- The read-only guard now understands `E'...'` escape strings, dollar quoting
  and nested block comments, closing a multi-statement bypass, and rejects
  internal management catalogs (`kwdb_internal.*`, `crdb_internal.*`) and
  side-effecting functions (`pg_sleep`, `pg_read_file`, `nextval`,
  `set_config`, ...).
- `SHOW` is restricted to schema-oriented forms so cluster/session state is not
  exposed.
- Connection URLs in error messages are redacted; read-only and TLS guidance was
  added to the README.

### Fixed

- `$__timeFilter` and `$__timeGroup` now expand through a paren-matching
  scanner: `CAST(...)` and nested function arguments no longer produce broken
  SQL, and every expansion is parenthesised so `NOT $__timeFilter(x)` keeps its
  meaning.
- Reaching the row cap now cancels the running query instead of draining the
  whole result set.
- Database errors raised while scanning rows are reported as downstream errors
  instead of plugin errors.
- Gapfill `constant` mode now emits a numeric constant; interpolation modes use
  KWDB's accepted lower-case names (legacy `PREV`/`NEXT`/`NULL` values are
  normalised).
- Latest-values queries use `first()`/`last()` for the time column to match the
  selected function, so values and timestamps no longer disagree.
- `date` columns map to Grafana time fields, and `uuid`/`interval`/`time` values
  render as readable strings instead of Go representations.
- A time series query now fails with a clear message when the configured time
  column is missing or contains `NULL` values.
- Metadata parsing ignores table-level clauses (`INDEX`, `CONSTRAINT`,
  `FOREIGN KEY`, ...) so the column picker no longer offers phantom columns.
- Template-variable tag values are capped at 10,000 entries.
- An empty query returns an explicit "query is empty" message instead of a
  read-only rejection.

### Changed

- `queryTimeout` and `maxRows` can be configured per data source.
- `plugin.json` no longer declares `queryOptions` that were never read, and the
  minimum Grafana version is 13.1.0 (the version the plugin is built and tested
  against).

## [v1.2.0](https://github.com/LumingSun/KWDB-Grafana-Plugin/tree/v1.2.0) (2026-08-25)

[Full Changelog](https://github.com/LumingSun/KWDB-Grafana-Plugin/compare/v1.1.0...v1.2.0)

## [v1.1.0](https://github.com/LumingSun/KWDB-Grafana-Plugin/tree/v1.1.0) (2026-08-10)

[Full Changelog](https://github.com/LumingSun/KWDB-Grafana-Plugin/compare/v1.0.0...v1.1.0)

- Fix sql preview [\#12](https://github.com/LumingSun/KWDB-Grafana-Plugin/pull/12) ([LumingSun](https://github.com/LumingSun))

## [v1.0.0](https://github.com/LumingSun/KWDB-Grafana-Plugin/tree/v1.0.0) (2026-08-06)

[Full Changelog](https://github.com/LumingSun/KWDB-Grafana-Plugin/compare/6d2886713db4b6cdd8897f2246376a8be56347d5...v1.0.0)

\* _This Changelog was automatically generated by [github_changelog_generator](https://github.com/github-changelog-generator/github-changelog-generator)_
