package plugin

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"net"
	"strings"
	"syscall"

	"github.com/jackc/pgx/v5/pgconn"
)

// tlsErrorMarkers are substrings that identify a TLS handshake or certificate
// failure in a pgx error string. pgx does not expose a typed error for every
// TLS failure mode, so the message has to be inspected as well.
var tlsErrorMarkers = []string{"x509:", "tls:", "certificate", "handshake", "ssl is not enabled", "ssl negotiation"}

// healthHint translates a connection failure into a short, actionable prefix.
//
// The sanitized database error is always appended by the caller: DBAs need the
// SQLSTATE, and replacing the original message would make real problems harder
// to diagnose. The hint only answers "what should the user look at first?".
func healthHint(err error) string {
	if err == nil {
		return ""
	}

	if errors.Is(err, context.DeadlineExceeded) || errors.Is(err, context.Canceled) {
		return "Connection timed out - check the host, the port, and whether KWDB is reachable from the Grafana server."
	}

	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		switch pgErr.Code {
		case "28P01", "28000":
			return "Authentication failed - check the user and the password."
		case "3D000", "42704":
			return "The database does not exist on this KWDB instance - check the Database setting."
		case "42501":
			return "Permission denied - this user is not allowed to connect to the database."
		}
		// Class 08 is "connection exception": the server dropped or refused the
		// session rather than rejecting the statement.
		if strings.HasPrefix(pgErr.Code, "08") {
			return "The connection to KWDB was dropped - check the host, the port, and the network path between Grafana and KWDB."
		}
		return ""
	}

	if isTLSError(err) {
		return "TLS negotiation failed - check the SSL mode and, for verify-ca and verify-full, the CA certificate."
	}

	var netErr net.Error
	if errors.As(err, &netErr) && netErr.Timeout() {
		return "Connection timed out - check the host, the port, and whether KWDB is reachable from the Grafana server."
	}
	if errors.Is(err, syscall.ECONNREFUSED) || errors.Is(err, syscall.EHOSTUNREACH) || errors.Is(err, syscall.ENETUNREACH) {
		return "KWDB refused the connection - check the host and the port, and confirm the server is listening."
	}

	return ""
}

func isTLSError(err error) bool {
	var certErr *tls.CertificateVerificationError
	var unknownAuthority x509.UnknownAuthorityError
	var hostnameErr x509.HostnameError
	if errors.As(err, &certErr) || errors.As(err, &unknownAuthority) || errors.As(err, &hostnameErr) {
		return true
	}

	msg := strings.ToLower(err.Error())
	for _, marker := range tlsErrorMarkers {
		if strings.Contains(msg, marker) {
			return true
		}
	}
	return false
}

// healthCheckMessage renders a health check failure: a classification prefix
// when one is known, followed by the sanitized database error.
func healthCheckMessage(err error) string {
	message := sanitizeError(err)
	hint := healthHint(err)
	switch {
	case hint == "":
		return message
	case message == "":
		return hint
	default:
		return hint + " " + message
	}
}
