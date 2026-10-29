package plugin

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/grafana/grafana-plugin-sdk-go/backend"

	"github.com/kaiwudb/kwdb-tsdb-datasource/pkg/models"
)

// Real-server verification harness.
//
// Everything here runs against a live KWDB instance, so it is skipped unless
// KWDB_VERIFY_DSN is set:
//
//	KWDB_VERIFY_DSN="postgres://root:passwd@10.110.105.80:26267/factory?sslmode=disable" \
//	  go test ./pkg/plugin/ -run TestRealServer -v
//
// Unlike the unit tests, this exercises the whole backend pipeline: settings
// validation, pool creation, session parameters, health checks, macro
// expansion, the read-only guard, query execution and Data Frame conversion.

func realDSN(t *testing.T) string {
	t.Helper()
	dsn := os.Getenv("KWDB_VERIFY_DSN")
	if dsn == "" {
		t.Skip("set KWDB_VERIFY_DSN to run against a real KWDB instance")
	}
	return dsn
}

func realInstance(t *testing.T, dsn string) *Datasource {
	t.Helper()
	return realInstanceWith(t, dsn, nil)
}

// realInstanceWith builds an instance with extra jsonData merged on top of the
// DSN-derived settings (used for maxRows and the pool options).
func realInstanceWith(t *testing.T, dsn string, extra map[string]any) *Datasource {
	t.Helper()
	cfg, secrets, err := settingsFromDSN(dsn)
	if err != nil {
		t.Fatalf("settingsFromDSN: %v", err)
	}
	applyDefaults(cfg)
	if err := cfg.Validate(); err != nil {
		t.Fatalf("Validate: %v", err)
	}
	raw, err := json.Marshal(cfg)
	if err != nil {
		t.Fatal(err)
	}
	merged := map[string]any{}
	if err := json.Unmarshal(raw, &merged); err != nil {
		t.Fatal(err)
	}
	for k, v := range extra {
		merged[k] = v
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	inst, err := NewDatasource(ctx, backend.DataSourceInstanceSettings{
		JSONData:                mustJSON(t, merged),
		DecryptedSecureJSONData: secrets,
	})
	if err != nil {
		t.Fatalf("NewDatasource: %v", err)
	}
	t.Cleanup(func() {
		if d, ok := inst.(*Datasource); ok {
			d.Dispose()
		}
	})
	return inst.(*Datasource)
}

func mustJSON(t *testing.T, v any) []byte {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// settingsFromDSN splits a libpq DSN into the settings the plugin loads from
// Grafana. Only the pieces the plugin configures are extracted.
func settingsFromDSN(dsn string) (*models.DataSourceSettings, map[string]string, error) {
	// Strip the scheme so the user/password part is not URL-decoded.
	trimmed := strings.TrimPrefix(dsn, "postgres://")
	trimmed = strings.TrimPrefix(trimmed, "postgresql://")
	at := strings.LastIndex(trimmed, "@")
	if at < 0 {
		return nil, nil, fmt.Errorf("DSN has no credentials")
	}
	userPass := trimmed[:at]
	hostDb := trimmed[at+1:]
	colon := strings.Index(userPass, ":")
	if colon < 0 {
		return nil, nil, fmt.Errorf("DSN credentials need user:password")
	}

	slash := strings.Index(hostDb, "/")
	hostPort := hostDb
	database := "defaultdb"
	if slash >= 0 {
		hostPort = hostDb[:slash]
		database = strings.TrimPrefix(hostDb[slash+1:], "/")
	}
	if q := strings.Index(database, "?"); q >= 0 {
		database = database[:q]
	}
	port := 26257
	if c := strings.LastIndex(hostPort, ":"); c >= 0 {
		port = atoiDefault(hostPort[c+1:], 26257)
		hostPort = hostPort[:c]
	}

	return &models.DataSourceSettings{
		Host:     hostPort,
		Port:     port,
		Database: database,
		User:     userPass[:colon],
		SSLMode:  "disable",
	}, map[string]string{"password": userPass[colon+1:]}, nil
}

func atoiDefault(s string, def int) int {
	n := 0
	for _, r := range s {
		if r < '0' || r > '9' {
			return def
		}
		n = n*10 + int(r-'0')
	}
	if n == 0 {
		return def
	}
	return n
}

func realTimeRange() backend.TimeRange {
	// A window inside the real dataset (equipment_telemetry spans
	// 2026-10-26 .. 2026-10-29).
	from := time.Date(2026, 10, 27, 0, 0, 0, 0, time.UTC)
	to := time.Date(2026, 10, 27, 6, 0, 0, 0, time.UTC)
	return backend.TimeRange{From: from, To: to}
}

func (d *Datasource) runQuery(t *testing.T, rawSql string, tr backend.TimeRange, mode string) backend.DataResponse {
	t.Helper()
	payload, err := json.Marshal(map[string]any{
		"mode":       mode,
		"format":     "time_series",
		"rawSql":     rawSql,
		"timeColumn": "k_timestamp",
		"tags":       []string{"device_id"},
	})
	if err != nil {
		t.Fatal(err)
	}
	return d.query(context.Background(), backend.DataQuery{
		RefID:         "A",
		JSON:          payload,
		TimeRange:     tr,
		MaxDataPoints: 100,
	})
}

func (d *Datasource) runQueryModel(t *testing.T, qm map[string]any, tr backend.TimeRange) backend.DataResponse {
	t.Helper()
	payload, err := json.Marshal(qm)
	if err != nil {
		t.Fatal(err)
	}
	return d.query(context.Background(), backend.DataQuery{
		RefID:         "A",
		JSON:          payload,
		TimeRange:     tr,
		MaxDataPoints: 100,
	})
}

func frameSummary(t *testing.T, res backend.DataResponse) string {
	t.Helper()
	if res.Error != nil {
		return "ERROR: " + res.Error.Error()
	}
	var sb strings.Builder
	for i, f := range res.Frames {
		sb.WriteString(fmt.Sprintf("frame[%d] rows=%d cols=[", i, f.Rows()))
		for j, field := range f.Fields {
			if j > 0 {
				sb.WriteString(", ")
			}
			sb.WriteString(field.Name)
		}
		sb.WriteString("] ")
	}
	return strings.TrimSpace(sb.String())
}

// ---------------------------------------------------------------------- health

func TestRealServerHealth(t *testing.T) {
	dsn := realDSN(t)
	d := realInstance(t, dsn)
	res, err := d.CheckHealth(context.Background(), &backend.CheckHealthRequest{})
	if err != nil {
		t.Fatalf("CheckHealth: %v", err)
	}
	if res.Status != backend.HealthStatusOk {
		t.Fatalf("expected OK, got %v: %s", res.Status, res.Message)
	}
	t.Logf("health OK: %s", res.Message)
}

func TestRealServerHealthFailureHints(t *testing.T) {
	dsn := realDSN(t)

	// NOTE: the KWDB instance used for this verification accepts any password
	// and any database name (trust authentication), so the authentication and
	// missing-database hints cannot be exercised against it. Only the
	// connection-refused path is observable here.
	cases := []struct {
		name    string
		mutate  func(string) string
		wantSub string
	}{
		{"closed port", func(s string) string { return replacePort(s, "1") }, "Connection"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			d := realInstance(t, tc.mutate(dsn))
			res, err := d.CheckHealth(context.Background(), &backend.CheckHealthRequest{})
			if err != nil {
				t.Fatalf("CheckHealth: %v", err)
			}
			if res.Status == backend.HealthStatusOk {
				t.Fatalf("expected an error status, got OK: %s", res.Message)
			}
			t.Logf("hint: %s", res.Message)
			if !strings.Contains(strings.ToLower(res.Message), strings.ToLower(tc.wantSub)) {
				t.Errorf("message %q does not contain %q", res.Message, tc.wantSub)
			}
		})
	}
}

func replaceDatabase(dsn, db string) string {
	at := strings.LastIndex(dsn, "@")
	rest := dsn[at+1:]
	slash := strings.Index(rest, "/")
	if slash < 0 {
		return dsn + "/" + db
	}
	tail := rest[slash+1:]
	if q := strings.Index(tail, "?"); q >= 0 {
		tail = tail[q:]
	} else {
		tail = ""
	}
	return dsn[:at+1] + rest[:slash] + "/" + db + tail
}

func replacePort(dsn, port string) string {
	at := strings.LastIndex(dsn, "@")
	rest := dsn[at+1:]
	slash := strings.Index(rest, "/")
	hostPart := rest
	tail := ""
	if slash >= 0 {
		hostPart = rest[:slash]
		tail = rest[slash:]
	}
	if c := strings.LastIndex(hostPart, ":"); c >= 0 {
		hostPart = hostPart[:c+1] + port
	} else {
		hostPart = hostPart + ":" + port
	}
	return dsn[:at+1] + hostPart + tail
}

// ------------------------------------------------------------------ macro expansion

func TestRealServerMacroExpansion(t *testing.T) {
	dsn := realDSN(t)
	d := realInstance(t, dsn)
	tr := realTimeRange()

	cases := []struct {
		name   string
		raw    string
		wantOK bool
	}{
		{"timeFrom/timeTo", "SELECT count(*) AS n FROM equipment_telemetry WHERE k_timestamp >= $__timeFrom AND k_timestamp <= $__timeTo", true},
		{"timeFilter", "SELECT count(*) AS n FROM equipment_telemetry WHERE $__timeFilter(k_timestamp)", true},
		{"timeGroup", "SELECT $__timeGroup(k_timestamp, '1h') AS time, avg(current_val) FROM equipment_telemetry WHERE $__timeFilter(k_timestamp) GROUP BY 1", true},
		{"nested timeFilter", "SELECT count(*) AS n FROM equipment_telemetry WHERE $__timeFilter(time_bucket(k_timestamp, '5m'))", true},
		{"timeFilter in string literal is not expanded", "SELECT 'literal $__timeFilter(x)' AS s", true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			expanded := ExpandMacros(tc.raw, tr)
			t.Logf("expanded: %s", strings.Join(strings.Fields(expanded), " "))
			// The scalar-aggregate cases are run in table format: they have no
			// time column, and time_series format rejects that by design.
			res := d.runQueryModel(t, map[string]any{
				"mode": "raw", "format": "table", "rawSql": tc.raw, "timeColumn": "k_timestamp",
			}, tr)
			if tc.wantOK && res.Error != nil {
				t.Errorf("query failed: %v", res.Error)
			}
			if res.Error == nil && len(res.Frames) > 0 {
				t.Logf("rows=%d cols=%d", res.Frames[0].Rows(), len(res.Frames[0].Fields))
			}
		})
	}
}

