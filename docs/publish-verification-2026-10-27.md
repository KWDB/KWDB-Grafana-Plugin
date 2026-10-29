# 发布前验证报告（2026-10-27）

本报告记录为「注册发布 Grafana 插件」所做的全部代码侧检测与验证，以及必须由人工完成的步骤。
结论：**代码侧无阻断项，可以提交审核**；剩余动作全部是 Grafana Cloud / GitHub 的人工操作，见第 4 节。

配套文档：

- [publish-readiness-2026-10-27.md](publish-readiness-2026-10-27.md)：36 项发布清单静态核查（FAIL 0 / WARN 5 / PASS 31）
- [signing-and-advisor-2026-10-27.md](signing-and-advisor-2026-10-27.md)：签名工具链实测与 Grafana Advisor 检查项对照

---

## 1. 本次改动（随 v1.2.2 一起发布）

| 文件 | 改动 | 原因 |
| --- | --- | --- |
| `src/README.md` | 由 3.6 KB 摘要扩写为 9.4 KB 完整用户文档 | 打包规则（`.config/bundler/copyFiles.ts`）在 `src/README.md` 存在时优先打包它，而 Grafana 目录页内容取自 ZIP 内 README；此前目录页只能看到删减版 |
| `src/plugin.json` | `screenshots` 1 → 5 张；`Raise issue` 改名 `Support`，新增 `License` 链接 | 目录页展示与 `requiredlinks` 检查 |
| `package.json` | `version` 1.2.1 → 1.2.2 | 上述改动进入发布产物 |
| `CHANGELOG.md` | 新增 v1.2.2 条目 | Grafana changelog 规范 |
| `.gitignore` | 增加 `.DS_Store` | 避免误提交 |

> 未改动 `src/README.md` 之外的功能代码；`pkg/`、`src/components/` 零改动，因此不影响查询行为。

---

## 2. 已执行的验证（均为真实执行，含退出码）

### 2.1 构建

| 命令 | 结果 |
| --- | --- |
| `yarn build`（webpack 5.112.2，Node v22.18.0） | exit 0；仅 2 条既有的 `asset size limit` warning（`example.png` 475 KiB、`downsampling-example.png` 436 KiB，属 README 引用的截图，不影响 bundle） |
| `mage -v buildAll` | exit 0；6 个平台二进制全部重建，ldflags 中 `version=1.2.2`、`pluginID=lumingsun-kwdbtsdb-datasource` |
| `file` 校验 | darwin_amd64 / darwin_arm64 = Mach-O（x86_64 / arm64）；linux_amd64 / linux_arm64 / linux_arm = ELF（x86-64 / aarch64 / ARM EABI5，静态链接、已 strip）；windows_amd64.exe = PE32+ |
| `dist/` 清单 | `module.js`(+map)、`plugin.json`(1.2.2 / updated 2026-10-27)、`img/`（logo.svg + 5 张截图）、`README.md`(9448 B)、`CHANGELOG.md`、`LICENSE`、`go_plugin_build_manifest` —— 无缺失 |

### 2.2 单元测试与静态检查

| 命令 | 结果 |
| --- | --- |
| `go test ./pkg/...` | ok（`pkg/plugin`，含 read-only 绕过/误报表、frame、宏、连接设置等用例） |
| `go vet ./pkg/...` | exit 0，无输出 |
| `yarn jest --ci` | 5 suites / **58 tests 全部通过** |
| `yarn typecheck`（`tsc --noEmit`） | exit 0 |
| `yarn lint`（eslint 10 配置） | **0 errors**，26 warnings（全部为既有告警，如 `src/module.ts` 的 `setVariableQueryEditor` deprecated） |

### 2.3 官方 plugin-validator

按 `release.yml` 同方式打包（`dist` → `lumingsun-kwdbtsdb-datasource-1.2.2.zip`，64,093,621 B）后运行：

