# KWDB TSDB 数据源插件：Grafana 插件签名与 Advisor 调研报告

- 日期：2026-10-27
- 整理：维护者
- 范围：**只读调研 + 本文件**。未修改任何仓库代码、未 commit/push、未往 `package.json` 新增依赖。
- 关联对象：`kwdb-tsdb-datasource`（插件 ID `lumingsun-kwdbtsdb-datasource`，type `datasource`，`backend: true`，`grafanaDependency: >=13.1.0`，版本 `1.2.1`）

---

## 1. 结论速览

| 议题 | 结论 | 需要人工做什么 |
| --- | --- | --- |
| 本机能否跑官方签名工具 | **不能**。`@grafana/sign-plugin@latest` = `4.0.0`，硬性要求 Node `>=24.5.0`；本机是 Node `v22.18.0`，直接退出码 1 | 装 Node 24（`nvm install 24`）或改在 CI 签名 |
| 本仓库当前依赖的签名版本 | `@grafana/sign-plugin@^3.3.3`（已安装 `3.3.3`，`engines.node: >=20`），`package.json` 的 `sign` script 是 `sign-plugin` | 是否升级到 v4 由 Lead 决定（升级需动 `package.json`/`yarn.lock`，本次未改） |
| 代理要求 | v4 起**只支持 HTTP/HTTPS 代理**：设 `HTTPS_PROXY`（带 `http://`/`https://` scheme）+ `NO_PROXY`（逗号分隔）。**不再支持** PAC、SOCKS、`ALL_PROXY`，也**不再需要** `NODE_USE_ENV_PROXY` | 本机签名时把 `all_proxy=socks5://127.0.0.1:7890` 换成 `HTTPS_PROXY=http://127.0.0.1:7890` |
| 公开插件能否直接签名 | **不能**。公开插件必须先提交审核、被 Grafana 团队授予 signature level，否则签名时报 `Field is required: rootUrls` | 去 grafana.com 提交插件审核（人工流程） |
| Access Policy token | Realm = 组织名（all-stacks，我们是 `lumingsun`），Scope = `plugins:write` | 在 Grafana Cloud **My Account > Security > Access Policies** 创建并存入 GitHub repo secret `GRAFANA_ACCESS_POLICY_TOKEN` |
| `release.yml` 是否需要改 | **如果升级 sign-plugin v4，就需要改**：`node-version: '22'` 必须变成 24（至少在签名步骤）。其余（token 注入、签名时机、MANIFEST.txt 进 zip）已经是对的 | 见第 5.2 节的具体 diff 建议（**未改动文件**） |
| MANIFEST.txt 会进发布 zip 吗 | **会**。`Sign plugin` 步骤在 `Package plugin` 之前，且打包是 `mv dist <id> && zip -r`，`dist/MANIFEST.txt` 自然被打进 zip | 无需改动 |
| Advisor 会报我们插件什么 | 主要一项：`plugin` check 的 `unsigned` step（未签名）。其次是 `datasource` check 的 `health-check`（取决于用户数据库连通性） | **无需改代码**；见第 6.3 节 |

---

## 2. 本次实际执行过的命令与读过的文件

### 2.1 执行过的命令（含原文输出要点）

```sh
# 1) 查看 npm 上最新版元数据（代理 + 独立 npm cache，规避本机 ~/.npm 权限问题）
export https_proxy=http://127.0.0.1:7890 http_proxy=http://127.0.0.1:7890 \
       all_proxy=socks5://127.0.0.1:7890 NODE_USE_ENV_PROXY=1 \
       npm_config_cache=/tmp/npm-cache-sign \
       PATH=<node-22-bin>:$PATH

npm view @grafana/sign-plugin@latest version engines dependencies --registry https://registry.npmjs.org/
# => version = '4.0.0'
# => engines = { node: '>=24.5.0' }
# => dependencies = { minimist: '1.2.8' }

npm view @grafana/sign-plugin dist-tags
# => { canary: '3.3.0-canary...', latest: '4.0.0' }

# 2) 不带 token 跑 v4（在空目录 /tmp/sign-help-test）
npx --yes @grafana/sign-plugin@latest --version
# => npm warn EBADENGINE Unsupported engine { package: '@grafana/sign-plugin@4.0.0',
#      required: { node: '>=24.5.0' }, current: { node: 'v22.18.0', npm: '10.9.3' } }
# => Node.js >=24.5.0 is required. Current: v22.18.0
# => [exit: 1]

npx --yes @grafana/sign-plugin@latest --help      # 同样结果（见 2.2 说明）

# 3) 绕过 Node 版本门直接 import v4 的 sign command，看 CLI 行为
node -e "import('.../dist/commands/sign.command.js').then(m=>m.sign({_:['sign']}))"
# =>  sign-plugin@4.0.0  Plugin directory not found.
#    Directory /private/tmp/sign-help-test/dist not found.
#    Make sure to build the plugin before attempting to sign it.
#    [exit: 1]

# 4) 跑本仓库已安装的 v3.3.3（不带 token），确认只读、不写文件
cd /Volumes/external/kwdb-grafana/kwdb-tsdb-datasource
npx --no-install @grafana/sign-plugin
# =>  sign-plugin@3.3.3  Signing plugin.
#     Plugin found in /Volumes/external/kwdb-grafana/kwdb-tsdb-datasource/dist
# =>  sign-plugin@3.3.3  Missing GRAFANA_ACCESS_POLICY_TOKEN.
#     You must create a GRAFANA_ACCESS_POLICY_TOKEN env variable to sign plugins.
#     [exit: 1]
# （跑完后确认 dist/MANIFEST.txt 仍不存在，未产生任何写入）

# 5) release.yml 里用到的 plugin-validator 在本沙箱的表现
npx --yes @grafana/plugin-validator@0.50.0 --help
# => Error: getaddrinfo ENOTFOUND github.com
#    Error: Failed to download https://github.com/grafana/plugin-validator/releases/download/...darwin_arm64.tar.gz
#    [exit: 1]   （原因见 5.3）
```