// ------------------------------------------------------------------- read-only guard

func TestRealServerReadOnlyGuard(t *testing.T) {
	dsn := realDSN(t)
	d := realInstance(t, dsn)
	tr := realTimeRange()

	allowed := []string{
		"SELECT 1",
		"SELECT count(*) FROM equipment_telemetry",
		"SHOW TABLES FROM factory",
		"SHOW CREATE TABLE factory.equipment_telemetry",
		"EXPLAIN SELECT 1",
		"WITH x AS (SELECT 1 AS n) SELECT n FROM x",
		"SELECT 'insert into t values (1)' AS s",
		`SELECT "insert" FROM (SELECT 1 AS "insert") x`,
		"SELECT current_val FROM equipment_telemetry WHERE device_id = 'DROP TABLE'",
		"SELECT 1; -- trailing comment",
		"/* leading */ SELECT 1",
	}
	blocked := []string{
		"INSERT INTO equipment_telemetry VALUES (now(), 1, 1, 1, 1, 1, 1, 'd', 't', 'w')",
		"UPDATE equipment_telemetry SET current_val = 0",
		"DELETE FROM equipment_telemetry",
		"DROP TABLE equipment_telemetry",
		"CREATE TABLE x (a INT)",
		"ALTER TABLE equipment_telemetry ADD COLUMN x INT",
		"TRUNCATE TABLE equipment_telemetry",
		"SELECT 1; DROP TABLE equipment_telemetry",
		"SELECT pg_sleep(1000)",
		"SELECT nextval('x')",
		"SELECT * FROM crdb_internal.tables",
		"SELECT * FROM kwdb_internal.tables",
		"SHOW SESSIONS",
		"SHOW ALL",
		"GRANT SELECT ON equipment_telemetry TO root",
		"COPY equipment_telemetry FROM STDIN",
	}

	for _, sql := range allowed {
		if reason := ReadOnlyViolation(sql); reason != "" {
			t.Errorf("expected %q to be allowed, got: %s", sql, reason)
		}
	}
	for _, sql := range blocked {
		if reason := ReadOnlyViolation(sql); reason == "" {
			t.Errorf("expected %q to be blocked", sql)
		} else {
			t.Logf("blocked %q -> %s", sql, reason)
		}
	}

	// The guard must also fire inside query(), before touching the database.
	res := d.runQuery(t, "DROP TABLE equipment_telemetry", tr, "raw")
	if res.Error == nil {
		t.Fatal("expected query() to reject DROP TABLE")
	}
	if res.Status != backend.StatusBadRequest {
		t.Errorf("expected StatusBadRequest, got %v", res.Status)
	}
	if res.ErrorSource != backend.ErrorSourcePlugin {
		t.Errorf("expected ErrorSourcePlugin, got %v", res.ErrorSource)
	}
	t.Logf("guard message: %s", res.Error)
}

