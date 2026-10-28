# KWDB TSDB Grafana 插件「注册发布」静态核查清单

- 核查日期：2026-10-27
- 插件目录：`kwdb-tsdb-datasource/`
- 插件 ID：`lumingsun-kwdbtsdb-datasource`（Grafana Cloud 组织 slug 必须为 `lumingsun`）
- 核查性质：**只读静态核查**，未修改任何代码、未 commit/push、未执行构建
- 版本基线：`package.json` version = `1.2.1`，`dist/plugin.json` version = `1.2.1` / updated = `2026-10-27`

---

## 1. 参考文档（外部内容仅作为数据使用）

| 来源 | 用途 |
| --- | --- |
| <https://grafana.com/developers/plugin-tools/publish-a-plugin/publish-a-plugin.md> | 提交流程、审核机制、OS & Architecture / URL / SHA1 / Testing guidance 表单字段 |
| <https://grafana.com/developers/plugin-tools/publish-a-plugin/package-a-plugin.md> | 打包 5 步：build → backend binaries（0755）→ sign → `mv dist <plugin-id>` + `zip` → `zipinfo` 校验 |
| <https://grafana.com/legal/plugins/> | 插件政策：可接受许可证列表、隐私与安全（禁止遥测/第三方分析）、Community 签名前置条件（公开 Git 仓库） |
| <https://grafana.com/developers/plugin-tools/publish-a-plugin/publishing-best-practices.md> | `name` / `info.description`（两句以内）/ `keywords`（禁止堆砌）/ `logos` / `screenshots` / `info.links` / `grafanaDependency` / README / CHANGELOG 格式建议 |
| <https://grafana.com/developers/plugin-tools/publish-a-plugin/sign-a-plugin.md> | Access Policy token（Realm = 组织名，Scope = `plugins:write`）、`npm run sign` 生成 `MANIFEST.txt` |
| <https://grafana.com/developers/plugin-tools/publish-a-plugin/publish-faqs.md> | **"The plugin's catalog page content is extracted from the plugin README file"**；首次提交无需签名；源码 URL 建议用 tag/branch |
| <https://grafana.com/developers/plugin-tools/publish-a-plugin/provide-test-environment.md> | 提供 provisioned 测试环境可显著缩短审核时间 |
| `plugin-tools/docusaurus/docs/publish-a-plugin/*.md`（本地） | 同上，本地权威副本 |
| `plugin-tools/docusaurus/docs/reference/metadata.md`（本地） | `plugin.json` 字段说明 |
| `grafana/docs/sources/developers/plugins/plugin.schema.json`（本地，Grafana 13.2.0-pre） | schema 校验基准（GitHub raw 在本环境不可达，改用本地同源副本） |

---

## 2. 结论表

图例：**PASS** = 满足要求；**WARN** = 不阻断提交，但建议修复；**FAIL** = 提交前必须处理。

