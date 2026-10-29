# Security Policy

## Supported versions

Security fixes are provided for the current 1.x line of the KWDB TSDB Grafana
data source.

| Version              | Supported                             |
| -------------------- | ------------------------------------- |
| 1.x (latest release) | Yes                                   |
| Earlier versions     | No; upgrade to the latest 1.x release |

## Reporting a vulnerability

Please report suspected vulnerabilities **privately** through GitHub Security
Advisories:

1. Open the repository's **Security** tab.
2. Select **Report a vulnerability**.
3. Provide the details in the private advisory form.

Direct link: <https://github.com/KWDB/kwdb-grafana-plugin/security/advisories/new>

Do **not** open a public issue, discussion, or pull request for a suspected
vulnerability, and do not disclose it publicly before a fix and disclosure plan
are agreed.

Helpful details include:

- Affected plugin version and deployment method (Docker Compose, Kubernetes,
  standalone Grafana, Grafana Cloud, or another environment).
- Grafana and KWDB versions.
- Steps to reproduce and the observed impact.
- Relevant logs or proof-of-concept code with secrets and identifying
  information removed.
- Whether the issue requires an authenticated user, a read-only database
  account, or a specific configuration.

## Sensitive data

Never submit real passwords, tokens, private keys, certificate files, internal
hostnames or IP addresses, customer data, or production connection strings.
Use placeholders and redact logs and screenshots. If a real credential may have
been exposed, rotate it immediately and mention the exposure in the report
without repeating the secret.

## Response expectations

Maintainers review reports as capacity allows. We aim to acknowledge a report,
assess its impact, prepare a fix, and coordinate disclosure with the reporter.
Response and remediation timelines depend on severity, complexity, and
maintainer availability; this project does not promise a specific SLA.

Please give us a reasonable opportunity to investigate and release a fix before
public disclosure. We will credit reporters in the advisory when requested.

## Scope

This policy covers the plugin source code, build and packaging configuration,
and documentation in this repository. Report vulnerabilities in Grafana itself
through Grafana Labs' security process, and vulnerabilities in KWDB through the
KWDB project's security process.
