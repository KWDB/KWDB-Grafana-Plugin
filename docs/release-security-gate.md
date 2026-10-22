# Release security gate

The release workflow (`.github/workflows/release.yml`) used to delegate to
`grafana/plugin-actions/build-plugin`, which runs the full Grafana plugin
validator, including `osv-scanner` over the repository sources.

That gate currently fails on a single high severity advisory that cannot be
fixed from this repository, so the workflow now runs the checks explicitly:

| Check | Mode | Reason |
| --- | --- | --- |
| `plugin-validator -analyzer=metadatavalid` | **hard** | Keeps plugin metadata, archive layout and backend binary checks blocking |
| Full `plugin-validator` (osv-scanner, semgrep, gosec) | **advisory** | Reports findings in the workflow log without blocking the release |

## Known blocker

```
error: osv-scanner detected a high severity issue in package braces
detail: SEVERITY: HIGH in package braces, vulnerable to CVE-2026-93687
```

- `braces@3.0.3` is the newest published version and the advisory
  (GHSA-vfj7-8cjw-p6xm) lists **no fixed version**.
- The dependency chain is
  `eslint-webpack-plugin -> micromatch -> braces`. `eslint-webpack-plugin` is
  imported directly by the generated `.config/webpack/webpack.config.ts`,
  which is managed by `@grafana/create-plugin` and must not be edited by hand.
  Upgrading `eslint-webpack-plugin` to v6 does not remove the dependency.
- `braces` is build-time tooling only; it is not shipped inside the plugin
  archive (`dist` contains `module.js`, `plugin.json`, assets and the backend
  binaries).

High severity advisories that *were* fixable are pinned through `resolutions`
in `package.json` (`basic-ftp`, `fast-uri`, `js-yaml`, `source-map-js`), see PR
#30.

## Removing the workaround

Restore the full validator as a blocking step once `braces` publishes a fixed
release:

1. Bump the `braces` resolution to the fixed version and run
   `yarn install`, commit the lockfile.
2. Run the validator locally:

   ```bash
   npx @grafana/plugin-validator@0.50.0 -sourceCodeUri file://./ <archive>.zip
   ```

3. Make the advisory step blocking again (remove `continue-on-error`), or switch
   this workflow back to `grafana/plugin-actions/build-plugin`.

Tracking issue: #31.