### 2.2 读过的文件

**本仓库（`kwdb-tsdb-datasource/`）**

- `package.json`（`sign` script、`@grafana/sign-plugin` 版本、`engines`）
- `yarn.lock`（`@grafana/sign-plugin@^3.3.3` → `3.3.3`，resolved 自 `registry.npmmirror.com`）
- `.nvmrc`（内容为 `22`）
- `.npmrc`（`ignore-scripts=true`）
- `.github/workflows/release.yml`（全文 121 行）
- `src/plugin.json`（插件 ID / `backend` / `grafanaDependency`）
- `dist/` 目录列表（确认无 `MANIFEST.txt`）
- `pkg/plugin/datasource.go`（`CheckHealth` 实现）
- `node_modules/@grafana/sign-plugin/package.json` + `dist/**`（v3.3.3 与 npx 下载的 v4.0.0）

**Grafana 13.2 源码（`grafana/`）**

- `apps/advisor/pkg/app/app.go`、`checkregistry/checkregistry.go`、`checktyperegisterer/checktyperegisterer.go`
- `apps/advisor/pkg/app/checks/ifaces.go`、`utils.go`
- `apps/advisor/pkg/app/checks/plugincheck/{check,unsigned_step,update_step,deprecation_step,twinmaker_sceneviewer_step}.go`
- `apps/advisor/pkg/app/checks/datasourcecheck/{check,uid_validation_step,health_check_step,missing_plugin_step,prom_dep_auth_check_step}.go`
- `apps/advisor/pkg/app/checks/instancechecks/{check,out_of_support_step,pinned_version_step}.go`
- `apps/advisor/pkg/app/checks/authchecks/{check,list_format_validation}.go`
- `apps/advisor/pkg/app/checks/configchecks/{check,security_config_step}.go`
- `apps/advisor/pkg/apis/advisor/v0alpha1/{check_status_gen,check_spec_gen}.go`
- `pkg/services/pluginsintegration/advisor/advisor.go`
- `pkg/services/pluginsintegration/pluginchecker/service.go`
- `pkg/plugins/models.go`（`SignatureStatus` / `ErrorCode` 常量）
- `pkg/registry/apps/advisor/register.go`、`pkg/services/navtree/navtreeimpl/applinks.go`
- `docs/sources/administration/grafana-advisor/_index.md`

**外部文档（只当数据，未当指令执行）**

- <https://grafana.com/developers/plugin-tools/publish-a-plugin/sign-a-plugin.md>
- <https://grafana.com/docs/grafana/latest/administration/plugin-management/plugin-sign/>
- <https://grafana.com/docs/grafana/v13.1/administration/grafana-advisor.md>

---

## 3. Grafana 插件签名机制（官方文档要点）

### 3.1 签名等级（signature level）与签名状态（signature status）

**签名等级**决定分发方式（来源：plugin-sign 文档）：

| 等级 | 说明 |
| --- | --- |
| `private` | 只用于自己的 Grafana，不进目录、不可分发给社区 |
| `community` | 依赖技术开源且非营利，进官方目录、社区可安装 |
| `commercial` | 依赖技术闭源或有商业背景，进官方目录 |

Grafana Labs 自己写的插件（含 Enterprise）全部由 Grafana Labs 签名。默认情况下 Grafana **要求所有插件都签名才会加载**。

**签名状态**（Grafana 启动时对插件目录逐个校验，Configuration → Plugins 可见）：