| 版本 | 退出码 | 结果 |
| --- | --- | --- |
| `@grafana/plugin-validator@0.50.0`（CI 门禁版本） | **0** | 110 个 analyzer 事件全部 `failed:false`，0 error |
| `@grafana/plugin-validator@latest`（0.51.3） | **0** | 与 0.50.0 的 analyzer 集合与结论完全一致 |

关键 analyzer 逐个确认通过：`archive`、`metadataschema`、`metadatavalid`、`readme`、`screenshots`、`logos`、`requiredlinks`、`templatereadme`、`plugindocs`、`sourcecode`、`codediff`、`checksum`、`go-sec`、`govulncheck`、`osv-scanner`（go.mod 84 包 / yarn.lock 1110 包无漏洞）、`virusscan`、`signature`、`sdkusage`、`grafanadependency`、`version`。

唯一输出：

```
warning: unsigned plugin
detail: This is a new (unpublished) plugin. This is expected during the initial
        review process. Please allow the review to continue, and a member of our
        team will inform you when your plugin can be signed.
```

→ 首次提交预期行为，取得 signature level 后由 `npm run sign` 消除。

### 2.4 plugin.json schema 校验

用 Grafana 13.2 源码中的 `docs/sources/developers/plugins/plugin.schema.json`（draft-07）+ ajv 8.20 全字段校验：`valid = true`，零 error。`%VERSION%` / `%TODAY%` 是 schema 允许的构建期占位符，`dist/plugin.json` 已正确替换。

### 2.5 本地打包产物（供提交审核时填写 URL / SHA1）

`/private/tmp/kwdb-validate-122/lumingsun-kwdbtsdb-datasource-1.2.2.zip`：

- 大小 64,093,621 B，21 个条目（6 个后端二进制 + `module.js`/`.map` + `plugin.json` + `README.md` + `CHANGELOG.md` + `LICENSE` + `go_plugin_build_manifest` + `img/` 6 个文件）
- SHA1 `b40c5fbab4eddcfcefb70db3a1980bb50290d0c0`

> 正式提交时应使用 Release 工作流产出的 zip 与 `.sha1`（推 `v1.2.2` tag 后自动生成），此处仅作本地等价验证。

### 2.6 PR #34 的 CI

| Check | 结果 |
| --- | --- |
| Build, lint and unit tests | pass (1m50s) |
| compatibilitycheck | pass (1m24s) |
| compare | pass (4m41s) |
| e2e test grafana-enterprise@13.1.8 | pass (1m56s) |
| e2e test grafana-enterprise@13.2.4 | pass (2m04s) |
| e2e test grafana-enterprise@nightly | pass (2m00s) |


### 2.7 Grafana Advisor（在本地真实实例上运行）

本地 Grafana 13.1.0（docker compose，插件以 `dist` 挂载、`GF_PLUGINS_ALLOW_LOADING_UNSIGNED_PLUGINS` 放行）通过 API 触发了两类检查：

**`datasource` 检查**（`POST /apis/advisor.grafana.app/v0alpha1/namespaces/default/checks`，type=`datasource`）：

```
report.count = 2   report.failures = []
```

→ 两个 provisioned 的 KWDB TSDB 数据源的 `health-check`、`uid-validation`、`missing-plugin` 步骤**全部通过**。`/api/datasources/uid/kwdb-tsdb/health` 亦返回 `{"message":"Data source is working","status":"OK"}`（后端真实连到 KWDB db.example.com:26257 并执行 `SELECT 1`）。

**`plugin` 检查**（type=`plugin`，59 个插件）：失败项共 6 条，全部 `severity: low`，其中 5 条是 Grafana 自带 drilldown app 的 `update` 提示，与本插件无关；唯一与本插件相关的一条是：

```json
{"severity":"low","stepID":"unsigned","item":"KWDB TSDB","itemID":"lumingsun-kwdbtsdb-datasource"}
```

→ 与预期完全一致：** Advisor 侧无需改任何插件代码，唯一根治动作是完成签名与发布**。未签名只产生一条 low 级「Plugin signature check」提示，用户还可在 Advisor 设置中关闭该检查。