| # | 核查项 | 结果 | 证据 | 需要人工做什么 |
| --- | --- | --- | --- | --- |
| 1 | `src/plugin.json` 通过官方 schema 校验 | **PASS** | `node` + `ajv@8.20.0`（仓库 `node_modules` 自带，无需 npx）对 `grafana/docs/sources/developers/plugins/plugin.schema.json`（draft-07）执行 `allErrors` 校验，`valid = true`，无任何 error。脚本：`/tmp/validate-plugin-json.js` | 无需处理 |
| 2 | `id` = `lumingsun-kwdbtsdb-datasource`，符合 schema pattern 且匹配组织 slug | **PASS** | schema pattern `^[0-9a-z]+\-([0-9a-z]+\-)?(app|panel|datasource)$`；id 前缀 `lumingsun` 与 Grafana Cloud 组织 slug `lumingsun` 一致（`sign-a-plugin.md`：token 必须由与插件 ID 前缀匹配的账号生成） | 提交时用 slug 为 `lumingsun` 的 Cloud 组织登录 |
| 3 | `type` / `name` | **PASS** | `"type": "datasource"`；`"name": "KWDB TSDB"`（简洁、可描述） | 无需处理 |
| 4 | `backend` / `executable` | **PASS** | `"backend": true`；`"executable": "gpx_kwdb_tsdb_datasource"`；`dist/` 下已产出 `gpx_kwdb_tsdb_datasource_{darwin_amd64,darwin_arm64,linux_amd64,linux_arm,linux_arm64,windows_amd64.exe}`，权限均为 `-rwxr-xr-x`（0755），符合 package-a-plugin 第 2 步要求 | 无需处理 |
| 5 | `metrics` / `alerting` / `annotations` | **PASS** | 三者均为 `true`；`alerting: true` 与 `backend: true` 同时声明（schema 要求 alerting 依赖 backend） | 无需处理 |
| 6 | `info.description` | **PASS** | 长度 141 字符，两句，说明功能与用途，符合 best-practices「两句以内」建议 | 无需处理 |
| 7 | `info.author` | **PASS** | `{"name": "Kaiwudb", "url": "https://www.kaiwudb.com"}` | 无需处理 |
| 8 | `info.keywords` | **PASS** | 6 个：`datasource`/`time series`/`TSDB`/`SQL`/`KWDB`/`KaiwuDB`，均与功能相关，无堆砌 | 无需处理 |
| 9 | `info.logos` | **PASS** | `small`/`large` 均指向 `img/logo.svg`（schema 要求必须是 SVG）；文件存在，1837 B，`xml.dom.minidom` 解析为合法 XML，`viewBox="-12 100 524 300"` | 无需处理 |
| 10 | `info.links` | **PASS** | 3 条：`GitHub` / `Documentation` / `Raise issue`。schema 说明 `documentation`、`raise issue` 为预定义特殊名，`grafana/pkg/plugins/manager/loader/loader_test.go:92-93` 中使用完全相同的 `Raise issue` / `Documentation` 大小写 | 无需处理 |
| 11 | `info.screenshots` 指向真实存在 | **PASS** | `img/screenshot-query-editor.png` 存在；Pillow 报告 `PNG`/`RGB`/`1440×900`/86,263 B（84.2 KB）。best-practices 仅要求「suitable resolution and file type, for example png, jpeg, or gif」，1440×900 PNG 满足 | 见 #12 |
| 12 | 截图数量/尺寸建议 | **WARN** | 仅声明 1 张截图。best-practices：`Use the screenshots field to provide an array with one or more screenshot images`，`Show your plugin in action, highlighting its standout features`（1 张是合规下限，但偏少）。仓库已有未使用的素材：`src/img/example.png`（3232×1528，474.8 KB）、`src/img/downsampling-example.png`（3268×2324，436.1 KB）、`src/img/save-test.png`（1874×1492，179.5 KB）、`src/img/kwdb-datasource.png`（1294×1158，123.6 KB） | 人工决定是否在 `src/plugin.json` 的 `info.screenshots` 中追加 2–4 张（建议：查询编辑器、降采样示例、Save & test、整体仪表板） |
| 13 | `info.version` / `info.updated` 为 `%VERSION%` / `%TODAY%` | **PASS** | schema pattern 明确允许 `%VERSION%` 与 `%TODAY%`；构建产物 `dist/plugin.json` 已正确替换为 `"version": "1.2.1"`、`"updated": "2026-10-27"` | 每次发布前重新 build，确保 `dist/plugin.json` 的 version 与 tag 一致 |
| 14 | `dependencies.grafanaDependency` | **PASS** | `">=13.1.0"`，符合 schema 的 semver range pattern；与 `README.md:35`「Grafana 13.1 or newer」、`README.md:41`「built and tested against 13.1.0」一致 | 与 #17 一并处理 |
| 15 | 打包后的 README 内容 | **WARN** | `.config/bundler/copyFiles.ts:13-15` 的注释与逻辑：`{ from: hasReadme() ? 'README.md' : '../README.md', to: '.', force: true }`。由于 `src/README.md` 存在，打进 ZIP 的是 **`src/README.md`（3,631 B）**，而不是根目录 `README.md`（13,335 B）。`diff -q dist/README.md src/README.md` → 完全相同。publish-faqs 明确「The plugin's catalog page content is extracted from the plugin README file」，因此目录页只会展示短版 README，丢失查询编辑器 5 种模式、Gapfill/Latest values/Window 细节、Alerting & annotations、Output formats、Read-only safety、Security recommendations、Troubleshooting 等章节 | 人工决策：① 把根 `README.md` 的完整内容搬进 `src/README.md`；或 ② 删除 `src/README.md` 让打包器回退到根 `README.md`；或 ③ 接受短版。**修改后必须重新 `npm run build` 并重新打包/算 SHA1** |
| 16 | README 安装/配置/功能说明完整性（根 README） | **PASS** | 根 `README.md`（359 行）含 Features、Quick Start、Requirements、Installation（catalog / grafana-cli / 手动 ZIP / docker compose）、Configuration 表格（11 个字段）、TLS/SSL、Save and test、Build a dashboard、Query editor 5 模式、Time macros、Alerting and annotations、Output formats、Read-only safety、Security recommendations、Troubleshooting（4 类问题）、Development and publishing、License | 与 #15 联动处理 |
| 17 | README 中 Grafana 最低版本自相矛盾 | **WARN** | `src/README.md:19` 写 `Grafana 12.3 or newer`，而 `plugin.json` 的 `grafanaDependency` 为 `>=13.1.0`，根 `README.md:35` 写 `Grafana 13.1 or newer`。同一仓库两个版本号，用户与审核方都会困惑 | 把 `src/README.md:19` 改为 `Grafana 13.1 or newer`（或按 #15 的方案统一 README 后一并修正） |
| 18 | `CHANGELOG.md` 含当前 version 条目 | **PASS** | `package.json` version = `1.2.1`；`CHANGELOG.md` 有 `## v1.2.1 (2026-10-22)` 条目 | 后续每次发版同步更新 |
| 19 | CHANGELOG 格式符合 Grafana 要求 | **PASS** | best-practices 5 条要求逐条比对：① 语义化版本 `v1.2.1` ✅；② 带日期 `(2026-10-22)` ✅；③ 按类型分组 `### Security` / `### Fixed` / `### Changed` ✅；④ 早期版本带 PR/Compare 链接 ✅；⑤ 无破坏性变更（1.2.x 内无 Breaking）✅。另外 `release.yml` 的 `awk` 会按 `## ` + 版本号抽取 release notes，`## v1.2.1 (2026-10-22)` 可被正确匹配 | 无需处理 |
| 20 | `LICENSE` 版权方与许可证 | **PASS** | 许可证为 Apache License 2.0（在 grafana.com/legal/plugins 的 AGPL 兼容许可列表内）；`LICENSE` 首行与附录均为 `Copyright (c) 2026 Kaiwudb`，版权方正确；`package.json` 的 `license` 字段亦为 `Apache-2.0` | 无需处理 |
| 21 | `DEVELOPMENT.md` | **PASS** | 含 Prerequisites（Node 22 / Go 1.26+ / Docker / Yarn 1.22.22）、Install-build-test 命令、后端验证命令、集成测试说明、本地 Grafana 环境、E2E 测试、跨平台后端二进制构建 | 无需处理 |
| 22 | `.gitignore` 合理性（`dist/` 忽略） | **PASS** | `.gitignore:33` 为 `dist/`；`git check-ignore -v dist/x` → `.gitignore:33:dist/`；`git ls-files dist` 为空；`artifacts/`、`node_modules/`、`/test-results/`、`/playwright-report/`、`/playwright/.cache/` 均已忽略 | 见 #23 |
| 23 | 仓库误提交密钥/密码/token/私钥 | **PASS** | 对 `git ls-files`（133 个文件）grep `password=`/`secret`/`token`/`BEGIN * PRIVATE KEY`/`grafana_token`/`glsa_`/`ghp_`/`AKIA…`/`api_key=` 等模式，命中 2 处，均为**文档/测试占位符**：`provisioning/datasources/datasources.yml:19` `password: '$KWDB_PASSWORD'`（Grafana provisioning 环境变量插值，非真实密钥）；`tests/configEditor.spec.tsx:84-86` `password: 's3cret'` / `secureJsonData: { password: 'old' }`（React Testing Library 测试 fixture）。工作区全量 grep（排除 node_modules/dist/.git）另命中 `.github/workflows/*.yml` 中的 `${{ secrets.GRAFANA_ACCESS_POLICY_TOKEN }}`、`${{ secrets.GH_PAT_TOKEN }}`、`${{ github.token }}`（均为 GitHub Actions secrets 引用，非字面量）与 `docs/api-dashboard-automation.md` 的 `Bearer <token>`、`"password": "your-password"`（文档示例占位符）。**未发现任何真实凭据、私钥或硬编码 token** | 无需处理（提交前如担心文档示例被扫，可在 docs 中统一改为 `<PASSWORD>` 形式） |
| 24 | `.DS_Store` 未被忽略 | **WARN** | `.gitignore` 无 `.DS_Store` 条目；`git status --porcelain` 显示 `?? .DS_Store` 与 `?? docs/api-dashboard-automation.md`。`git check-ignore -v .DS_Store` 无输出（未被忽略）。macOS 产生的 `.DS_Store` 有被误提交的风险（插件政策要求 ZIP 内不含隐藏文件，源码仓库中的 `.DS_Store` 也会污染 diff） | 在 `.gitignore` 增加 `.DS_Store`（及可选的 `*.tsbuildinfo`），并 `git rm --cached .DS_Store`（如已跟踪；当前未跟踪，只需加忽略规则）。**不要删除或修改工作区里已有的文件** |
| 25 | 前端网络外联行为 | **PASS** | `src/` 下 grep `fetch(`/`axios`/`XMLHttpRequest`/`WebSocket`/`EventSource`/`navigator.send` → **零命中**。前端仅通过 `DataSourceWithBackend`（`src/datasource.ts:2`）与 `this.getResource('/tables')`、`/columns?table=…`、`/tag-values?table=…&column=…`（`src/datasource.ts:19-28`）访问自身后端资源路由；URL 常量仅有文档链接与 `plugin.json` 中的官网/仓库地址 | 无需处理 |
| 26 | 后端网络外联行为 | **PASS** | `pkg/` 下 grep `http.Get`/`http.Post`/`http.NewRequest`/`net.Dial`/`url.Parse` 外的出站调用 → 零命中；`net/http` 仅出现在 `pkg/plugin/metadata.go:7`，用途是 `http.NewServeMux()` + `httpadapter.New(mux)` 注册 SDK 本地资源处理器（`/tables`、`/columns`、`/tag-values`），属于 Grafana 插件 SDK 内建机制。数据库连接经 `pgxpool.ParseConfig(buildConnString(...))`（`pkg/plugin/connection.go:46`）指向用户配置的 KWDB 主机 | 无需处理 |
| 27 | 是否违反 Grafana 插件隐私政策 | **PASS** | grafana.com/legal/plugins「Privacy and security」要求：禁止直接收集安装/用户统计、禁止向第三方发送分析数据、禁止嵌入跟踪代码。`src/`+`pkg/`+`tests/` grep `faro`/`telemetry`/`analytics`/`segment.io`/`sentry`/`mixpanel`/`amplitude`/`google-analytics` → 仅命中测试 fixture 中的表名 `equipment_telemetry`；`dist/module.js` 中 `faro` 命中数为 0；`src/` 中无 `console.*` 调用。**不存在任何第三方遥测/分析外联** | 无需处理 |
| 28 | `package.json` scripts 含发布相关命令 | **PASS** | `scripts` 含 `build`（webpack production）、`sign`（`sign-plugin`）、`dev`、`typecheck`、`lint`、`lint:fix`、`test`、`test:ci`、`e2e`、`server`。`@grafana/sign-plugin@^3.3.3` 已在 `devDependencies`。缺一个显式的 `validator` 脚本（`release.yml` 用 `npx --yes @grafana/plugin-validator@0.50.0` 直接调用）——非必需 | 可选：加 `"validator": "npx --yes @grafana/plugin-validator@latest -jsonOutput"` 之类的脚本便于本地执行 |
| 29 | `package.json` version 与 CHANGELOG 一致 | **PASS** | `package.json` `version` = `1.2.1`；`CHANGELOG.md` 最新条目 `## v1.2.1 (2026-10-22)`；`dist/plugin.json` `info.version` = `1.2.1`；git tag `v1.2.1` 已存在 | 无需处理 |
| 30 | 发布/CI 工作流完整性 | **PASS** | `release.yml`：tag `v*` 触发 → `npm run build` → `mage buildAll` → 条件 `npm run sign` → `mv dist <id>` + `zip -r` + `sha1sum`（提交表单要求的 SHA1）→ **`npx --yes @grafana/plugin-validator@0.50.0` 作为阻断门禁** → 抽取 CHANGELOG 生成 release notes → `gh release create`。`ci.yml`：typecheck/lint/unit test/build frontend/golangci-lint(含 gosec)/go test/govulncheck/`grafana/plugin-validator-cli -analyzer=metadatavalid`/多版本 Grafana Playwright e2e | 见 #31 |
| 31 | 签名所需的 Grafana Cloud Access Policy token | **WARN（需人工）** | `release.yml:60-62` 注释明示 Sign 步骤被 `if: ${{ env.GRAFANA_ACCESS_POLICY_TOKEN != '' }}` 跳过，"unsigned builds are still published"；仓库 secrets 中尚未配置 `GRAFANA_ACCESS_POLICY_TOKEN`。publish-faqs：「All plugins require signatures unless they are in development or being submitted to review for the first time.」首次提交可无签名，但**通过审核后的每次更新都必须签名** | 人工：在 Grafana Cloud（组织 `lumingsun`）→ My Account → Security → Access Policies 创建 Realm=`lumingsun`(all-stacks)、Scope=`plugins:write` 的 policy 并生成 token，添加到 GitHub 仓库 Secrets 的 `GRAFANA_ACCESS_POLICY_TOKEN`；然后手动触发一次带签名的 release |
| 32 | provisioned 测试环境 | **PASS** | `docker-compose.yaml` 启动 `kwdb/kwdb`（26257/8080）+ Grafana（默认 3001，可用 `GRAFANA_PORT` 覆盖），`scripts/init.sql` 种子 `demo_ts.sensors`；`provisioning/datasources/datasources.yml` 通过 `KWDB_HOST/KWDB_PORT/KWDB_DATABASE/KWDB_USER/KWDB_PASSWORD` 注册数据源；`provisioning/dashboards/kwdb-sensors.json` 为示例仪表板；`provisioning/README.md` 有说明。符合 provide-test-environment.md 要求，可缩短审核 | 提交表单勾选 "Provisioning provided for test environment" |
| 33 | 公开 Git 仓库（Community 签名前置条件） | **PASS** | `git remote -v` → `https://github.com/LumingSun/kwdb-tsdb-datasource.git`；已存在 tag `v1.0.0`–`v1.2.1`，默认分支 `master`。publish-faqs 建议源码 URL 使用 tag/branch 而非 HEAD | 提交时 Source code URL 用 `https://github.com/LumingSun/kwdb-tsdb-datasource/tree/v1.2.1` |
| 34 | `dist/` 是否为可提交的当前构建 | **PASS** | `dist/` 时间戳为 2026-10-27 14:02–15:00，`plugin.json` version `1.2.1` / updated `2026-10-27`，含 6 个平台二进制 + `module.js` + `img/`（logo.svg + screenshot-query-editor.png）+ `CHANGELOG.md` + `LICENSE` + `README.md`。`ls -a dist` 无隐藏文件。`dist/` 未被 git 跟踪 | 任何源码/README 修改后必须重新 build 再打包 |
| 35 | `plugin.json` `category` 字段 | **WARN（可选优化）** | schema 定义了 `category`（`tsdb`/`logging`/`cloud`/`tracing`/`profiling`/`sql`/`enterprise`/`iot`/`other`/自定义），用于 Grafana「Add new connection」页分类；当前 `src/plugin.json` 未声明 | 可选：增加 `"category": "tsdb"`（或 `"sql"`）以改善目录展示位置 |
| 36 | `query_help.md` / `docsPath` | **PASS（可选）** | `.config/bundler/copyFiles.ts:17` 已配置 `{ from: '**/query_help.md', to: '.', noErrorOnMissing: true }`，但 `src/` 下不存在该文件，`plugin.json` 也未设 `docsPath`。均为可选项，不影响 schema 校验 | 可选：为查询编辑器加 `src/components/query_help.md` 提升可用性 |