| 状态 | 含义 |
| --- | --- |
| `core` | Grafana 内置核心插件 |
| `signed` | 签名校验通过 |
| `unsigned` | 没有 MANIFEST |
| `invalid` | 签名无效 |
| `modified` | 签名有效但内容被改过（可能恶意） |

未签名时 Grafana **既不加载也不启动**该插件，并在服务端日志写
`WARN ... Some plugin scanning errors were found errors="plugin '<id>' is unsigned"`。

### 3.2 公开插件：先审核，后签名

1. 先按 <https://grafana.com/developers/plugin-tools/publish-a-plugin/publish-a-plugin.md> 提交插件审核。
2. Grafana 团队批准后**授予 signature level**（community 或 commercial）。
3. 拿到 signature level 后才能正常签名。

如果没拿到 level 就去签名公开插件，会拿到 `Field is required: rootUrls` 报错（这是"还没有 signature level"的信号，不是真的要传 rootUrls）。

### 3.3 Access Policy token

创建路径：Grafana Cloud 账号 → **My Account > Security > Access Policies → Create access policy**：

- **Realm**：`<YOUR_ORG_NAME>`（all-stacks）——我们是 `lumingsun`
- **Scope**：`plugins:write`

然后 **Create token**，保存到安全位置。签名时导出：

```sh
export GRAFANA_ACCESS_POLICY_TOKEN=<YOUR_ACCESS_POLICY_TOKEN>
```

补充约束（来自官方 troubleshooting）：

- token 必须由**与插件 ID 前缀一致**的 Grafana Cloud 账号产生。我们的插件 ID 是 `lumingsun-kwdbtsdb-datasource`，前缀 `lumingsun` 与 Cloud 组织 slug 一致（`AGENTS.md` 已记录该对应关系）。
- `GRAFANA_API_KEY` 仍被 v4 兼容但会打 deprecation 警告，应迁移到 Access Policy token。

### 3.4 签名命令与 `MANIFEST.txt`

公开插件（不需要 `--rootUrls`）：

```sh
npm run sign      # 或 yarn sign / pnpm run sign
```

私有插件（需要 `--rootUrls`，且必须与目标实例的 `root_url` 匹配）：

```sh
npm run sign -- --rootUrls https://example.com/grafana
```

v4 CLI 实际参数（读 `dist/commands/sign.command.js` + `dist/bin/run.js` 得出）：

| 参数 / 环境变量 | 作用 |
| --- | --- |
| `--distDir <dir>` | 要签名的目录，默认 `dist` |
| `--signatureType <type>` | 覆盖 manifest 里的 `signatureType` |
| `--rootUrls <a,b,c>` | 逗号分隔的 Grafana 根 URL 列表，逐个 `assertRootUrlIsValid` |
| `GRAFANA_ACCESS_POLICY_TOKEN` / `GRAFANA_API_KEY` | 签名 token（Bearer） |
| `GRAFANA_COM_URL` | 覆盖签名端点，默认 `https://grafana.com/api`，实际 POST 到 `/plugins/ci/sign` |

命令入口行为（v4 `dist/bin/run.js`）：用 `minimist` 解析，`argv._[0]` 命中 `sign`/`version` 两个子命令，**未命中时默认执行 `sign`**。所以：

- `--version` / `--help` **不是**帮助/版本开关，而是走默认的 `sign` 路径（这也解释了 2.1 中 `--version` 与 `--help` 输出完全一样）。
- 想只签名：直接 `npx @grafana/sign-plugin@latest` 或 `npx @grafana/sign-plugin@latest sign`。

`MANIFEST.txt` 结构（写在 `dist/` 下，两段式 PGP）：

```txt
-----BEGIN PGP SIGNED MESSAGE-----
Hash: SHA512

{
  "manifestVersion": "2.0.0",
  "signatureType": "community",
  "signedByOrg": "myorgid",
  "signedByOrgName": "My Org",
  "plugin": "myorgid-simple-panel",
  "version": "1.0.0",
  "time": 1602753404133,
  "keyId": "7e4d0c6a708866e7",
  "files": {
    "plugin.json": "13be5f...",
    "module.js": "b4b694...",
    "README.md": "2d9014..."
  }
}
-----BEGIN PGP SIGNATURE-----
Version: OpenPGP.js v4.10.1
Comment: https://openpgpjs.org

wqEEARMKAAYFAl+IE3wACgkQfk0ManCIZudpdwIHTCqjVzfm7DechTa7BTbd
...
=GdNq
-----END PGP SIGNATURE-----
```

v4 生成 manifest 的具体规则（`dist/utils/manifest.js`）：