// TestRealServerSessionIsReadOnly verifies the connection-level
// default_transaction_read_only parameter is really honoured by KWDB, i.e. the
// defence-in-depth claim in applySessionSettings holds on a live server.
func TestRealServerSessionIsReadOnly(t *testing.T) {
	dsn := realDSN(t)
	d := realInstance(t, dsn)

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	conn, err := d.pool.Acquire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Release()

	var readOnly string
	if err := conn.QueryRow(ctx, "SHOW default_transaction_read_only").Scan(&readOnly); err != nil {
		t.Logf("SHOW default_transaction_read_only: %v", err)
	} else {
		t.Logf("session default_transaction_read_only = %s", readOnly)
		if !strings.Contains(readOnly, "on") {
			t.Error("expected default_transaction_read_only to be on")
		}
	}
	var timeout string
	if err := conn.QueryRow(ctx, "SHOW statement_timeout").Scan(&timeout); err != nil {
		t.Logf("SHOW statement_timeout: %v", err)
	} else {
		t.Logf("session statement_timeout = %s", timeout)
		if timeout == "" || timeout == "0" {
			t.Error("expected a non-zero statement_timeout on the pooled session")
		}
	}

	_, err = conn.Exec(ctx, "CREATE TABLE factory.realverify_probe (a INT)")
	if err == nil {
		_, _ = conn.Exec(ctx, "DROP TABLE factory.realverify_probe")
		t.Fatal("CREATE TABLE succeeded: the pooled session is not read-only")
	}
	t.Logf("write attempt rejected as expected: %v", err)
}

