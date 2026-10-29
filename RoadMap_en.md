# RoadMap

This file tracks the development plan for the KWDB TSDB Grafana data source plugin. It only lists work that has been decided on.

## Current version

**v1.2.x** — ready to be submitted to the Grafana plugin catalog for review.

Shipped capabilities: five query editor modes (downsampling, gapfill interpolation, latest values, window/event, raw SQL), Grafana standard time macros, three layers of read-only protection, full KWDB time-series feature coverage (`time_bucket`, `time_bucket_gapfill` with five interpolation modes, four latest-value functions, five window functions), four TLS modes, 13 configurable connection parameters, table/column/tag-value browsing, query template variables, and a 100,000 row per frame cap with a truncation notice.

## v1.3.0 — release wrap-up

| Item                                         | Status | Notes                                                                                                                            |
| -------------------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------- |
| Full plugin-validator in CI                  | Done   | CI previously ran `metadatavalid` only; the full validator ran only in the release workflow, which had never been executed       |
| Classified health check errors               | Done   | Authentication failure, missing database, timeouts and TLS problems now get a human-readable hint; the raw SQLSTATE is preserved |
| Connection parameter validation              | Done   | Port range and an sslMode allowlist (pgx's `allow`/`prefer` silently downgrade to plaintext and are rejected)                    |
| Variable support API migration               | Done   | `setVariableQueryEditor` is deprecated; replaced with the `variables` property on the data source instance                       |
| Unit tests for the core logic                | Done   | SQL generation and variable query parsing are now at near-100% coverage                                                          |
| 12 defects found by those tests              | Fixed  | See `docs/code-quality-2026-10-28.md`                                                                                            |
| e2e for latest values / window / annotations | Done   | 12 new cases                                                                                                                     |

| Item                                 | Status       | Notes                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------ | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cascading template variables         | To do        | `metricFindQuery` needs `getTemplateSrv().replace()`, otherwise `tag_values($schema.$table, $col)` does not resolve                                                                                                                                                                                                             |
| Window expression in the SELECT list | To do        | The window expression currently only appears in `GROUP BY`, so the result set cannot tell which window a row belongs to. All five window functions executed successfully on a live KWDB on 2026-10-22, so this is a usability improvement rather than a correctness fix; it would change the output shape of every window query |
| `last_row` time column consistency   | Mostly fixed | The value/timestamp mismatch was reproduced on a live KWDB on 2026-10-22 and fixed (the time column now follows `latestFunc`). What remains is the `last()` vs `last_row()` difference when the time column is nullable; `last_row_ts()` is the candidate fix                                                                   |
| `interpolate` constant mode syntax   | Fixed        | `'constant'` is not in KWDB's interpolation allowlist and returned 400 on a live instance on 2026-10-22; it now emits the numeric constant `interpolate(avg(v), 0)`, pinned by a unit test                                                                                                                                      |
| TLS end-to-end verification          | To do        | `verify-ca` / `verify-full` need a KWDB instance with TLS enabled                                                                                                                                                                                                                                                               |
| Alert rule end-to-end case           | To do        | The backend path works, but "create rule → fire → receive notification" is not covered                                                                                                                                                                                                                                          |

## v1.4.0 — post-release

| Item                                                        | Notes                                                                                                                                                                                        |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Select`/`MultiSelect`/`VerticalGroup` → `Combobox`/`Stack` | These `@grafana/ui` 13 components are deprecated. Ten files are affected and the e2e selectors change with them, so this does not belong in a release candidate                              |
| Query editor help                                           | A one-click formatter and a cheat sheet for raw SQL mode                                                                                                                                     |
| Regenerate `.config/`                                       | The scaffold-time plugin ID leaves `GF_LOG_FILTERS` pointing at a logger that does not exist, so plugin debug logs are currently dropped. To be handled together with the plugin ID decision |

## Long term

- Richer annotations: the default Grafana implementation is used today; a native annotation source built on KWDB event windows is possible later.
- Query performance: pool defaults are in place; per-query-type timeout strategies need real workload data before being decided.

---

## Explicitly out of scope

- **Multi-statement queries.** The read-only guard rejects them on purpose. This is a security boundary and will not be relaxed for convenience.
- **A dedicated editor for relational tables.** Raw SQL mode already covers this; relational model queries belong on the Text2SQL side.
- **Grafana 12 and older.** `grafanaDependency` is `>=13.1.0`; no back-porting.