- 从 `<distDir>/plugin.json` 读 `id` 与 `info.version` 作为 `plugin` / `version`。
- 递归遍历 `distDir` 下**所有文件**（跳过 `MANIFEST.txt` 自身），路径统一成 POSIX `/` 分隔符，值为 SHA256。
- 额外写入 `signPlugin: { version }`；如果能探测到 `@grafana/create-plugin` 版本，再写 `createPlugin: { version }`。
- 符号链接若解析到 `distDir` 之外会直接抛错（3.3.3 起的加固）。
- POST 到 `https://grafana.com/api/plugins/ci/sign`，`Authorization: Bearer <token>`，非 200 会把服务端返回的字段拼进错误信息。
- 已知坑：在 Windows 上签名可能产生无效 MANIFEST，需要把 `\\` 替换成 `/`。

### 3.5 sign-plugin v4 的破坏性变更（Node 与代理）

官方原文（sign-a-plugin.md "Breaking changes in v4"）：

> Starting with v4, `@grafana/sign-plugin` requires Node.js 24.15.0 or later. PAC files, SOCKS proxies, and the `ALL_PROXY` environment variable are no longer supported.

迁移要求：

- 升级到 Node.js 24.15.0+。
- PAC / SOCKS 配置换成直接的 HTTP 或 HTTPS 代理 URL。
- `ALL_PROXY` 不再被读取；**只设 `HTTP_PROXY` 不够**，HTTPS 签名请求要设 `HTTPS_PROXY`。
- 代理 URL 必须带 `http://` 或 `https://` scheme。
- `NO_PROXY` 用**逗号**分隔，不能用空格。
- **不需要**再设 `NODE_USE_ENV_PROXY`（v3 时代为了走 `proxy-agent` 才需要）。
- 小写 `https_proxy` / `no_proxy` 优先于大写形式。

底层实现变化：v3.3.3 依赖 `proxy-agent@8.0.1`；v4.0.0 **只依赖 `minimist`**，改用 `new https.Agent({ proxyEnv: process.env })`（Node 内置代理支持，见 `dist/utils/request.js`）。

---

## 4. 本机与本仓库工具链实测结论

### 4.1 现状

| 项 | 值 | 来源 |
| --- | --- | --- |
| npm `latest` | `4.0.0`（发布于 2026-10-22） | `npm view` |
| v4 `engines.node` | `>=24.5.0` | `npm view` + `node_modules/.../package.json` |
| v4 运行时硬门 | `major < 24 \|\| (major === 24 && minor < 5)` → `Node.js >=24.5.0 is required.` | `dist/bin/run.js` |
| 官方文档口径 | Node.js **24.15.0** 或更高（因为依赖 Node 24.15 的原生代理） | sign-a-plugin.md / CHANGELOG `use Node 24.15 native proxy (#3013)` |
| 本机 Node | `v22.18.0`（`<node-22-bin>/node`） | 实测 |
| 本仓库 devDependency | `@grafana/sign-plugin@^3.3.3` → 实际安装 `3.3.3`，`engines.node: >=20` | `package.json` / `yarn.lock` / `node_modules` |
| `package.json` `engines` | `node: >=22` | `package.json` |
| `.nvmrc` | `22` | `.nvmrc` |
| `dist/MANIFEST.txt` | **不存在 → 插件当前未签名** | `ls dist/` |

> **注意文档与实现的版本口径差异**：npm 元数据和运行时门都是 `>=24.5.0`，官方文档写 `>=24.15.0`。两者都高于 22，**结论不变**；为避免踩到"Node 24.5～24.14 能过门但原生代理行为不完整"的灰区，**建议按 24.15.0 准备环境**。

### 4.2 实测输出（原文要点）

v4 在 Node 22 下（`npx --yes @grafana/sign-plugin@latest --version` 与 `--help` 输出相同）：

```text
npm warn EBADENGINE Unsupported engine {
npm warn EBADENGINE   package: '@grafana/sign-plugin@4.0.0',
npm warn EBADENGINE   required: { node: '>=24.5.0' },
npm warn EBADENGINE   current: { node: 'v22.18.0', npm: '10.9.3' }
npm warn EBADENGINE }
Node.js >=24.5.0 is required. Current: v22.18.0
[exit: 1]
```

本仓库已安装的 v3.3.3，不带 token（在插件目录内跑，只读，未写任何文件）：

```text
 sign-plugin@3.3.3  Signing plugin.

Plugin found in /Volumes/external/kwdb-grafana/kwdb-tsdb-datasource/dist

 sign-plugin@3.3.3  Missing GRAFANA_ACCESS_POLICY_TOKEN.

You must create a GRAFANA_ACCESS_POLICY_TOKEN env variable to sign plugins.
[exit: 1]
```

