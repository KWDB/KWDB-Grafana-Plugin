# 真实 KWDB 实例验证工具

这两个脚本用**插件自己的源码**生成 SQL，再逐条在真实 KWDB 上执行，用来验证"编辑器里点出来的语句数据库到底认不认"。

它们不是插件的一部分：不参与 `yarn build` / `mage buildAll`，不发版，只在需要真机验证时手动跑。

## 用法

```bash
# 1. 生成 SQL（用 src/sqlBuilder.ts 和 src/variableQuery.ts 的真实实现）
npx ts-node --compiler-options '{"module":"commonjs","moduleResolution":"node","target":"es2020","esModuleInterop":true,"strict":false}' gen.ts

# 2. 逐条执行并记录结果
KWDB_HOST=10.110.105.80 KWDB_PORT=26267 KWDB_DATABASE=factory \
KWDB_USER=root KWDB_PASSWORD=passwd \
npx ts-node --compiler-options '{"module":"commonjs","moduleResolution":"node","target":"es2020","esModuleInterop":true,"strict":false,"types":["node"]}' run.ts
```

## 文件

| 文件 | 作用 |
| --- | --- |
| `gen.ts` | 生成 `cases.json`：56 条 SQL + 模板变量往返用例。SQL 里的 `$__timeFrom`/`$__timeTo` 按 `pkg/plugin/macros.go` 的方式展开，保证与后端产出一致 |
| `run.ts` | 读 `cases.json`，逐条 psql 执行，写 `results.json`。`expectFail: true` 的用例失败时记为 `xfail`（按设计被数据库拒绝），不计入失败数 |
| `cases.json` / `results.json` | 生成物，提交与否都行；`results.json` 是某次真机跑动的证据 |

## 状态含义

- `ok` — 执行成功
- `FAIL` — 执行失败，需要看错误
- `xfail` — 按设计被 KWDB 拒绝（例如 gapfill 配 `none` 聚合）
- `----` — 构建器按设计返回空串（危险片段、非数字 COUNT_WINDOW 参数）

## 记录结果

2026-10-29 对 `10.110.105.80:26267/factory`：56 条中 51 条通过、0 失败、4 条按设计空串、1 条按设计被拒。
完整报告见 `../docs/real-server-verification-2026-10-29.md`。
