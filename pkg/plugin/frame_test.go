package plugin

import (
	"math/big"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/grafana/grafana-plugin-sdk-go/data"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
)

func TestRowsToFrameTableFormatMapsTypes(t *testing.T) {
	ts := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	rows := &mockRows{
		fields: []pgconn.FieldDescription{
			{Name: "ts", DataTypeOID: 1184},
			{Name: "device_id", DataTypeOID: 25},
			{Name: "temperature", DataTypeOID: 701},
			{Name: "samples", DataTypeOID: 23},
			{Name: "ok", DataTypeOID: 16},
			{Name: "extra", DataTypeOID: 9999},
		},
		rows: [][]any{
			{ts, "A", 21.5, int32(3), true, "raw"},
		},
	}

	frame, err := RowsToFrame(rows, "table", "", nil)
	if err != nil {
		t.Fatal(err)
	}

	wantTypes := []data.FieldType{
		data.FieldTypeTime,
		data.FieldTypeString,
		data.FieldTypeFloat64,
		data.FieldTypeInt32,
		data.FieldTypeBool,
		data.FieldTypeString,
	}
	for i, want := range wantTypes {
		if got := frame.Fields[i].Type(); got != want {
			t.Errorf("field %d type = %v, want %v", i, got, want)
		}
	}
	if rowLen, err := frame.RowLen(); err != nil || rowLen != 1 {
		t.Fatalf("RowLen = %d, %v; want 1", rowLen, err)
	}
}

func TestRowsToFrameOIDMappings(t *testing.T) {
	rows := &mockRows{
		fields: []pgconn.FieldDescription{
			{Name: "big", DataTypeOID: 20},
			{Name: "small", DataTypeOID: 21},
			{Name: "oid_col", DataTypeOID: 26},
			{Name: "f4", DataTypeOID: 700},
			{Name: "varchar_col", DataTypeOID: 1043},
			{Name: "avg_col", DataTypeOID: 1700},
		},
		rows: [][]any{
			{int64(9), int16(2), uint32(7), float32(1.5), "v", pgtype.Numeric{Int: big.NewInt(125), Exp: -1, Valid: true}},
		},
	}

	frame, err := RowsToFrame(rows, "table", "", nil)
	if err != nil {
		t.Fatal(err)
	}

	wantTypes := []data.FieldType{
		data.FieldTypeInt64,
		data.FieldTypeInt64,
		data.FieldTypeInt32,
		data.FieldTypeFloat64,
		data.FieldTypeString,
		data.FieldTypeFloat64,
	}
	for i, want := range wantTypes {
		if got := frame.Fields[i].Type(); got != want {
			t.Errorf("field %d type = %v, want %v", i, got, want)
		}
	}
	if got := frame.Fields[5].At(0).(float64); got != 12.5 {
		t.Errorf("numeric value = %v, want 12.5", got)
	}
}

func TestRowsToFrameTruncatesAtMaxRows(t *testing.T) {
	rows := &mockRows{
		fields: []pgconn.FieldDescription{{Name: "value", DataTypeOID: 701}},
		rows: [][]any{
			{1.0},
			{2.0},
			{3.0},
		},
	}

	frames, err := RowsToFrames(rows, FrameOptions{Format: "table", MaxRows: 2})
	if err != nil {
		t.Fatal(err)
	}
	if len(frames) != 1 {
		t.Fatalf("frame count = %d, want 1", len(frames))
	}
	frame := frames[0]
	rowLen, err := frame.RowLen()
	if err != nil {
		t.Fatal(err)
	}
	if rowLen != 2 {
		t.Fatalf("RowLen = %d, want 2", rowLen)
	}
	if frame.Meta == nil || len(frame.Meta.Notices) == 0 {
		t.Fatal("expected a truncation notice in frame meta")
	}
	if !strings.Contains(frame.Meta.Notices[0].Text, "truncated at 2 rows") {
		t.Errorf("notice text = %q, want truncation message", frame.Meta.Notices[0].Text)
	}
}