这条输出同时确认了三件事：命令入口是 `sign-plugin`（无参数即默认 `sign`）、默认目录是 `dist`、缺 token 时**在写 MANIFEST 之前就退出**（所以不带 token 试跑是安全的）。

### 4.3 环境备注（本机 npm cache 权限）

首次 `npx` 直接失败：

```text
npm error code EPERM
npm error syscall mkdir
npm error path $HOME/.npm/_cacache
npm error Your cache folder contains root-owned files ...
```

规避方式（本次全部命令都用）：`npm_config_cache=/tmp/npm-cache-sign`。这是本机环境问题，不影响 CI，但**在本机手动签名时也需要同样处理**（或修 `~/.npm` 属主）。

### 4.4 Node 24 的获取方式

- 本机：`nvm install 24 && nvm use 24`（本机没有 Node 24，只有 22.18.0；Homebrew 那个 `node 25` 与 `.nvmrc` 要求的 22 也不是一回事）。
- CI：`actions/setup-node` 的 `node-version: '24'`，或用 `container: node:24` 的独立 job。
- 只要签名这一个步骤需要 24；前端 webpack 构建、mage 后端构建可以继续留在 Node 22（见 5.2 方案 A）。

### 4.5 两条可行路径

**路径 A（推荐，改动最小，不动 `package.json`）**：`release.yml` 里签名步骤单独切到 Node 24，并用 `npx --yes @grafana/sign-plugin@4.0.0` 调 v4。`package.json` / `yarn.lock` / `.nvmrc` 全部不动，前端/后端构建继续用 Node 22。本机手动签名则 `nvm use 24` 后 `npx @grafana/sign-plugin@latest`。

**路径 B（跟随官方最新）**：把 devDependency 升到 `^4.0.0`，`package.json` 的 `engines.node` 与 `.nvmrc` 改成 `24`，CI 全流程 Node 24。需要验证 webpack/mage/e2e 在 Node 24 下都正常，风险高于 A。

> 补充：停留在 `^3.3.3` 也能继续签名（v3 在 Node 22 下可跑，`proxy-agent` 也支持 SOCKS/`ALL_PROXY`）。但 v4 已是当前 major，官方文档的破坏性变更说明只覆盖 v4，长期看应迁移。

---

## 5. `release.yml` 审阅与建议改动（**未改动文件，仅建议**）

### 5.1 现状逐段

| 行 | 内容 | 评价 |
| --- | --- | --- |
| L25-26 | job 级 `env.GRAFANA_ACCESS_POLICY_TOKEN: ${{ secrets.GRAFANA_ACCESS_POLICY_TOKEN }}` | ✅ 正确，secret 名与官方一致 |
| L33-37 | `actions/setup-node@v6`，`node-version: '22'`，`cache: 'yarn'` | ⚠️ 若用 sign-plugin v4，这里不够 |
| L39-43 | `corepack enable` + `yarn install --frozen-lockfile` | ✅ |
| L45-46 | `npm run build`（前端） | ✅ |
| L48-52 | `actions/setup-go@v7`，`go-version-file: go.mod` | ✅ |
| L53-57 | `magefile/mage-action` `buildAll`（后端，多平台二进制） | ✅ |
| L59-63 | `Sign plugin`：`if: ${{ env.GRAFANA_ACCESS_POLICY_TOKEN != '' }}`，`run: npm run sign` | ⚠️ 条件写法正确（token 缺失时跳过、仍发布未签名包）；但 Node 版本与 CLI 版本需配合 |
| L65-81 | `Package plugin`：`mv dist "${PLUGIN_ID}"` + `zip -r "${ARCHIVE}" "${PLUGIN_ID}"` | ✅ **MANIFEST.txt 会被打进 zip**（签名写在 `dist/`，打包在整个目录上），且顺序正确（签名在前、打包在后） |
| L83-86 | `Validate plugin`：`npx --yes @grafana/plugin-validator@0.50.0 -sourceCodeUri file://./ <archive>` | ✅ 在打包之后，不改 `dist` |
| L88-121 | release notes + `gh release create` | ✅ |

关于私有/公开：`Sign plugin` 没有传 `--rootUrls`，这与"公开插件（community 签名）"的定位一致。**如果最终决定发私有签名**，这里必须加 `--rootUrls <实例 root_url>`。

### 5.2 建议 diff（方案 A：只把签名步骤切到 Node 24 + 显式 v4）