### 汇总

- **FAIL：0 项**
- **WARN：5 项**（#12 截图偏少、#15 打包 README 是短版、#17 Grafana 版本号矛盾、#24 `.DS_Store` 未忽略、#31 签名 token 未配置）
- **人工必须完成：** 见第 3 节

---

## 3. 发布前必须由人工完成的步骤

> 以下步骤均**未**在本次只读核查中执行，也不应由 agent 代做（涉及账号权限、密钥、提交与外部系统操作）。

### A. 提交前的内容修复（建议顺序）

1. **决定目录页 README**（#15/#17）
   - 方案 a：把根 `README.md` 的完整内容合并进 `src/README.md`（因为 `.config/bundler/copyFiles.ts` 在 `src/README.md` 存在时优先打包它）。
   - 方案 b：删除 `src/README.md`，让打包器回退到根 `README.md`。
   - 两种方案都要把 Grafana 最低版本统一为 `13.1 or newer`（与 `dependencies.grafanaDependency: ">=13.1.0"` 一致）。
2. **补充截图**（#12，可选）：在 `src/plugin.json` 的 `info.screenshots` 中追加 2–4 张，素材已在 `src/img/` 中。
3. **`.gitignore` 增加 `.DS_Store`**（#24）：`echo '.DS_Store' >> .gitignore`（如已有跟踪副本再 `git rm --cached`）。
4. **（可选）加 `category`**（#35）。
5. 修改完成后重新执行：