func TestRowsToFrameTimeOID(t *testing.T) {
	rows := &mockRows{
		fields: []pgconn.FieldDescription{
			{Name: "tod", DataTypeOID: 1083},
			{Name: "value", DataTypeOID: 701},
		},
		rows: [][]any{
			{pgtype.Time{Microseconds: 36_000_000_000, Valid: true}, 1.5},
		},
	}

	frame, err := RowsToFrame(rows, "table", "", nil)
	if err != nil {
		t.Fatal(err)
	}
	if got := frame.Fields[0].Type(); got != data.FieldTypeTime {
		t.Fatalf("time column type = %v, want %v", got, data.FieldTypeTime)
	}
	if got := frame.Fields[0].At(0).(time.Time); got.Hour() != 10 {
		t.Errorf("time value = %v, want hour 10", got)
	}
}

func TestRowsToFrameTimeSeriesLongToWide(t *testing.T) {
	t1 := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	t2 := time.Date(2026, 1, 1, 0, 1, 0, 0, time.UTC)
	rows := &mockRows{
		fields: []pgconn.FieldDescription{
			{Name: "ts", DataTypeOID: 1184},
			{Name: "device_id", DataTypeOID: 25},
			{Name: "temperature", DataTypeOID: 701},
		},
		rows: [][]any{
			{t2, "A", 20.0},
			{t1, "A", 10.0},
			{t2, "B", 30.0},
			{t1, "B", 5.0},
		},
	}

	frame, err := RowsToFrame(rows, "time_series", "ts", []string{"device_id"})
	if err != nil {
		t.Fatal(err)
	}

	if got := frame.Fields[0].Name; got != "time" {
		t.Fatalf("first field name = %q, want time", got)
	}
	if got := frame.Fields[0].At(0).(time.Time); !got.Equal(t1) {
		t.Errorf("first time = %v, want %v", got, t1)
	}
	if got := frame.Fields[0].At(1).(time.Time); !got.Equal(t2) {
		t.Errorf("second time = %v, want %v", got, t2)
	}

	byLabel := map[string]*data.Field{}
	for _, field := range frame.Fields[1:] {
		byLabel[field.Labels["device_id"]] = field
	}
	if field := byLabel["A"]; field == nil || field.At(0).(float64) != 10.0 || field.At(1).(float64) != 20.0 {
		t.Errorf("device A field missing or unsorted: %#v", field)
	}
	if field := byLabel["B"]; field == nil || field.At(0).(float64) != 5.0 || field.At(1).(float64) != 30.0 {
		t.Errorf("device B field missing or unsorted: %#v", field)
	}
}