```diff
       - name: Build backend binaries
         uses: magefile/mage-action@a662bd8c29d8106879588cfff83b2faf6e6f59db # v4.0.0
         with:
           version: latest
           args: buildAll
 
+      # @grafana/sign-plugin v4 需要 Node >= 24.5.0（官方文档口径 24.15.0）。
+      # 只切换签名步骤的 Node 版本，前端/后端构建继续用 22。
+      - name: Setup Node.js for signing
+        uses: actions/setup-node@v6
+        with:
+          node-version: '24'
+
       - name: Sign plugin
         # Skipped until GRAFANA_ACCESS_POLICY_TOKEN is configured in the
         # repository secrets; unsigned builds are still published.
         if: ${{ env.GRAFANA_ACCESS_POLICY_TOKEN != '' }}
-        run: npm run sign
+        run: npx --yes @grafana/sign-plugin@4.0.0
```

要点说明：

1. `actions/setup-node` 可以在同一 job 里多次调用，后一次生效；`npm run sign` 走的 `node_modules/.bin/sign-plugin` shebang 是 `#!/usr/bin/env node`，会自动用上新 Node。
2. 用 `npx --yes @grafana/sign-plugin@4.0.0` 而不是改 `package.json`，是为了**不引入仓库依赖变更**（本次任务的硬约束）；代价是 CI 每次多一次 npm 下载。
3. 若将来走路径 B（升 devDependency），把最后一行改回 `npm run sign` 即可，并把 L33-37 的 `node-version` 一并改成 `'24'`。
4. GitHub Actions runner 直连 grafana.com，**不需要配代理**。若哪天换成公司内网自托管 runner，必须按 v4 口径设 `HTTPS_PROXY`（带 scheme）+ `NO_PROXY`（逗号分隔），**不要**再用 `ALL_PROXY` / SOCKS / `NODE_USE_ENV_PROXY`。
5. 如果改发私有签名：`run: npx --yes @grafana/sign-plugin@4.0.0 -- --rootUrls https://<你的 grafana root_url>`。

### 5.3 关于 `plugin-validator` 的备注（信息项，非阻塞）

本沙箱里 `npx --yes @grafana/plugin-validator@0.50.0 --help` 失败：

```text
Error: getaddrinfo ENOTFOUND github.com
Error: Failed to download https://github.com/grafana/plugin-validator/releases/download/plugin-validator/v0.50.0/plugin-validator_0.50.0_darwin_arm64.tar.gz
```

原因：该包的 `bin/index.js` 用裸 `https.get` 从 GitHub Releases 下载二进制，**不读任何代理环境变量**，所以本机代理帮不上忙。GitHub Actions 里直连 GitHub 没问题，**CI 不受影响**；仅记录为本机无法本地复跑 validator 的限制。

---

## 6. Grafana Advisor 调研

### 6.1 代码位置与启用条件

- 后端 app：`grafana/apps/advisor/pkg/app/`（`app.go`、`checkregistry/`、`checkscheduler/`、`checks/`）
- API kind：`advisor.grafana.app/v0alpha1` 的 `Check` / `CheckType`
- Grafana 侧注册：`pkg/registry/apps/advisor/register.go`，并在 `pkg/server/bootstrap/wire/wire_gen.go` 中作为 OSS 内置 app 安装（`grafana-advisor-app`）；左侧导航在 **Configuration → Advisor**（`pkg/services/navtree/navtreeimpl/applinks.go`）。
- 报告按 org namespace 存储；自托管按 org 维度，Cloud 按 stack 维度（`checks.GetNamespaces`）。
- 入口：管理员登录 → **Administration → Advisor → Generate report**，之后周期性自动跑。可以在 Advisor 设置里按 check 启停（`advisor.grafana.app/ignore-steps-list` 注解可忽略单个 step）。
- 官方文档（OSS/Cloud/Enterprise 均支持）：<https://grafana.com/docs/grafana/v13.1/administration/grafana-advisor.md>

### 6.2 检查项全量清单（5 个 check / 12 个 step）

注册表：`apps/advisor/pkg/app/checkregistry/checkregistry.go` → `datasourcecheck`、`plugincheck`、`authchecks`、`configchecks`、`instancechecks`。
严重度只有两档：`high`（Action needed）/ `low`（Investigation needed）。

#### A. check `datasource`（Name: "data source"）— item = 当前 org 的每个数据源

| Step ID | Title | 判定条件 | 严重度 |
| --- | --- | --- | --- |
| `uid-validation` | UID validation | `util.ValidateUID(ds.UID)` 失败（v11.2 起 UID 格式强制） | low |
| `health-check` | Health check | 仅对 `plugin.Backend == true` 的插件执行；插件缺失或纯前端插件、或 `oauthPassThru` 开启则跳过；调 `CheckHealth`，出错或 `Status != OK` 即失败（`ErrMethodNotImplemented` / `ErrPluginUnavailable` / `ErrPluginNotRegistered` 会被跳过，交给 missing-plugin）。moreInfo 带 `Status/Message/JSONDetails` | high |
| `missing-plugin` | Missing plugin check | `PluginStore.Plugin(ds.Type)` 不存在（数据源在、插件没装） | high |
| `prom-dep-auth` | Prometheus deprecated authentication check | 仅 `ds.Type == "prometheus"` 且用了 `sigV4Auth` / `azureCredentials` | high |