```bash
PATH=/Users/sunluming/.nvm/versions/node/v22.18.0/bin:$PATH yarn install --frozen-lockfile
yarn typecheck && yarn lint && yarn test:ci
yarn build
mage -v buildAll        # 或：CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -o dist/gpx_kwdb_tsdb_datasource_linux_arm64 -tags arrow_json_stdlib -ldflags '-w -s' ./pkg
```

### B. 本地自检（提交前）

6. **本地跑 plugin-validator**（本次因网络受限未执行）：

```bash
PLUGIN_ID=$(python3 -c "import json;print(json.load(open('src/plugin.json'))['id'])")
cp -r dist "${PLUGIN_ID}"
zip -qr "${PLUGIN_ID}.zip" "${PLUGIN_ID}"
rm -rf "${PLUGIN_ID}"
npx --yes @grafana/plugin-validator@latest -jsonOutput "${PLUGIN_ID}.zip"
```

逐条阅读 JSON 输出中的 error/warning 并修复；完成后删除该 zip。

7. **校验打包结构**（package-a-plugin.md 第 5 步）：`zipinfo <archive>.zip`，确认目录名为插件 ID、二进制为 `0755`、含 `plugin.json`/`README.md`/`CHANGELOG.md`/`LICENSE`/`MANIFEST.txt`（签名后）/`img/`/`module.js`。

