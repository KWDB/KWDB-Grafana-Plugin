# RoadMap

This file tracks the development plan for the KWDB TSDB Grafana data source plugin. It only lists work that has been decided on.

## Current version

**v1.3.0** — ready to be submitted to the Grafana plugin catalog for review.

Shipped capabilities: five query editor modes (downsampling, gapfill interpolation, latest values, window/event, raw SQL), Grafana standard time macros, three layers of read-only protection, full KWDB time-series feature coverage (`time_bucket`, `time_bucket_gapfill` with five interpolation modes, four latest-value functions, five window functions), four TLS modes, 13 configurable connection parameters, table/column/tag-value browsing, query template variables, a 100,000 row per frame cap with a truncation notice, and full end-to-end verification against a real KWDB instance (including the TLS scenarios).

## v1.3.0 — release wrap-up

| Item                                         | Status       | Notes                                                                                                                                                                                                                                                       |
| -------------------------------------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Full plugin-validator in CI                  | Done         | CI now runs the full validator on pull requests. It previously ran `metadatavalid` only; the release workflow has executed and passed the same command since v1.2.2 (2026-10-28, run 40614631903)                                                            |
| Classified health check errors               | Done         | Authentication failure, missing database, timeouts and TLS problems now get a human-readable hint; the raw SQLSTATE is preserved                                                                                                                            |
| Connection parameter validation              | Done         | Port range and an sslMode allowlist (pgx's `allow`/`prefer` silently downgrade to plaintext and are rejected)                                                                                                                                               |
| Variable support API migration               | Done         | `setVariableQueryEditor` is deprecated; replaced with the `variables` property on the data source instance                                                                                                                                                   |
| Unit tests for the core logic                | Done         | SQL generation and variable query parsing now have unit tests; `sqlBuilder` reports 100% statements / 95.5% branches and `variableQuery` 100% statements / branches / functions in the local coverage report, with the final values to be confirmed by CI                                                  |
| Defects found by the tests                   | Done         | 14 of 15 fixed; the remaining item is a product decision (window expression in the SELECT list), see `docs/code-quality-2026-10-28.md`                                                                                                                                                                                    |
| e2e for latest values / window / annotations | Done         | 12 new cases                                                                                                                                                                                                                                                |
| Real-server end-to-end verification          | Done         | 2026-10-29 on a real KWDB instance (1M-row time-series table): 56 generated SQL statements, the Go backend pipeline, 21/21 e2e specs and the manual alerting path. Internal addresses and credentials are redacted; see `docs/real-server-verification-2026-10-29.md` |
| TLS end-to-end verification                  | Done         | `require`, `verify-ca`, `verify-full`, a foreign CA and plaintext rejection for a non-administrative account were all exercised; see section 6 of the real-server verification document                                                                                |
| Automated alert rule test case               | To do        | The manual path works (section 5 of the same document), but "create rule -> fire -> receive notification" still has no automated e2e coverage                                                                                                              |
| Cascading template variables                 | To do        | `metricFindQuery` needs `getTemplateSrv().replace()`, otherwise `tag_values($schema.$table, $col)` does not resolve                                                                                                                                         |
| Window expression in the SELECT list         | To do        | The window expression currently only appears in `GROUP BY`, so the result set cannot tell which window a row belongs to. All five window functions executed successfully on a live KWDB, so this is a usability improvement rather than a correctness fix; it would change the output shape of every window query |
| `last_row` time column consistency           | Mostly fixed | The value/timestamp mismatch was reproduced and fixed during the 2026-10-22 real-server verification (the time column now follows `latestFunc`). What remains is the `last()` vs `last_row()` difference when the time column is nullable; `last_row_ts()` is the candidate fix |
| `last` / `last_row` NULL semantics           | To do        | Both take the max-timestamp row per the docs and differ only in NULL handling. Needs a dedicated test with a nullable metric whose last row is NULL; `last_row_ts()` is a candidate                                                                          |
| `interpolate` constant mode syntax         | Fixed        | `'constant'` is not in KWDB's interpolation allowlist (returned 400 on a live instance on 2026-10-22); it now emits the quoted constant `interpolate(avg(v), '0')`, pinned by a unit test                                                                        |
| `EVENT_WINDOW` reachable end condition       | To do        | Observed on the real server: an end condition that never becomes true silently returns 0 rows, which contradicts the local 3.2.1 docs. Needs a hint in the editor or the docs                                                                                |
| `none` aggregation row explosion             | To do        | 32,136 rows instead of 72 for a 6-hour window. Valid SQL but it floods the chart; drop `none` from downsampling or rename it and warn                                                                                                                       |
| Window interval validation                   | To do        | Docs require `TIME_WINDOW` intervals >= 10ms over ms..year and `SESSION_WINDOW` thresholds in s/m/h/d/w; the editor does not validate, so `500us` surfaces a database error                                                                                  |

## Decisions needed outside the repository before publishing

These do not block merging code, but they must be settled before submitting the plugin to the Grafana catalog:

- **Plugin ID and repository ownership.** The plugin ID prefix (`lumingsun`) maps to a personal Grafana Cloud organization and the repository lives under a personal account. A plugin ID cannot be changed after publication, so decide whether the organization or the individual should publish.
- **Signing token.** `GRAFANA_ACCESS_POLICY_TOKEN` is not configured in the repository secrets, so release artifacts are currently unsigned. The first submission may be unsigned, but every version after approval must be signed.
- **Branch protection.** master has no required status checks or required review, so CI results are advisory rather than a gate.

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