#### B. check `plugin`（Name: "plugin"）— item = plugin store 里所有插件 **+** 有加载错误的插件

| Step ID | Title | 判定条件 | 严重度 |
| --- | --- | --- | --- |
| `deprecation` | Deprecation check | `updateChecker.IsUpdatable` 为真（非 core/managed/pinned/provisioned）**且** grafana.com 目录里该插件 `status == "deprecated"` | high |
| `update` | Update check | 同上 `IsUpdatable` **且** 目录里存在更新的版本 | low |
| `unsigned` | Plugin signature check | ① 插件已加载（dev 模式或在未签名白名单里）且 `Signature ∈ {unsigned, modified, invalid}` → low；② 插件有加载错误且 `ErrorCode ∈ {signatureMissing, signatureInvalid, signatureModified}` → high | low / high |
| `twinmaker_sceneviewer` | TwinMaker SceneViewer deprecation check | 仅插件 ID == `grafana-iot-twinmaker-app` | low |

> `IsUpdatable`（`pkg/services/pluginsintegration/pluginchecker/service.go`）会跳过：core 插件、managed 插件、被 pin 版本的预装插件、**provisioning 安装的插件**。也就是说用 provisioning 装我们插件的用户不会收到 update/deprecation 提示。
>
> `pluginIndex` 来自 grafana.com 插件目录（`GetPluginsInfo`，`IncludeDeprecated: true`）。**目录里没有我们插件时，`update` / `deprecation` 直接 return nil，不会误报。**

#### C. check `ssosetting`（Name: "SSO setting"）

| Step ID | Title | 判定条件 | 严重度 |
| --- | --- | --- | --- |
| `sso-list-format-validation` | SSO List Setting Format Validation | `allowed_domains` / `allowed_groups` / `allowed_organizations` / `role_values_*` 不是字符串或无法按分隔符拆分 | high |

#### D. check `config`（Name: "config setting"）

| Step ID | Title | 判定条件 | 严重度 |
| --- | --- | --- | --- |
| `security_config` | Security config check | `security.secret_key` 仍是默认值 `SW2YcwTIb9zpOOhoPsMm` | high |

#### E. check `instance`（Name: "instance attribute"）

| Step ID | Title | 判定条件 | 严重度 |
| --- | --- | --- | --- |
| `out_of_support_version`（自托管） | Grafana version check | 构建时间超过 9/15 个月支持窗口（Cloud 不跑这项） | high |
| `pinned_version`（Cloud） | Grafana Cloud version check | `BuildBranch != "HEAD"`，即版本被 pin | low |

### 6.3 我们的插件可能触发哪些项

插件画像：`type: datasource`、`backend: true`、`executable: gpx_kwdb_tsdb_datasource`、`grafanaDependency: >=13.1.0`、**当前未签名**、尚未在 grafana.com 目录发布。

| Advisor 项 | 我们会不会触发 | 归属 | 说明 |
| --- | --- | --- | --- |
| `plugin` / `unsigned`（低危分支） | **会**，只要用户允许加载未签名插件 | **插件作者** | 用户在 `allow_loading_unsigned_plugins` 或 dev 模式下装我们的 zip，插件能加载，`Signature == "unsigned"` → Advisor 在 "Investigation needed" 报一条 "Plugin signature check / KWDB TSDB / lumingsun-kwdbtsdb-datasource"。**唯一根治办法是签名并发布**（或引导用户装签名版）。 |
| `plugin` / `unsigned`（高危分支） | **会**，如果用户没开未签名白名单 | 用户环境 | 插件根本不加载，`pluginErrorResolver` 报 `signatureMissing` → "Action needed" 里出现。此时插件本就不可用，报出来是合理的。 |
| `plugin` / `unsigned`（modified） | 可能 | **发布流程** | 签名后任何文件被改（重新 zip、替换二进制、CRLF 等）都会变 `modified`。所以**签名必须放在所有产物就绪之后、打包之前**——现有 release.yml 的顺序已经满足。 |
| `plugin` / `update` | **发布前不会**；发布后会 | 插件作者（发版节奏） | 未进目录时 `pluginIndex` 查不到，直接跳过。发布后会提示"有新版本"，属正常运营项。 |
| `plugin` / `deprecation` | 不会（除非 Grafana 团队主动标记） | Grafana 团队 | 与我们无关。 |
| `plugin` / `twinmaker_sceneviewer` | 不会 | — | 只针对 `grafana-iot-twinmaker-app`。 |
| `datasource` / `health-check` | **可能**，取决于用户的 KWDB 连通性 | 共担（后端信息质量 = 插件作者） | 我们 `backend: true`，所以 Advisor 会对每个用我们插件建的数据源实跑 `CheckHealth`。连不上/密码错/超时 → high，moreInfo 直接展示 `Status/Message/JSONDetails`。我们的实现（`pkg/plugin/datasource.go:130`）失败时返回 `HealthStatusError` + `sanitizeError(err)` 的可读 message，OK 时返回 "Data source is working"，**已经满足 Advisor 的展示需求**。 |
| `datasource` / `missing-plugin` | 可能（用户删了插件但留着数据源） | 用户环境 | 安装文档写清楚即可。 |
| `datasource` / `uid-validation` | 基本不会 | 用户环境 | 我们的 provisioning UID 是 `kwdb-tsdb`，合法。 |
| `datasource` / `prom-dep-auth` | 不会 | — | 只针对 `prometheus`。 |
| `ssosetting` / `config` / `instance` | 不会 | 实例管理员 | 与插件完全无关。 |