// The latest-values builder selects the metrics before the time column, so the
// time field is not first in the result. A frame without string/bool columns is
// already "wide" and data.LongToWide is not called, which would leave the time
// field last and make Grafana treat the frame as a table.
func TestRowsToFrameTimeSeriesTimeFieldLeads(t *testing.T) {
	t1 := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	t2 := time.Date(2026, 1, 1, 0, 1, 0, 0, time.UTC)
	rows := &mockRows{
		fields: []pgconn.FieldDescription{
			{Name: "latest_current_val", DataTypeOID: 701},
			{Name: "k_timestamp", DataTypeOID: 1184},
		},
		rows: [][]any{
			{10.0, t2},
			{5.0, t1},
		},
	}

	frame, err := RowsToFrame(rows, "time_series", "k_timestamp", nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(frame.Fields) != 2 {
		t.Fatalf("field count = %d, want 2", len(frame.Fields))
	}
	if got := frame.Fields[0].Name; got != "time" {
		t.Errorf("first field name = %q, want time (time field must lead)", got)
	}
	if got := frame.Fields[1].Name; got != "latest_current_val" {
		t.Errorf("second field name = %q, want latest_current_val", got)
	}
	if got, ok := frame.Fields[0].At(0).(time.Time); !ok || !got.Equal(t1) {
		t.Fatalf("first time = %v (type %T), want %v (rows must be sorted by time)", frame.Fields[0].At(0), frame.Fields[0].At(0), t1)
	}
	if frame.TimeSeriesSchema().Type != data.TimeSeriesTypeWide {
		t.Errorf("schema type = %v, want wide", frame.TimeSeriesSchema().Type)
	}
}

// The same statement with a tag column goes through the long-to-wide path,
// which hoists the time field itself. This test guards that interaction: it
// cannot fail if moveTimeFirst is removed (LongToWide already leads with time),
// so it is not the regression test for moveTimeFirst - see
// TestMoveTimeFirstMovesTimeColumnToFront.
func TestRowsToFrameTimeSeriesTimeFieldLeadsWithTag(t *testing.T) {
	t1 := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	rows := &mockRows{
		fields: []pgconn.FieldDescription{
			{Name: "device_id", DataTypeOID: 25},
			{Name: "latest_current_val", DataTypeOID: 701},
			{Name: "k_timestamp", DataTypeOID: 1184},
		},
		rows: [][]any{
			{"A", 10.0, t1},
		},
	}

	frame, err := RowsToFrame(rows, "time_series", "k_timestamp", []string{"device_id"})
	if err != nil {
		t.Fatal(err)
	}
	if got := frame.Fields[0].Name; got != "time" {
		t.Errorf("first field name = %q, want time", got)
	}
}

func TestRowsToFrameTimeSeriesNumericTagBecomesLabel(t *testing.T) {
	t1 := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	t2 := time.Date(2026, 1, 1, 0, 1, 0, 0, time.UTC)
	rows := &mockRows{
		fields: []pgconn.FieldDescription{
			{Name: "ts", DataTypeOID: 1184},
			{Name: "device_id", DataTypeOID: 23},
			{Name: "temperature", DataTypeOID: 701},
		},
		rows: [][]any{
			{t2, int32(1), 20.0},
			{t1, int32(1), 10.0},
			{t2, int32(2), 30.0},
			{t1, int32(2), 5.0},
		},
	}

	frame, err := RowsToFrame(rows, "time_series", "ts", []string{"device_id"})
	if err != nil {
		t.Fatal(err)
	}

	byLabel := map[string]*data.Field{}
	for _, field := range frame.Fields[1:] {
		byLabel[field.Labels["device_id"]] = field
	}
	if len(byLabel) != 2 {
		t.Fatalf("got %d series, want 2: %#v", len(byLabel), byLabel)
	}
	if field := byLabel["1"]; field == nil || field.At(0).(float64) != 10.0 || field.At(1).(float64) != 20.0 {
		t.Errorf("device 1 field missing or unsorted: %#v", field)
	}
	if field := byLabel["2"]; field == nil || field.At(0).(float64) != 5.0 || field.At(1).(float64) != 30.0 {
		t.Errorf("device 2 field missing or unsorted: %#v", field)
	}
}

func TestRowsToFrameFallsBackToTimestampColumn(t *testing.T) {
	ts := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	rows := &mockRows{
		fields: []pgconn.FieldDescription{
			{Name: "k_timestamp", DataTypeOID: 1114},
			{Name: "value", DataTypeOID: 701},
		},
		rows: [][]any{
			{ts, 1.5},
		},
	}

	frame, err := RowsToFrame(rows, "time_series", "", nil)
	if err != nil {
		t.Fatal(err)
	}
	if got := frame.Fields[0].Name; got != "time" {
		t.Errorf("fallback time field name = %q, want time", got)
	}
}

func TestRowsToFrameMissingTimeColumn(t *testing.T) {
	rows := &mockRows{
		fields: []pgconn.FieldDescription{
			{Name: "device_id", DataTypeOID: 25},
			{Name: "temperature", DataTypeOID: 701},
		},
		rows: [][]any{
			{"A", 20.0},
		},
	}

	_, err := RowsToFrame(rows, "time_series", "", nil)
	if err == nil || !strings.Contains(err.Error(), "time column") {
		t.Fatalf("expected time column error, got %v", err)
	}
}

func TestRowsToFrameEmptyTimeSeries(t *testing.T) {
	rows := &mockRows{
		fields: []pgconn.FieldDescription{
			{Name: "ts", DataTypeOID: 1184},
			{Name: "value", DataTypeOID: 701},
		},
	}

	frame, err := RowsToFrame(rows, "time_series", "", nil)
	if err != nil {
		t.Fatal(err)
	}
	if got := frame.Fields[0].Name; got != "time" {
		t.Errorf("empty time series first field = %q, want time", got)
	}
	if rowLen, err := frame.RowLen(); err != nil || rowLen != 0 {
		t.Fatalf("RowLen = %d, %v; want 0", rowLen, err)
	}
}

func TestRowsToFrameTableFormatNulls(t *testing.T) {
	rows := &mockRows{
		fields: []pgconn.FieldDescription{
			{Name: "ts", DataTypeOID: 1184},
			{Name: "device_id", DataTypeOID: 25},
			{Name: "temperature", DataTypeOID: 701},
			{Name: "samples", DataTypeOID: 23},
			{Name: "ok", DataTypeOID: 16},
		},
		rows: [][]any{
			{nil, nil, nil, nil, nil},
			{time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC), "A", 21.5, int32(3), true},
		},
	}

	frame, err := RowsToFrame(rows, "table", "", nil)
	if err != nil {
		t.Fatal(err)
	}

	wantTypes := []data.FieldType{
		data.FieldTypeNullableTime,
		data.FieldTypeNullableString,
		data.FieldTypeNullableFloat64,
		data.FieldTypeNullableInt32,
		data.FieldTypeNullableBool,
	}
	for i, want := range wantTypes {
		if got := frame.Fields[i].Type(); got != want {
			t.Errorf("field %d type = %v, want %v", i, got, want)
		}
	}
	for i := range wantTypes {
		if got := frame.Fields[i].At(0); !isNilValue(got) {
			t.Errorf("field %d first value = %#v, want nil", i, got)
		}
	}
	if got := frame.Fields[2].At(1).(*float64); got == nil || *got != 21.5 {
		t.Errorf("temperature second value = %#v, want 21.5", got)
	}
}

