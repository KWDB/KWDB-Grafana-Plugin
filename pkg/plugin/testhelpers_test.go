package plugin

import (
	"context"
	"fmt"
	"math"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

type mockRows struct {
	mu     sync.Mutex
	fields []pgconn.FieldDescription
	rows   [][]any
	idx    int
	err    error
}

func (r *mockRows) Close() {}

func (r *mockRows) Err() error { return r.err }

func (r *mockRows) CommandTag() pgconn.CommandTag { return pgconn.CommandTag{} }

func (r *mockRows) FieldDescriptions() []pgconn.FieldDescription { return r.fields }

func (r *mockRows) Next() bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.idx >= len(r.rows) {
		return false
	}
	r.idx++
	return true
}

func (r *mockRows) Scan(dest ...any) error {
	values, err := r.Values()
	if err != nil {
		return err
	}
	if len(dest) != len(values) {
		return fmt.Errorf("expected %d destinations, got %d", len(values), len(dest))
	}
	for i := range dest {
		switch d := dest[i].(type) {
		case *string:
			*d = fmt.Sprint(values[i])
		case *int64:
			*d = toInt64(values[i])
		case *int32:
			n := toInt64(values[i])
			if n < math.MinInt32 || n > math.MaxInt32 {
				return fmt.Errorf("value %d overflows int32", n)
			}
			*d = int32(n)
		case *float64:
			*d = toFloat64(values[i])
		case *bool:
			b, ok := values[i].(bool)
			if !ok {
				return fmt.Errorf("cannot convert %T to bool", values[i])
			}
			*d = b
		case *time.Time:
			t, ok := values[i].(time.Time)
			if !ok {
				return fmt.Errorf("cannot convert %T to time.Time", values[i])
			}
			*d = t
		default:
			return fmt.Errorf("unsupported scan target %T", dest[i])
		}
	}
	return nil
}

func (r *mockRows) Values() ([]any, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.idx == 0 || r.idx > len(r.rows) {
		return nil, fmt.Errorf("no current row")
	}
	return r.rows[r.idx-1], nil
}

func (r *mockRows) RawValues() [][]byte { return nil }

func (r *mockRows) Conn() *pgx.Conn { return nil }

func toInt64(v any) int64 {
	switch n := v.(type) {
	case int64:
		return n
	case int32:
		return int64(n)
	case int16:
		return int64(n)
	case uint32:
		return int64(n)
	default:
		return 0
	}
}

func toFloat64(v any) float64 {
	switch n := v.(type) {
	case float64:
		return n
	case float32:
		return float64(n)
	case int64:
		return float64(n)
	case int32:
		return float64(n)
	default:
		return 0
	}
}

type fakeQuerier struct {
	fn func(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
}

func (f *fakeQuerier) Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error) {
	return f.fn(ctx, sql, args...)
}

func callResource(t *testing.T, handler backend.CallResourceHandler, path string) backend.CallResourceResponse {
	t.Helper()
	var resp backend.CallResourceResponse
	pathOnly := path
	if idx := strings.IndexByte(path, '?'); idx >= 0 {
		pathOnly = path[:idx]
	}
	err := handler.CallResource(context.Background(), &backend.CallResourceRequest{
		PluginContext: backend.PluginContext{DataSourceInstanceSettings: &backend.DataSourceInstanceSettings{}},
		Method:        "GET",
		Path:          pathOnly,
		URL:           path,
	}, backend.CallResourceResponseSenderFunc(func(r *backend.CallResourceResponse) error {
		resp = *r
		return nil
	}))
	if err != nil {
		t.Fatalf("CallResource failed: %v", err)
	}
	return resp
}
