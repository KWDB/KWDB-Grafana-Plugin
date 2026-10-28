package models

import (
	"encoding/json"
	"fmt"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
)

// DataSourceSettings holds the non-secret KWDB connection options stored in jsonData.
type DataSourceSettings struct {
	Host        string `json:"host"`
	Port        int    `json:"port"`
	Database    string `json:"database"`
	User        string `json:"user"`
	SSLMode     string `json:"sslMode"`
	SSLRootCert string `json:"sslRootCert"`

	// Connection pool options; durations are expressed in seconds.
	MaxConns        int `json:"maxConns"`        // default 8
	MaxConnLifetime int `json:"maxConnLifetime"` // default 3600 (1h)
	MaxConnIdleTime int `json:"maxConnIdleTime"` // default 900 (15min)
	ConnectTimeout  int `json:"connectTimeout"`  // default 5

	// QueryTimeout is the per-statement timeout in seconds. It is enforced both
	// as the connection-level statement_timeout and as a query context
	// deadline. Zero selects the default (30s); a negative value disables it.
	QueryTimeout int `json:"queryTimeout"`
	// MaxRows caps the number of rows buffered into a single frame. Zero
	// selects the default (100,000); a negative value disables the cap.
	MaxRows int `json:"maxRows"`
}

// SecretDataSourceSettings holds the password from DecryptedSecureJSONData.
type SecretDataSourceSettings struct {
	Password string `json:"password"`
}

// LoadSettings reads jsonData and the decrypted password from a data source instance.
func LoadSettings(source backend.DataSourceInstanceSettings) (*DataSourceSettings, *SecretDataSourceSettings, error) {
	settings := DataSourceSettings{}
	if len(source.JSONData) > 0 {
		if err := json.Unmarshal(source.JSONData, &settings); err != nil {
			return nil, nil, fmt.Errorf("could not unmarshal DataSourceSettings json: %w", err)
		}
	}
	return &settings, &SecretDataSourceSettings{Password: source.DecryptedSecureJSONData["password"]}, nil
}

// Validate rejects connection settings that cannot produce a working pool. It
// runs after the defaults have been applied, so an empty SSLMode means
// "disable". Returning an error here surfaces a readable message in the data
// source configuration page instead of an opaque pgx parse failure.
func (s *DataSourceSettings) Validate() error {
	if s.Port < 1 || s.Port > 65535 {
		return fmt.Errorf("port must be between 1 and 65535, got %d", s.Port)
	}

	// Only the four modes the configuration page offers are accepted. pgx also
	// supports "allow" and "prefer", both of which silently fall back to a
	// plaintext connection when the server does not offer TLS - exactly what
	// this plugin refuses to do.
	switch s.SSLMode {
	case "", "disable", "require", "verify-ca", "verify-full":
	default:
		return fmt.Errorf("unsupported sslMode %q: expected one of disable, require, verify-ca, verify-full", s.SSLMode)
	}

	if s.MaxConns < 1 {
		return fmt.Errorf("maxConns must be at least 1, got %d", s.MaxConns)
	}
	if s.MaxConnLifetime < 0 {
		return fmt.Errorf("maxConnLifetime must not be negative, got %d", s.MaxConnLifetime)
	}
	if s.MaxConnIdleTime < 0 {
		return fmt.Errorf("maxConnIdleTime must not be negative, got %d", s.MaxConnIdleTime)
	}
	if s.ConnectTimeout < 0 {
		return fmt.Errorf("connectTimeout must not be negative, got %d", s.ConnectTimeout)
	}

	return nil
}