// ------------------------------------------------------------------- query modes

func TestRealServerQueryModes(t *testing.T) {
	dsn := realDSN(t)
	d := realInstance(t, dsn)
	tr := realTimeRange()

	const where = "k_timestamp >= $__timeFrom AND k_timestamp <= $__timeTo"

	cases := []struct {
		id      string
		rawSql  string
		mode    string
		format  string
		minRows int
	}{
		{"downsampling", "SELECT time_bucket(k_timestamp, '5m') AS \"time\", avg(current_val) AS \"avg_current_val\" FROM equipment_telemetry WHERE " + where + " GROUP BY \"time\" ORDER BY \"time\"", "downsampling", "", 1},
		{"downsampling+tags", "SELECT time_bucket(k_timestamp, '5m') AS \"time\", device_id, avg(current_val) AS \"avg_current_val\" FROM equipment_telemetry WHERE " + where + " GROUP BY \"time\", device_id ORDER BY \"time\", device_id", "downsampling", "", 1},
		{"gapfill", "SELECT time_bucket_gapfill(k_timestamp, '5m') AS \"time\", interpolate(avg(current_val), 'linear') AS \"avg_current_val\" FROM equipment_telemetry WHERE " + where + " GROUP BY \"time\" ORDER BY \"time\"", "gapfill", "", 1},
		{"gapfill constant", "SELECT time_bucket_gapfill(k_timestamp, '5m') AS \"time\", interpolate(avg(current_val), '0') AS \"avg_current_val\" FROM equipment_telemetry WHERE " + where + " GROUP BY \"time\" ORDER BY \"time\"", "gapfill", "", 1},
		{"latest", "SELECT device_id, last(current_val) AS \"latest_current_val\", last(k_timestamp) AS \"time\" FROM equipment_telemetry WHERE " + where + " GROUP BY device_id", "latest", "", 1},
		{"latest last_row", "SELECT device_id, last_row(current_val) AS \"latest_current_val\", last_row(k_timestamp) AS \"time\" FROM equipment_telemetry WHERE " + where + " GROUP BY device_id", "latest", "", 1},
		{"latest first", "SELECT device_id, first(current_val) AS \"latest_current_val\", first(k_timestamp) AS \"time\" FROM equipment_telemetry WHERE " + where + " GROUP BY device_id", "latest", "", 1},
		{"latest first_row", "SELECT device_id, first_row(current_val) AS \"latest_current_val\", first_row(k_timestamp) AS \"time\" FROM equipment_telemetry WHERE " + where + " GROUP BY device_id", "latest", "", 1},
		{"latest no tags", "SELECT last(current_val) AS \"latest_current_val\", last(k_timestamp) AS \"time\" FROM equipment_telemetry WHERE " + where, "latest", "", 1},
		{"window TIME_WINDOW", "SELECT first(k_timestamp) AS \"time\", avg(current_val) FROM equipment_telemetry WHERE " + where + " GROUP BY TIME_WINDOW(k_timestamp, '1h') ORDER BY \"time\"", "window", "", 1},
		{"window COUNT_WINDOW", "SELECT first(k_timestamp) AS \"time\", avg(current_val) FROM equipment_telemetry WHERE " + where + " GROUP BY COUNT_WINDOW(100) ORDER BY \"time\"", "window", "", 1},
		{"window EVENT_WINDOW", "SELECT first(k_timestamp) AS \"time\", avg(current_val) FROM equipment_telemetry WHERE " + where + " GROUP BY EVENT_WINDOW(current_val > 60, current_val < 20) ORDER BY \"time\"", "window", "", 1},
		{"window STATE_WINDOW", "SELECT first(k_timestamp) AS \"time\", avg(current_val) FROM equipment_telemetry WHERE " + where + " GROUP BY STATE_WINDOW(case when status_code = 1 then 1 else 0 end) ORDER BY \"time\"", "window", "", 1},
		{"raw count", "SELECT count(*) FROM equipment_telemetry WHERE " + where, "raw", "table", 1},
		{"table format", "SELECT k_timestamp, device_id, current_val FROM equipment_telemetry WHERE " + where + " ORDER BY k_timestamp LIMIT 50", "raw", "table", 1},
	}

	for _, tc := range cases {
		t.Run(tc.id, func(t *testing.T) {
			format := tc.format
			if format == "" {
				format = "time_series"
			}
			res := d.runQueryModel(t, map[string]any{
				"mode":       tc.mode,
				"format":     format,
				"rawSql":     tc.rawSql,
				"timeColumn": "k_timestamp",
				"tags":       []string{"device_id"},
			}, tr)
			if res.Error != nil {
				t.Fatalf("query failed: %v", res.Error)
			}
			total := 0
			for _, f := range res.Frames {
				total += f.Rows()
			}
			t.Logf("%s", frameSummary(t, res))
			if total < tc.minRows {
				t.Errorf("expected at least %d rows, got %d", tc.minRows, total)
			}
			if format == "time_series" && len(res.Frames) > 0 {
				f := res.Frames[0]
				if f.Fields[0].Name != "time" {
					t.Errorf("first field should be renamed to time, got %q", f.Fields[0].Name)
				}
			}
		})
	}
}

