# Changelog

## v1.2.3 (2026-10-28)

### Fixed

- The query builder no longer emits a statement that the database rejects when
  the time column, a metric column or an interval contains leading or trailing
  whitespace: the SELECT list and the WHERE clause now quote the same
  identifier, and a blank interval falls back to the 5m default instead of
  being interpolated verbatim.
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
- Unit tests for the variable support class, the health check error
  classification and the connection settings validation.
- End-to-end tests for the latest values and window/event builder modes and for
  annotation queries.
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