### C. 签名与凭据（需人工操作 Grafana Cloud + GitHub）

8. 用 **Grafana Cloud 组织 slug 为 `lumingsun`** 的管理员账号登录 <https://grafana.com/auth/sign-in>。
9. My Account → Security → Access Policies → Create access policy：**Realm = `lumingsun` (all-stacks)**，**Scope = `plugins:write`** → Create token。
10. 把 token 写入 GitHub 仓库 `LumingSun/kwdb-tsdb-datasource` 的 Secrets，名称 `GRAFANA_ACCESS_POLICY_TOKEN`（`release.yml:26` 读取的就是这个名字）。
11. 推送版本 tag 触发 release：`git tag v1.2.1 && git push origin v1.2.1`（tag 已存在时改为推送新 tag）。工作流会自动 build → buildAll → `npm run sign`（生成 `MANIFEST.txt`）→ 打包 → `sha1sum` → **plugin-validator 阻断门禁** → 创建 GitHub Release。

### D. Grafana 侧提交表单（需人工填写）

12. 登录 Cloud → Org Settings → **My Plugins** → **Submit New Plugin**。
13. 表单字段：
    - **OS & Architecture**：本插件单个 ZIP 内含 6 个平台二进制 → 选 **Single**（官方对 clickhouse 插件的打包示例即多架构合一包）。
    - **URL**：指向 GitHub Release 资产 `<plugin-id>-<version>.zip` 的直链。
    - **Source code URL**：`https://github.com/LumingSun/kwdb-tsdb-datasource/tree/v1.2.1`（用 tag，不要用 HEAD）。
    - **SHA1**：`sha1sum <archive>.zip` 的输出（`release.yml` 已生成 `<archive>.zip.sha1`）。
    - **Testing guidance**：从根 `README.md` 提炼安装/配置/使用说明（必须写清 KWDB 端口 `26257`、`sslmode`、需要只读账号）。
    - **Provisioning provided for test environment**：**勾选**（仓库已有 `docker-compose.yaml` + `provisioning/`）。
    - 其余问题按实际情况回答签名等级相关问题（本插件依赖技术为开源 KWDB，且由 Kaiwudb（商业实体）发布，签名等级需与 Grafana 团队确认 Community 还是 Commercial）。