// TestRealServerLatestSplitByTag verifies the latest-value frame shapes on real
// data. With the default time_series format the long-to-wide conversion already
// produces one field per tag combination, so splitByTag has nothing left to do;
// it only applies to Table format, where it splits the result into one frame
// per tag combination.
func TestRealServerLatestSplitByTag(t *testing.T) {
	dsn := realDSN(t)
	d := realInstance(t, dsn)
	tr := realTimeRange()

	const raw = "SELECT device_id, last(current_val) AS \"latest_current_val\", last(k_timestamp) AS \"time\" FROM equipment_telemetry WHERE k_timestamp >= $__timeFrom AND k_timestamp <= $__timeTo GROUP BY device_id"

	res := d.runQueryModel(t, map[string]any{
		"mode": "latest", "format": "time_series", "rawSql": raw,
		"timeColumn": "k_timestamp", "tags": []string{"device_id"}, "splitByTag": true,
	}, tr)
	if res.Error != nil {
		t.Fatalf("time_series query failed: %v", res.Error)
	}
	t.Logf("time_series -> %d frame(s): %s", len(res.Frames), frameSummary(t, res))
	if len(res.Frames) != 1 {
		t.Fatalf("expected a single wide frame, got %d", len(res.Frames))
	}
	f := res.Frames[0]
	if f.Fields[0].Name != "time" {
		t.Errorf("first field = %q, want time", f.Fields[0].Name)
	}
	// One value field per device, each carrying a device_id label.
	labelled := 0
	for _, field := range f.Fields[1:] {
		if field.Labels["device_id"] != "" {
			labelled++
		}
	}
	if labelled != 4 {
		t.Errorf("expected 4 device-labelled fields, got %d", labelled)
	}

	res = d.runQueryModel(t, map[string]any{
		"mode": "latest", "format": "table", "rawSql": raw,
		"timeColumn": "k_timestamp", "tags": []string{"device_id"}, "splitByTag": true,
	}, tr)
	if res.Error != nil {
		t.Fatalf("table query failed: %v", res.Error)
	}
	t.Logf("table+splitByTag -> %d frame(s): %s", len(res.Frames), frameSummary(t, res))
	if len(res.Frames) != 4 {
		t.Errorf("expected one frame per device (4), got %d", len(res.Frames))
	}

	res = d.runQueryModel(t, map[string]any{
		"mode": "latest", "format": "table", "rawSql": raw,
		"timeColumn": "k_timestamp", "tags": []string{"device_id"}, "splitByTag": false,
	}, tr)
	if res.Error != nil {
		t.Fatalf("unsplit query failed: %v", res.Error)
	}
	t.Logf("table, no split -> %d frame(s): %s", len(res.Frames), frameSummary(t, res))
	if len(res.Frames) != 1 {
		t.Errorf("expected a single frame, got %d", len(res.Frames))
	}
}