func TestRowsToFrameTimeSeriesWithNulls(t *testing.T) {
	t1 := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	t2 := time.Date(2026, 1, 1, 0, 1, 0, 0, time.UTC)
	rows := &mockRows{
		fields: []pgconn.FieldDescription{
			{Name: "ts", DataTypeOID: 1184},
			{Name: "device_id", DataTypeOID: 25},
			{Name: "temperature", DataTypeOID: 701},
		},
		rows: [][]any{
			{t1, "A", 10.0},
			{t2, "A", nil},
			{t1, "B", nil},
			{t2, "B", 30.0},
		},
	}

	frame, err := RowsToFrame(rows, "time_series", "ts", []string{"device_id"})
	if err != nil {
		t.Fatal(err)
	}

	byLabel := map[string]*data.Field{}
	for _, field := range frame.Fields[1:] {
		byLabel[field.Labels["device_id"]] = field
	}
	fieldA := byLabel["A"]
	if fieldA == nil {
		t.Fatal("device A field missing")
	}
	if got := fieldA.At(0).(*float64); got == nil || *got != 10.0 {
		t.Errorf("device A first value = %#v, want 10.0", got)
	}
	if got := fieldA.At(1); !isNilValue(got) {
		t.Errorf("device A second value = %#v, want nil", got)
	}
	fieldB := byLabel["B"]
	if fieldB == nil {
		t.Fatal("device B field missing")
	}
	if got := fieldB.At(0); !isNilValue(got) {
		t.Errorf("device B first value = %#v, want nil", got)
	}
	if got := fieldB.At(1).(*float64); got == nil || *got != 30.0 {
		t.Errorf("device B second value = %#v, want 30.0", got)
	}
}