14. 点击 **Submit**，等待自动化校验 → 人工审核（代码审查 + 安装测试）。

### E. 提交后

15. 审核通过后 Grafana 会分配签名等级；之后每次发版都由 Release 工作流签名（token 已在 Secrets 中）。
16. 目录页内容来自 ZIP 内的 README，更新文档需随新版本一起提交。

---

## 4. 附：本次核查执行的只读命令

```bash
# 目录与文件
ls -la src/ src/img/ dist/ .github/workflows/
git ls-files | wc -l
git status --porcelain
git ls-files dist            # 空
git check-ignore -v dist/x node_modules/x .DS_Store playwright-report/x
git ls-files -z | xargs -0 du -k | sort -rn | head -15
git remote -v ; git tag

# schema 校验（ajv 来自仓库 node_modules，无需 npx）
node /tmp/validate-plugin-json.js

# 图片
python3 + Pillow：src/img/*.png 尺寸/格式/字节数；xml.dom.minidom 解析 src/img/logo.svg

# 文档
read README.md src/README.md DEVELOPMENT.md CHANGELOG.md LICENSE .gitignore package.json
read .config/bundler/copyFiles.ts .github/workflows/release.yml .github/workflows/ci.yml
read docker-compose.yaml provisioning/README.md provisioning/datasources/datasources.yml

# 网络外联
grep -rn -E "fetch\(|axios|XMLHttpRequest|WebSocket|EventSource|navigator\.send" src/
grep -rn -E "http\.Get|http\.Post|http\.NewRequest|net/Dial" pkg/
grep -rn -i -E "faro|telemetry|analytics|segment\.io|sentry|mixpanel|amplitude|google-analytics" src/ pkg/ tests/
grep -c -i faro dist/module.js

# 密钥扫描
git ls-files -z | xargs -0 grep -n -I -i -E "password[[:space:]]*[:=]...|BEGIN [A-Z ]*PRIVATE KEY|grafana_token|glsa_|ghp_|AKIA[0-9A-Z]{16}|secret...|api[_-]?key...|token..."
grep -rn -I -i -E "password|secret|token|private key|credential" --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist .
```

---

## 5. 备注

- 本文件为本次静态核查的唯一新增产物；`docs/quality-review-2026-10-22.md`、`docs/api-dashboard-automation.md` 与 `docs/superpowers/` 未做任何修改。
- `docs/api-dashboard-automation.md` 当前处于未跟踪状态（`?? docs/api-dashboard-automation.md`），与本次发布核查无关，提交时按需决定是否入库。
- GitHub raw / github.com 在本环境不可达（`getaddrinfo ENOTFOUND github.com`、`curl: (35)`），故 `plugin.schema.json` 使用本地 `grafana/docs/sources/developers/plugins/plugin.schema.json`（Grafana 13.2.0-pre，与官方 main 同源结构）；plugin-validator 的 README 亦无法在线获取，validator 相关结论依据 `plugin-tools/docusaurus/docs/publish-a-plugin/publishing-best-practices.md` 与本地 `.config/AGENTS/skills/validate-plugin.md`。
