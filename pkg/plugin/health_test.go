package plugin

import (
	"context"
	"crypto/x509"
	"errors"
	"fmt"
	"net"
	"strings"
	"syscall"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"
)

func pgError(code, message string) error {
	return &pgconn.PgError{Severity: "ERROR", Code: code, Message: message}
}

func TestHealthHint(t *testing.T) {
	tests := []struct {
		name    string
		err     error
		wantHas string
		wantNil bool
	}{
		{
			name:    "nil error",
			err:     nil,
			wantNil: true,
		},
		{
			name:    "invalid password",
			err:     pgError("28P01", "password authentication failed for user \"root\""),
			wantHas: "Authentication failed",
		},
		{
			name:    "hba policy rejection",
			err:     pgError("28000", "no pg_hba.conf entry for host, SSL off"),
			wantHas: "HBA",
		},
		{
			name:    "plaintext rejected by configuration is not a password problem",
			err:     pgError("28000", "authentication rejected by configuration"),
			wantHas: "HBA",
		},
		{
			name:    "plain 28000 authorization failure stays an authentication hint",
			err:     pgError("28000", "authentication failed"),
			wantHas: "Authentication failed",
		},
		{
			name:    "unknown database",
			err:     pgError("3D000", "database \"nope\" does not exist"),
			wantHas: "database does not exist",
		},
		{
			name:    "undefined object for the database",
			err:     pgError("42704", "database \"nope\" does not exist"),
			wantHas: "database does not exist",
		},
		{
			name:    "permission denied",
			err:     pgError("42501", "permission denied for database"),
			wantHas: "Permission denied",
		},
		{
			name:    "connection exception class",
			err:     pgError("08006", "connection failure"),
			wantHas: "connection to KWDB was dropped",
		},
		{
			name:    "admin shutdown",
			err:     pgError("57P01", "terminating connection due to administrator command"),
			wantNil: true,
		},
		{
			name:    "syntax error is left to the raw message",
			err:     pgError("42601", "syntax error at or near \"SELCT\""),
			wantNil: true,
		},
		{
			name:    "deadline exceeded",
			err:     fmt.Errorf("connect: %w", context.DeadlineExceeded),
			wantHas: "timed out",
		},
		{
			// A canceled request is not a timeout and must not tell the user to
			// check the host and port.
			name:    "context canceled",
			err:     fmt.Errorf("connect: %w", context.Canceled),
			wantHas: "canceled",
		},
		{
			name:    "net timeout",
			err:     &net.OpError{Op: "dial", Err: &timeoutError{}},
			wantHas: "timed out",
		},
		{
			name:    "connection refused",
			err:     &net.OpError{Op: "dial", Net: "tcp", Err: syscall.ECONNREFUSED},
			wantHas: "refused the connection",
		},
		{
			name:    "host unreachable",
			err:     &net.OpError{Op: "dial", Net: "tcp", Err: syscall.EHOSTUNREACH},
			wantHas: "refused the connection",
		},
		{
			name:    "unknown certificate authority",
			err:     x509.UnknownAuthorityError{},
			wantHas: "TLS negotiation failed",
		},
		{
			name:    "hostname mismatch",
			err:     x509.HostnameError{Host: "kwdb.example"},
			wantHas: "TLS negotiation failed",
		},
		{
			name:    "server does not offer ssl",
			err:     errors.New("failed to connect to host=kwdb:26257: pgconn: SSL is not enabled on the server"),
			wantHas: "TLS negotiation failed",
		},
		{
			name:    "certificate message",
			err:     errors.New("x509: certificate signed by unknown authority"),
			wantHas: "TLS negotiation failed",
		},
		{
			name:    "unrelated error keeps the raw message",
			err:     errors.New("something unexpected happened"),
			wantNil: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := healthHint(tt.err)
			if tt.wantNil {
				if got != "" {
					t.Fatalf("healthHint(%v) = %q, want an empty hint", tt.err, got)
				}
				return
			}
			if !messageContains(got, tt.wantHas) {
				t.Fatalf("healthHint(%v) = %q, want it to contain %q", tt.err, got, tt.wantHas)
			}
		})
	}
}

func TestHealthCheckMessage(t *testing.T) {
	t.Run("prefixes the hint and keeps the sanitized error", func(t *testing.T) {
		err := pgError("28P01", `password authentication failed for user "root"`)
		got := healthCheckMessage(err)
		if !messageContains(got, "Authentication failed") {
			t.Fatalf("message = %q, want an authentication hint", got)
		}
		// The SQLSTATE must survive: DBAs need it to diagnose the failure.
		if !messageContains(got, "SQLSTATE 28P01") {
			t.Fatalf("message = %q, want the SQLSTATE to be preserved", got)
		}
	})

	t.Run("strips credentials from the connection url", func(t *testing.T) {
		err := errors.New("failed to connect to postgresql://root:s3cret@kwdb:26257/defaultdb: connection refused")
		got := healthCheckMessage(err)
		if messageContains(got, "s3cret") {
			t.Fatalf("message = %q, leaked the password", got)
		}
		if !messageContains(got, "***@") {
			t.Fatalf("message = %q, want the userinfo to be masked", got)
		}
	})

	t.Run("hba rejection keeps the raw sqlstate", func(t *testing.T) {
		err := pgError("28000", "authentication rejected by configuration")
		got := healthCheckMessage(err)
		if !messageContains(got, "HBA") {
			t.Fatalf("message = %q, want an HBA hint", got)
		}
		if !messageContains(got, "SQLSTATE 28000") {
			t.Fatalf("message = %q, want the SQLSTATE to be preserved", got)
		}
	})

	t.Run("returns the sanitized message when there is no hint", func(t *testing.T) {
		got := healthCheckMessage(errors.New("plain failure"))
		if got != "plain failure" {
			t.Fatalf("message = %q, want %q", got, "plain failure")
		}
	})

	t.Run("nil error yields an empty message", func(t *testing.T) {
		if got := healthCheckMessage(nil); got != "" {
			t.Fatalf("message = %q, want an empty message", got)
		}
	})
}

// timeoutError is a net.Error whose Timeout() reports true.
type timeoutError struct{}

func (timeoutError) Error() string   { return "i/o timeout" }
func (timeoutError) Timeout() bool   { return true }
func (timeoutError) Temporary() bool { return true }

func messageContains(haystack, needle string) bool {
	return strings.Contains(strings.ToLower(haystack), strings.ToLower(needle))
}
