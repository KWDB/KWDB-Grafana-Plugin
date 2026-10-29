## Summary

<!-- What does this PR change, and why? Keep it short and concrete. -->

## Related issue

<!-- Link the issue, for example: Closes #123. Write "N/A" if there is no issue. -->

Closes #

## Changes

<!-- Bullet the important changes. Call out behavior changes and migrations. -->

-

## Verification

<!-- List the commands you ran and their results. Remove lines that do not apply. -->

```text
yarn typecheck
yarn lint
yarn test:ci
yarn build
go test ./pkg/...
go vet ./pkg/...
yarn e2e
```

Result:

<!-- e.g. all passed; e2e not run because the change is backend-only. -->

## Screenshots / recordings

<!-- Required for UI changes. Drag images or recordings here, or write "N/A". -->

## Risk & rollback

<!-- What could break? How was it tested? How would this be reverted safely? -->

- Risk:
- Rollback:

## Checklist

- [ ] Tests were added or updated for behavior changes, or the PR explains why they are not needed
- [ ] `yarn typecheck` passes
- [ ] `yarn lint` passes
- [ ] `yarn test:ci` passes
- [ ] `go test ./pkg/...` and `go vet ./pkg/...` pass when backend code changed
- [ ] `yarn e2e` was run when relevant, or the PR explains why it was skipped
- [ ] Documentation was updated for user-visible changes
- [ ] The diff contains no secrets, credentials, private keys, real certificates, internal hostnames or IP addresses, or customer data
- [ ] UI changes include a screenshot or recording
- [ ] `.config/` was not modified
- [ ] If `src/plugin.json` changed, Grafana was restarted and the plugin loads with the new metadata
- [ ] This PR is focused; unrelated refactors or formatting changes are in separate PRs