### 6.4 结论：Advisor 侧要不要改代码

**不需要改任何代码。** 具体依据：

1. Advisor 没有任何针对"未发布/第三方插件"的硬性失败项；真正需要处理的是**签名**（第 3、4、5 节），而不是改插件行为。
2. `health-check` 是唯一与我们后端行为耦合的项，而我们的 `CheckHealth` 已经返回结构化、可读的 `Message`，Advisor 会原样展示，无需额外适配。
3. `grafanaDependency: >=13.1.0` 不会触发任何 Advisor 项（Advisor 不检查插件依赖的 Grafana 版本范围，只检查 Grafana 实例自身的版本支持周期）。

可选的非阻塞改进（供 Lead 判断，本次未实施）：

- 在 `README.md` / 发布说明里写明"未签名安装需要 `allow_loading_unsigned_plugins`，Advisor 会提示 Plugin signature check"，减少用户困惑。
- 发布到 grafana.com 目录后，`update` 项会随版本迭代出现，属正常运营节奏，无需处理。

---

## 7. 待人工处理清单

| # | 事项 | Owner | 阻塞等级 |
| --- | --- | --- | --- |
| 1 | 在 Grafana Cloud（org `lumingsun`）创建 Access Policy：Realm `lumingsun`（all-stacks）、Scope `plugins:write`，生成 token | 人工 | 签名前置 |
| 2 | 按 <https://grafana.com/developers/plugin-tools/publish-a-plugin/publish-a-plugin.md> 提交插件审核，拿到 community/commercial signature level | 人工 | 公开签名前置 |
| 3 | 把 token 写入 GitHub repo secret `GRAFANA_ACCESS_POLICY_TOKEN`（release.yml L26 已接好） | 人工 |  CI 签名前置 |
| 4 | 决定签名路径 A / B，并按 5.2 的 diff 修改 `.github/workflows/release.yml`（**本次未改**） | Lead | 若用 v4 则必须 |
| 5 | 本机手动签名时：`nvm install 24 && nvm use 24`，`npm_config_cache` 指到可写目录，代理用 `HTTPS_PROXY=http://127.0.0.1:7890` + `NO_PROXY=localhost,127.0.0.1`（**不要**用 `all_proxy` socks5 / `NODE_USE_ENV_PROXY`） | 人工 | 本机签名前置 |
| 6 | 打 tag 前确认：签名步骤在打包之前、`dist/MANIFEST.txt` 生成成功、zip 内含 `MANIFEST.txt`（可 `unzip -l <archive> \| grep MANIFEST`） | Lead | 发布前检查 |
| 7 | 若最终发私有签名：`Sign plugin` 加 `--rootUrls <root_url>` | Lead | 仅私有签名 |

---

## 8. 参考链接

- 签名插件（plugin-tools）：<https://grafana.com/developers/plugin-tools/publish-a-plugin/sign-a-plugin.md>
- 插件签名（Grafana 管理文档）：<https://grafana.com/docs/grafana/latest/administration/plugin-management/plugin-sign/>
- 插件分类与政策：<https://grafana.com/legal/plugins/>
- 发布插件（提交流程）：<https://grafana.com/developers/plugin-tools/publish-a-plugin/publish-a-plugin.md>
- Grafana Advisor：<https://grafana.com/docs/grafana/v13.1/administration/grafana-advisor.md>
- Node 内置代理支持：<https://nodejs.org/docs/latest-v24.x/api/http.html#built-in-proxy-support>
- 本地源码：`grafana/apps/advisor/pkg/app/checks/`、`grafana/pkg/services/pluginsintegration/pluginchecker/service.go`