// TestRealServerMaxRowsTruncation verifies the row cap and its notice.
func TestRealServerMaxRowsTruncation(t *testing.T) {
	dsn := realDSN(t)
	tr := realTimeRange()

	// maxRows is a data source setting (jsonData), not a per-query field.
	capped := realInstanceWith(t, dsn, map[string]any{"maxRows": 1000})
	res := capped.runQueryModel(t, map[string]any{
		"mode": "raw", "format": "table",
		"rawSql":     "SELECT k_timestamp, device_id, current_val FROM equipment_telemetry WHERE k_timestamp >= $__timeFrom AND k_timestamp <= $__timeTo ORDER BY k_timestamp",
		"timeColumn": "k_timestamp",
	}, tr)
	if res.Error != nil {
		t.Fatalf("query failed: %v", res.Error)
	}
	for _, f := range res.Frames {
		t.Logf("rows=%d", f.Rows())
		if f.Rows() != 1000 {
			t.Errorf("expected the frame to be capped at 1000 rows, got %d", f.Rows())
		}
		if len(f.Meta.Notices) == 0 {
			t.Error("expected a truncation notice on the frame")
		} else {
			for _, n := range f.Meta.Notices {
				t.Logf("notice: %s (severity %v)", n.Text, n.Severity)
			}
		}
	}
}

