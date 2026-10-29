package models

import (
	"strings"
	"testing"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
)

func settingsWith(patch func(*DataSourceSettings)) *DataSourceSettings {
	s := &DataSourceSettings{
		Host:            "localhost",
		Port:            26257,
		Database:        "defaultdb",
		User:            "root",
		SSLMode:         "disable",
		MaxConns:        8,
		MaxConnLifetime: 3600,
		MaxConnIdleTime: 900,
		ConnectTimeout:  5,
	}
	if patch != nil {
		patch(s)
	}
	return s
}

func TestValidate(t *testing.T) {
	tests := []struct {
		name     string
		patch    func(*DataSourceSettings)
		wantErr  bool
		errMatch string
	}{
		{name: "defaults are valid", patch: nil},
		{name: "empty settings are valid (defaults are applied later)", patch: func(s *DataSourceSettings) { *s = DataSourceSettings{} }},
		{name: "empty ssl mode is accepted", patch: func(s *DataSourceSettings) { s.SSLMode = "" }},
		{name: "require is valid", patch: func(s *DataSourceSettings) { s.SSLMode = "require" }},
		{name: "verify-ca is valid", patch: func(s *DataSourceSettings) { s.SSLMode = "verify-ca" }},
		{name: "verify-full is valid", patch: func(s *DataSourceSettings) { s.SSLMode = "verify-full" }},

		// Validate runs before applyDefaults, so zero means "not configured"
		// and is legal; only non-zero out-of-range ports are rejected.
		{name: "port zero means unset", patch: func(s *DataSourceSettings) { s.Port = 0 }},
		{name: "port negative", patch: func(s *DataSourceSettings) { s.Port = -1 }, wantErr: true, errMatch: "port must be between 1 and 65535"},
		{name: "port too large", patch: func(s *DataSourceSettings) { s.Port = 65536 }, wantErr: true, errMatch: "port must be between 1 and 65535"},

		{name: "sslmode allow is rejected", patch: func(s *DataSourceSettings) { s.SSLMode = "allow" }, wantErr: true, errMatch: "unsupported sslMode"},
		{name: "sslmode prefer is rejected", patch: func(s *DataSourceSettings) { s.SSLMode = "prefer" }, wantErr: true, errMatch: "unsupported sslMode"},
		{name: "sslmode typo is rejected", patch: func(s *DataSourceSettings) { s.SSLMode = "verify-full " }, wantErr: true, errMatch: "unsupported sslMode"},

		// Pool options: zero = use the default, negative is always invalid.
		{name: "maxConns zero means default", patch: func(s *DataSourceSettings) { s.MaxConns = 0 }},
		{name: "maxConns negative is rejected", patch: func(s *DataSourceSettings) { s.MaxConns = -1 }, wantErr: true, errMatch: "maxConns must not be negative"},
		{name: "maxConnLifetime zero means default", patch: func(s *DataSourceSettings) { s.MaxConnLifetime = 0 }},
		{name: "maxConnLifetime negative is rejected", patch: func(s *DataSourceSettings) { s.MaxConnLifetime = -1 }, wantErr: true, errMatch: "maxConnLifetime must not be negative"},
		{name: "maxConnIdleTime zero means default", patch: func(s *DataSourceSettings) { s.MaxConnIdleTime = 0 }},
		{name: "maxConnIdleTime negative is rejected", patch: func(s *DataSourceSettings) { s.MaxConnIdleTime = -1 }, wantErr: true, errMatch: "maxConnIdleTime must not be negative"},
		{name: "connectTimeout zero means default", patch: func(s *DataSourceSettings) { s.ConnectTimeout = 0 }},
		{name: "connectTimeout negative is rejected", patch: func(s *DataSourceSettings) { s.ConnectTimeout = -1 }, wantErr: true, errMatch: "connectTimeout must not be negative"},

		// Zero and negative query timeout / max rows are meaningful ("use the
		// default" and "disable the limit") and must not be rejected.
		{name: "query timeout zero is valid", patch: func(s *DataSourceSettings) { s.QueryTimeout = 0 }},
		{name: "query timeout negative disables the timeout", patch: func(s *DataSourceSettings) { s.QueryTimeout = -1 }},
		{name: "max rows zero is valid", patch: func(s *DataSourceSettings) { s.MaxRows = 0 }},
		{name: "max rows negative disables the cap", patch: func(s *DataSourceSettings) { s.MaxRows = -1 }},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := settingsWith(tt.patch).Validate()
			if tt.wantErr {
				if err == nil {
					t.Fatalf("Validate() = nil, want an error containing %q", tt.errMatch)
				}
				if tt.errMatch != "" && !strings.Contains(err.Error(), tt.errMatch) {
					t.Fatalf("Validate() = %q, want it to contain %q", err.Error(), tt.errMatch)
				}
				return
			}
			if err != nil {
				t.Fatalf("Validate() = %v, want nil", err)
			}
		})
	}
}

func TestLoadSettings(t *testing.T) {
	source := backend.DataSourceInstanceSettings{
		JSONData:                []byte(`{"host":"kwdb.example","port":26257,"database":"tsdb","user":"reader","sslMode":"require","maxConns":4}`),
		DecryptedSecureJSONData: map[string]string{"password": "s3cret"},
	}

	settings, secrets, err := LoadSettings(source)
	if err != nil {
		t.Fatalf("LoadSettings() error = %v", err)
	}
	if settings.Host != "kwdb.example" || settings.Port != 26257 || settings.Database != "tsdb" || settings.User != "reader" {
		t.Fatalf("unexpected settings: %+v", settings)
	}
	if settings.SSLMode != "require" || settings.MaxConns != 4 {
		t.Fatalf("unexpected settings: %+v", settings)
	}
	if secrets.Password != "s3cret" {
		t.Fatalf("password = %q, want %q", secrets.Password, "s3cret")
	}
}

func TestLoadSettingsInvalidJSON(t *testing.T) {
	source := backend.DataSourceInstanceSettings{
		JSONData:                []byte(`{"port":`),
		DecryptedSecureJSONData: map[string]string{},
	}
	if _, _, err := LoadSettings(source); err == nil {
		t.Fatal("expected an error for malformed JSONData")
	}
}

func TestLoadSettingsEmpty(t *testing.T) {
	settings, secrets, err := LoadSettings(backend.DataSourceInstanceSettings{})
	if err != nil {
		t.Fatalf("LoadSettings() error = %v", err)
	}
	if settings.Port != 0 || settings.Host != "" {
		t.Fatalf("expected zero-value settings, got %+v", settings)
	}
	if secrets.Password != "" {
		t.Fatalf("expected an empty password, got %q", secrets.Password)
	}
}