func isNilValue(v any) bool {
	if v == nil {
		return true
	}
	rv := reflect.ValueOf(v)
	switch rv.Kind() {
	case reflect.Pointer, reflect.Map, reflect.Slice, reflect.Func, reflect.Interface, reflect.Chan:
		return rv.IsNil()
	default:
		return false
	}
}

// TestMoveTimeFirstMovesTimeColumnToFront is the direct regression test for the
// latest-values fix: moveTimeFirst must put the time column first and keep
// every other column in its original relative order.
func TestMoveTimeFirstMovesTimeColumnToFront(t *testing.T) {
	plans := []columnPlan{
		{name: "latest_current_val"},
		{name: "device_id"},
		{name: "time"},
	}
	got := moveTimeFirst(plans, 2)
	if len(got) != len(plans) {
		t.Fatalf("plan count = %d, want %d", len(got), len(plans))
	}
	wantNames := []string{"time", "latest_current_val", "device_id"}
	for i, want := range wantNames {
		if got[i].name != want {
			t.Fatalf("plan[%d] = %q, want %q", i, got[i].name, want)
		}
	}
	// The original plans slice must not be mutated.
	if plans[0].name != "latest_current_val" {
		t.Fatalf("moveTimeFirst mutated its input: %#v", plans)
	}

	// A time column that is already first is returned untouched.
	alreadyFirst := []columnPlan{{name: "time"}, {name: "v"}}
	if got := moveTimeFirst(alreadyFirst, 0); got[0].name != "time" || got[1].name != "v" {
		t.Fatalf("moveTimeFirst(timeIdx=0) = %#v", got)
	}
}

// TestRowsToFramesTruncationNoticeOnEverySplitFrame makes sure every frame
// produced by splitLatestFrames carries the truncation notice, not only the
// first one.
func TestRowsToFramesTruncationNoticeOnEverySplitFrame(t *testing.T) {
	t1 := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	rows := &mockRows{
		fields: []pgconn.FieldDescription{
			{Name: "device_id", DataTypeOID: 25},
			{Name: "latest_current_val", DataTypeOID: 701},
			{Name: "k_timestamp", DataTypeOID: 1184},
		},
		rows: [][]any{
			{"A", 1.0, t1},
			{"B", 2.0, t1},
			{"C", 3.0, t1},
			{"D", 4.0, t1},
		},
	}

	frames, err := RowsToFrames(rows, FrameOptions{
		Format: "table", Mode: "latest", TimeColumn: "k_timestamp",
		Tags: []string{"device_id"}, MaxRows: 2,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(frames) < 2 {
		t.Fatalf("expected the truncated result to split into several frames, got %d", len(frames))
	}
	for i, frame := range frames {
		if frame.Meta == nil || len(frame.Meta.Notices) == 0 {
			t.Errorf("frame[%d] (%q) has no truncation notice", i, frame.Name)
			continue
		}
		if !strings.Contains(frame.Meta.Notices[0].Text, "truncated at 2 rows") {
			t.Errorf("frame[%d] notice = %q, want a truncation message", i, frame.Meta.Notices[0].Text)
		}
	}
}

// A configured time column that exists but is not a timestamp must produce a
// readable error instead of the generic "could not convert frame" one.
func TestRowsToFrameConfiguredTimeColumnIsNotATimestamp(t *testing.T) {
	rows := &mockRows{
		fields: []pgconn.FieldDescription{
			{Name: "k_timestamp", DataTypeOID: 25},
			{Name: "value", DataTypeOID: 701},
		},
		rows: [][]any{
			{"not-a-time", 1.0},
		},
	}
	_, err := RowsToFrame(rows, "time_series", "k_timestamp", nil)
	if err == nil || !strings.Contains(err.Error(), "not a timestamp column") {
		t.Fatalf("expected a readable time column type error, got %v", err)
	}
}