// ---------------------------------------------------------------------- metadata

func TestRealServerMetadataResources(t *testing.T) {
	dsn := realDSN(t)
	d := realInstance(t, dsn)

	resp := callResource(t, d.handler, "/tables")
	if resp.Status != 200 {
		t.Fatalf("/tables status %d: %s", resp.Status, resp.Body)
	}
	t.Logf("/tables -> %s", string(resp.Body))

	resp = callResource(t, d.handler, "/columns?table=equipment_telemetry")
	if resp.Status != 200 {
		t.Fatalf("/columns status %d: %s", resp.Status, resp.Body)
	}
	var cols []ColumnInfo
	if err := json.Unmarshal(resp.Body, &cols); err != nil {
		t.Fatalf("unmarshal columns: %v", err)
	}
	tags := map[string]bool{}
	for _, c := range cols {
		t.Logf("  %-16s %-14s tag=%v time=%v primary=%v", c.Name, c.Type, c.IsTag, c.IsTimeColumn, c.IsPrimaryTag)
		if c.IsTag {
			tags[c.Name] = true
		}
	}
	for _, want := range []string{"device_id", "device_type", "workshop_id"} {
		if !tags[want] {
			t.Errorf("%s should be reported as a tag", want)
		}
	}
	// k_timestamp is a data column, not a tag: it must be flagged as the time
	// column and left out of the tag set.
	byName := map[string]ColumnInfo{}
	for _, c := range cols {
		byName[c.Name] = c
	}
	if !byName["k_timestamp"].IsTimeColumn {
		t.Error("k_timestamp should be recognised as the time column")
	}
	if byName["k_timestamp"].IsTag {
		t.Error("k_timestamp should not be reported as a tag")
	}
	if !byName["device_id"].IsPrimaryTag {
		t.Error("device_id is the PRIMARY TAGS column and should be flagged")
	}
	if byName["device_type"].IsPrimaryTag {
		t.Error("device_type is a plain tag, not a primary tag")
	}
	if byName["current_val"].IsTimeColumn || byName["current_val"].IsTag {
		t.Error("current_val is a plain data column")
	}

	resp = callResource(t, d.handler, "/tag-values?table=equipment_telemetry&column=device_id")
	if resp.Status != 200 {
		t.Fatalf("/tag-values status %d: %s", resp.Status, resp.Body)
	}
	var values []string
	if err := json.Unmarshal(resp.Body, &values); err != nil {
		t.Fatalf("unmarshal tag values: %v", err)
	}
	t.Logf("/tag-values device_id -> %v", values)
	if len(values) != 4 {
		t.Errorf("expected 4 distinct devices, got %d", len(values))
	}

	// A non-tag column must be rejected rather than returning data.
	resp = callResource(t, d.handler, "/tag-values?table=equipment_telemetry&column=current_val")
	if resp.Status != 400 {
		t.Errorf("expected 400 for a non-tag column, got %d: %s", resp.Status, resp.Body)
	} else {
		t.Logf("non-tag column rejected: %s", resp.Body)
	}
}