---

## 3. 签名工具链结论

- 本仓库固定 `@grafana/sign-plugin@^3.3.3`（installed 3.3.3，`engines.node >= 20`），`npm run sign` = `sign-plugin`。
- 实测 v3.3.3 在 Node 22 下可正常运行；不带 token 时在写 `MANIFEST.txt` **之前**退出并提示 `Missing GRAFANA_ACCESS_POLICY_TOKEN`（对 `dist/` 零写入）。
- v3 通过 `proxy-agent` 读取环境变量，支持本机的 SOCKS 代理；签名端点 `https://grafana.com/api`，与 v4 同一服务。
- `@grafana/sign-plugin@latest` = 4.0.0（2026-10-22 发布），`engines.node >= 24.5.0`（官方文档口径 24.15.0），**本机 Node 22 无法运行**；v4 只支持 `HTTPS_PROXY`（带 scheme）+ `NO_PROXY`（逗号分隔），不再支持 PAC/SOCKS/`ALL_PROXY`/`NODE_USE_ENV_PROXY`。
- `release.yml` 现状：job 级注入 `GRAFANA_ACCESS_POLICY_TOKEN`，签名步骤在打包之前（`MANIFEST.txt` 会自然进 zip），`if: token != ''` 跳过逻辑正确。**当前配置无需改动即可完成 community 签名**；若将来升级到 sign-plugin v4，需把签名步骤切到 Node 24（见 `signing-and-advisor-2026-10-27.md` 第 3 节 diff 建议）。

---

## 4. 必须人工完成的步骤

按顺序执行：

1. **创建 Grafana Cloud 账号并确认组织 slug 为 `lumingsun`。**
   插件 ID 前缀必须与组织一致（`lumingsun-kwdbtsdb-datasource` ✅），否则签名会报 `Field is required: rootUrls`。
2. **My Account > Security > Access Policies > Create access policy**
   - Realm：`lumingsun`（all-stacks）
   - Scope：`plugins:write`
   - Create token 并保存。
3. **提交审核**：Grafana Cloud → Org Settings → **My Plugins → Submit New Plugin**
   - OS & Architecture：**Single**（zip 内含 6 个平台二进制）
   - URL：Release zip 直链
   - Source code URL：`https://github.com/LumingSun/KWDB-Grafana-Plugin/tree/v1.2.2`
   - SHA1：`sha1sum` 输出（release 资产里的 `.sha1` 文件）
   - Testing guidance：安装/配置/使用说明
   - 勾选 **Provisioning provided for test environment**（仓库已提供 `docker-compose.yaml` + `provisioning/`）
4. **把 token 写入 GitHub 仓库 Secrets：`GRAFANA_ACCESS_POLICY_TOKEN`**（`release.yml` 已接好，审核通过后再推 tag，Release 工作流会自动签名并重新打包）。
5. **推 tag 触发发布**：`git tag v1.2.2 && git push origin v1.2.2`（tag 必须指向包含本次改动的 commit；tag 触发的工作流使用该 tag 指向 commit 里的 `release.yml`）。
6. 审核通过后由 Grafana 授予 signature level，此后每次更新都走同一流程（Submit Update → 推 tag → 自动签名发布）。

> 注意：tag `v1.2.1` 当前指向的是旧 commit，不是本次 1.2.2 的提交；发布 1.2.2 需要新建 tag。

---

## 5. 环境备注（非插件问题）

- `npx` 需 `npm_config_cache=/private/tmp/npm-cache`（本机 `~/.npm/_cacache` 有 root 文件会 EPERM）。
- `npx @grafana/plugin-validator` 的 wrapper 用裸 `https.get` 从 GitHub Releases 下载二进制，不读代理 env；本次已通过代理预置到 npx 缓存后成功运行，CI 不受影响。
- 本地 Grafana 容器通过 `../dist` 实时挂载插件；`src/plugin.json` 改动需要重启 Grafana 容器才在 UI 生效（本次仅新增截图与链接，不影响数据源功能）。
