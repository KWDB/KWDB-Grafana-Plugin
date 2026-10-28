package plugin

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
	"github.com/grafana/grafana-plugin-sdk-go/backend/instancemgmt"
	"github.com/grafana/grafana-plugin-sdk-go/data"
	"github.com/grafana/grafana-plugin-sdk-go/experimental/concurrent"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/kaiwudb/kwdb-tsdb-datasource/pkg/models"
)

var (
	_ backend.QueryDataHandler      = (*Datasource)(nil)
	_ backend.CheckHealthHandler    = (*Datasource)(nil)
	_ backend.CallResourceHandler   = (*Datasource)(nil)
	_ instancemgmt.InstanceDisposer = (*Datasource)(nil)
)

// Datasource implements the Grafana backend data source handlers.
type Datasource struct {
	pool    *pgxpool.Pool
	handler backend.CallResourceHandler
	// queryTimeout bounds a single query; zero disables the context deadline
	// (the connection-level statement_timeout still applies).
	queryTimeout time.Duration
	// maxRows caps the rows buffered per frame; zero disables the cap.
	maxRows int
}

// resolveFormat returns the effective output format for a query. Builder
// modes (downsampling/gapfill/latest/window) default to time series when the
// format was never persisted; raw SQL keeps whatever was sent so non-time
// table queries keep working.
func resolveFormat(mode, format string) string {
	if format != "" || mode == "raw" {
		return format
	}
	return "time_series"
}

// QueryData handles multiple queries and returns one response per query.
func (d *Datasource) QueryData(ctx context.Context, req *backend.QueryDataRequest) (*backend.QueryDataResponse, error) {
	return concurrent.QueryData(ctx, req, d.handleQuery, 10)
}

func (d *Datasource) handleQuery(ctx context.Context, query concurrent.Query) (res backend.DataResponse) {
	return d.query(ctx, query.DataQuery)
}

func (d *Datasource) query(ctx context.Context, query backend.DataQuery) backend.DataResponse {
	var qm models.QueryModel
	err := json.Unmarshal(query.JSON, &qm)
	if err != nil {
		return backend.ErrDataResponseWithSource(backend.StatusBadRequest, backend.ErrorSourcePlugin, fmt.Sprintf("json unmarshal: %v", err.Error()))
	}

	if strings.TrimSpace(qm.RawSql) == "" {
		return backend.ErrDataResponseWithSource(backend.StatusBadRequest, backend.ErrorSourcePlugin,
			"query is empty: select a table, time column and at least one metric, or write a statement in Raw SQL mode")
	}

	sql := ExpandMacros(qm.RawSql, query.TimeRange)
	if reason := ReadOnlyViolation(sql); reason != "" {
		return backend.ErrDataResponseWithSource(backend.StatusBadRequest, backend.ErrorSourcePlugin, reason)
	}
	if query.TimeRange.From.After(query.TimeRange.To) {
		return backend.ErrDataResponseWithSource(backend.StatusBadRequest, backend.ErrorSourcePlugin,
			"invalid time range: from is after to")
	}

	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	if d.queryTimeout > 0 {
		timeoutCtx, timeoutCancel := context.WithTimeout(ctx, d.queryTimeout)
		defer timeoutCancel()
		ctx = timeoutCtx
	}

	rows, err := ExecuteQuery(ctx, d.pool, sql)
	if err != nil {
		backend.Logger.FromContext(ctx).Error("KWDB query failed", "refId", query.RefID, "error", err)
		return backend.DataResponse{Error: errors.New(sanitizeError(err)), ErrorSource: errorSourceFor(err)}
	}
	frames, err := RowsToFrames(rows, FrameOptions{
		Format:     resolveFormat(qm.Mode, qm.Format),
		Mode:       qm.Mode,
		TimeColumn: qm.TimeColumn,
		Tags:       qm.Tags,
		SplitByTag: qm.SplitByTag,
		MaxRows:    d.maxRows,
		// Cancelling the context makes pgx abort the statement instead of
		// draining every remaining row after the row cap was hit.
		OnTruncate: cancel,
	})
	if err != nil {
		backend.Logger.FromContext(ctx).Error("KWDB query failed", "refId", query.RefID, "error", err)
		return backend.DataResponse{Error: errors.New(sanitizeError(err)), ErrorSource: errorSourceFor(err)}
	}
	response := make(data.Frames, 0, len(frames))
	for _, frame := range frames {
		frame.RefID = query.RefID
		response = append(response, frame)
	}
	return backend.DataResponse{Frames: response}
}

// errorSourceFor classifies an error as produced by the database (downstream)
// or by the plugin itself. Errors surfaced by pgx while scanning rows are
// database errors even though they are raised inside the frame conversion.
func errorSourceFor(err error) backend.ErrorSource {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		return backend.ErrorSourceDownstream
	}
	if errors.Is(err, context.DeadlineExceeded) || errors.Is(err, context.Canceled) {
		return backend.ErrorSourceDownstream
	}
	return backend.ErrorSourcePlugin
}

// CheckHealth verifies connectivity by executing SELECT 1.
func (d *Datasource) CheckHealth(ctx context.Context, _ *backend.CheckHealthRequest) (*backend.CheckHealthResult, error) {
	if d.pool == nil {
		return &backend.CheckHealthResult{Status: backend.HealthStatusError, Message: "database connection pool is not initialized"}, nil
	}
	rows, err := d.pool.Query(ctx, "SELECT 1")
	if err != nil {
		return &backend.CheckHealthResult{Status: backend.HealthStatusError, Message: healthCheckMessage(err)}, nil
	}
	defer rows.Close()
	for rows.Next() {
		var one int32
		if err := rows.Scan(&one); err != nil {
			return &backend.CheckHealthResult{Status: backend.HealthStatusError, Message: healthCheckMessage(err)}, nil
		}
	}
	if err := rows.Err(); err != nil {
		return &backend.CheckHealthResult{Status: backend.HealthStatusError, Message: healthCheckMessage(err)}, nil
	}
	return &backend.CheckHealthResult{
		Status:  backend.HealthStatusOk,
		Message: "Data source is working",
	}, nil
}

// CallResource delegates to the metadata resource handler.
func (d *Datasource) CallResource(ctx context.Context, req *backend.CallResourceRequest, sender backend.CallResourceResponseSender) error {
	if d.handler == nil {
		return fmt.Errorf("resource handler is not initialized")
	}
	return d.handler.CallResource(ctx, req, sender)
}

// Dispose closes the connection pool when the instance is replaced.
func (d *Datasource) Dispose() {
	if d.pool != nil {
		d.pool.Close()
	}
}
