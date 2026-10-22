package plugin

import (
	"regexp"
	"strings"
)

// credentialURLRe matches the userinfo part of a connection URL so error
// messages never echo a password back to the browser.
var credentialURLRe = regexp.MustCompile(`(?i)(postgres(?:ql)?://)[^@\s]*@`)

// sanitizeError renders an error for a Grafana response or health check while
// stripping credentials from connection URLs.
func sanitizeError(err error) string {
	if err == nil {
		return ""
	}
	return sanitizeMessage(err.Error())
}

// sanitizeMessage strips credentials and trailing whitespace from a message.
func sanitizeMessage(msg string) string {
	msg = credentialURLRe.ReplaceAllString(msg, "$1***@")
	return strings.TrimSpace(msg)
}
