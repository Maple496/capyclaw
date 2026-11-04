# DSH 插件源标准 v1（`plugin-source/1`）

> **这份文档是唯一标准。** 生产中心按它产出，消费方按它校验。
> 任何"软件源"，只要满足本文全部条款，就是一个合法的 DSH 插件源，
> 可以直接被消费方切换使用——**不需要它由谁生产，也不需要它知道谁在消费**。

---

## 0. 一句话

**源 = 一个目录**，里面有 `index.json`，以及若干插件 zip。
把它放在 HTTP(S) 静态目录、对象存储、或本机/U 盘文件夹，就完成了分发。

```
<源根>/
├── index.json                       # 必需：源索引（唯一入口）
└── plugins/                         # 约定目录（file 字段指向，可省但不能乱）
    ├── dsh-port-sidebar-1.0.0.zip
    └── dsh-xxx-2.1.0.zip
```

**只有一个文件是必需的**：`index.json`。`plugins/` 只是本标准的默认布局约定；
索引里的 `file` 是**相对源根**的任意安全路径，所以你完全可以把 zip 放在
`packages/`、`stable/` 或 CDN 的其他前缀下。

---

## 1. 传播形态（三种，语义完全等价）

| 形态 | 怎么用 | 典型场景 |
|---|---|---|
| **单一压缩包**（推荐传播） | 把源根整个打成 `dsh-plugin-source-<stamp>.zip`；接收方解压即得到源根 | U 盘、IM 传文件、离线交付 |
| **静态 HTTP 目录** | 源根放到任意静态托管，消费方填 `https://host/path` | CDN / 对象存储 / 内网文件服务 |
| **本机目录** | 消费方直接填文件夹路径（`D:\dsh-plugins` 或 `file:///...`） | 同机联调、共享盘 |

三者的 `index.json` 与 zip **逐字节相同**。切换形态 = 只改消费方的源地址，其他零改动。

> 消费方内置的实现（`桌前面前端/backend/works_plugins.py`）对本地目录会归一化成
> `file:///...`，与 HTTP 走同一条读取路径——所以"本地能装、HTTP 装不了"这类
> 差异不存在。

---

## 2. `index.json` 规范（必需）

### 2.1 顶层

```json
{
  "schema": 1,
  "channel": "stable",
  "generatedAt": "2026-11-01T10:29:58.000Z",
  "plugins": [ ... ]
}
```

| 字段 | 必需 | 约束 |
|---|---|---|
| `schema` | ✅ | **必须**是数字 `1`。其他值 = 不是本标准的源，消费方必须拒收 |
| `channel` | 建议 | 字符串渠道名（`stable` / `beta` / 自定义）。消费方原样展示，不做语义判断 |
| `generatedAt` | 建议 | ISO-8601 时间戳 |
| `plugins` | ✅ | 数组，见 2.2。允许跨插件多版本共存 |

未知顶层字段：**忽略**（向前兼容，新字段加入不算破坏性变更）。

### 2.2 `plugins[]` 条目

```json
{
  "name": "dsh-port-sidebar",
  "version": "1.0.0",
  "title": "端口侧边栏",
  "description": "右侧边栏常驻展示指定端口……",
  "category": "ui",
  "platform": "web",
  "bundle": true,
  "client": true,
  "dsh": "^0.2.0-rc.2",
  "file": "plugins/dsh-port-sidebar-1.0.0.zip",
  "sha256": "80220358454d364b2206cf56ae9b7cc5ece7781d73cfb61cd0011181edce31d2",
  "size": 113878,
  "latest": true
}
```

| 字段 | 必需 | 约束 |
|---|---|---|
| `name` | ✅ | 与 zip 内 `package.json.name` **完全一致**；匹配 `^(@[\w-]+\/)?dsh-[\w-]+$` |
| `version` | ✅ | 与 zip 内 `package.json.version` **完全一致**；严格 semver（可有预发布段） |
| `file` | ✅ | **相对源根**的 zip 路径；禁止绝对路径与 `..` 上跳 |
| `sha256` | ✅ | 64 位小写十六进制；**必须**等于 zip 字节的 SHA-256 |
| `dsh` | ✅ | 兼容的 dsh 运行时范围（来自插件 `package.json.engines.dsh`） |
| `bundle` | ✅ | 布尔。`true` = 包声明了 `dsh.bundle.patch`，可作为 profile 层加载。**`false` 的条目不可安装**（消费方必须拒绝） |
| `latest` | 建议 | 布尔。同名多版本时标记"默认装哪个"；一个都没有时消费方取版本最高者 |
| `title` / `description` | 建议 | 展示用；缺省回退 `name` / 空串 |
| `category` | 建议 | `ui` / `service` / `bridge` / `tool` / `suite` |
| `platform` | 建议 | `web` / `desktop` / `both` |
| `client` | 建议 | 布尔，是否有浏览器半 |
| `size` | 建议 | zip 字节数（仅展示，校验以实际下载为准） |

**单条坏数据 → 跳过该条，不废整个源**。若所有条目都无效 / `plugins` 为空 →
消费方必须报"源里没有有效插件"，而不是静默成功。

### 2.3 不合法的源（消费方必须拒收）

- `schema != 1`
- `plugins` 不是数组
- `index.json` 不是合法 JSON，或体积 > 4 MB
- 条目缺 `name` / `version` / `file` / `sha256` 任一，或 `sha256` 不是 64 位十六进制

---

## 3. 插件包规范（zip）

### 3.1 形状

```
zip 根 = 包根
├── package.json            # ✅ 必需
├── cordis.patch.yml        # ✅ 必需（dsh.bundle.patch 指向的文件）
├── lib/…                   # 宿主半入口（package.json.main）
├── client/…                # 可选：浏览器半（package.json.exports["./client"]）
└── node_modules/<dep>/…    # 可选但强烈建议：内置 workspace 依赖
```

- **单层外包目录会自动剥除**（GitHub 式 `repo-main/…` 也接受），但推荐直接以包根打。
- zip 内**禁止**绝对路径与 `..` 上跳（消费方按成员逐条校验）。
- 解压总量上限 4 GiB、成员数上限 10 万（消费方实现，超限拒装）。

### 3.2 `package.json` 必需字段

```json
{
  "name": "dsh-xxx",
  "version": "1.0.0",
  "type": "module",
  "main": "./lib/index.mjs",
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } },
  "engines": { "dsh": "^0.2.0-rc.2" }
}
```

| 字段 | 为什么是必需的 |
|---|---|
| `name` | 索引与落装目录都按它命名；与索引不一致即拒装 |
| `version` | 版本判定 / 升级 / `latest` |
| `dsh.bundle.patch` | **没有它，dsh 不会把这个包当 profile 层加载** —— 装了也是白装 |
| `engines.dsh` | 消费方据此判断兼容性；缺了就无法判断，标准要求必须有 |

### 3.3 依赖

- `dependencies` **禁止** `link:` / `file:`（那是源码树本地路径，分发出去必断）。
- workspace 内依赖（`dsh-plugin-kit` 等）**必须内置**到 `node_modules/<name>/`，
  否则装到独立目录会 `MODULE_NOT_FOUND`。
  发布工具会自动检测并打进去（见 §5.1）。
- 外部 npm 依赖：标准不要求内置（各消费方运行时自行解析）；若目标环境无 npm，
  请在发布时一并内置。

---

## 4. 消费方契约

一个合法的消费方实现，只需要做对四件事：

1. **读源**：取 `<源>/index.json`，按 §2.3 校验。
2. **选包**：按 `name` + 可选 `version` 选条目；无版本时取 `latest`，都没有取最高版本。
3. **验包**：下载 `file` → 算 SHA-256 → 与 `sha256` 比对 → 不符**拒装**（已落盘的临时文件删除）。
4. **落装 + 注册**：解包 → 放进自己的插件目录 → 按 dsh 的注册语义挂到 profile。

参考实现（可直接抄）：
- Python：`桌前面前端/backend/works_plugins.py`
- Node：`deepseekharness_dev/tools/plugin-release/lib/index.mjs`（`readIndex` / `pickEntry` / `readZipEntryBuffer`）

### 4.1 注册语义（dsh 侧，三处缺一不生效）

```
<DSH_HOME>/profiles/<DSH_PROFILE>/
├── package.json          dependencies[<name>]  +  dsh.profile.bundles[]
├── node_modules/<name>/  实际被 loader 解析的包目录
└── cordis.patch.yml      用户覆盖层（不参与插件选择）
```

- `dependencies[<name>]`：用 `file:<安装目录绝对路径>`（消费方管理面靠它核验版本/断链）
- `dsh.profile.bundles[]`：追加裸包名（这是"会被加载"的唯一开关）
- `node_modules/<name>/`：包实体

**缺任何一处都不生效**，而且 dsh 只会打一行 `skipping profile bundle` 静默跳过——
所以消费方必须三处同时写、同时拆。

### 4.2 兼容性

`engines.dsh` vs 运行时版本（`<程序包>/node_modules/@deepseek-ai/dsh/package.json.version`）：

- 支持 `^` / `~` / `>=` / `<=` / `>` / `<` / `=` / 裸版本 / `*`
- 无法解析的范围 → **放行并标注未知**（不阻断）
- 明确不满足 → **拒装 + 目录里标 `compatible:false`**（诚实失败，不静默跳过）

---

## 5. 生产方（发布工具）

```bash
npm run release-plugin -- dsh-port-sidebar   # 发单个（规范闸 + 发布闸 + 打包）
npm run release-all                          # 发全部"已就绪"的插件
npm run release-index                        # 只重建 index.json（扫已有 zip）
npm run release-source                       # 源 → 单一 zip（release/）
npm run verify-source -- <源目录或URL>        # 按本标准校验任意源
```

### 5.1 发布闸（不通过就拒发）

1. **插件规范闸** —— 复用 `tools/plugin-validator`（目录/命名/必填字段/测试）
2. **发布闸** —— 分发必需项：
   - `engines.dsh` 必须声明
   - `dsh.bundle.patch` 必须存在且文件真实存在
   - `dependencies` 不许 `link:` / `file:`

`release-all` **只发已就绪的插件**；未就绪的会列出来并说明原因，但不会让整批失败。
要发某个未就绪的插件，用 `release-plugin -- <路径>` 单独跑，能看到完整原因。

### 5.2 索引自证

`index.json` 不是手工维护的：`buildIndex()` 会**打开每个 zip 读其中的 `package.json`**
反推 `name` / `version` / `dsh`，再算 `sha256`。
所以索引永远与包实体一致，不存在"索引说 A、包里是 B"。

---

## 6. 切换源的操作标准

> 场景：你现在用源 A，想换成源 B，且 B 满足本标准。

**消费方侧（桌前面前端）**

```http
POST /api/desktop/plugins/source
{"url": "https://new-source.example/plugins"}     # 或 "D:\\dsh-plugins"

→ {"ok": true, "url": "...", "channel": "stable", "plugins": 3}
```

设置是**探测成功才落库**：`index.json` 拿不到 / 形状不对 → 返回 4xx/5xx，
旧源配置保持不变（不会把自己搞成"无源"状态）。

切换后：

| 情况 | 结果 |
|---|---|
| 已装插件在 B 里也有同名同版本 | 无变化（`update:false`） |
| 已装插件在 B 里有更高版本 | 目录页 `update:true`，点安装 = 升级（旧版本目录自动清） |
| 已装插件在 B 里不存在 | 仍可用（本地已落装），目录页不再展示它，可卸载 |
| B 里新增插件 | 直接出现在目录页，可安装 |

**卸载源本身不会卸载已装插件** —— `DELETE /api/desktop/plugins/source` 只清源配置。

**生产方侧**：换源不影响生产方；生产方只负责"产出一个满足本标准的目录"。

---

## 7. 版本与兼容策略

- 同一 `name` 的多版本可**共存**在同一个源里（`plugins/dsh-x-1.0.0.zip` 与 `1.1.0.zip`）。
- `latest:true` 决定默认装哪个；没有标记则取最高版本。
- 升级 = 装更高版本；消费方落装到 `<name>/<version>/`，换装后清旧版本目录。
- **索引只增不改**：老版本条目可长期保留，方便回滚（消费方按 `version` 显式安装即可）。

---

## 8. 合规性验证矩阵（本标准由这些闸强制）

任何一方想确认"这个源到底合不合规"，跑对应闸即可，**双侧断言一致**：

| # | 闸 | 位置 | 证明什么 |
|---|---|---|---|
| 1 | 源校验器（28 项负向 + 正向） | `npm run verify-source -- <源>`（`tools/plugin-release`） | 索引形状、sha256、包名/版本一致、patch 存在、engines.dsh、无 link: 依赖、路径安全、HTTP/file 双形态 |
| 2 | 发布闸（9 项） | `npm run verify-source` | 发布闸拒收（缺 engines/patch、link 依赖）、zip 内容自足、索引自证、整源打包 |
| 3 | 消费方标准一致性（31 项） | `python -m unittest test_plugin_source_standard`（消费方 backend） | 合规源可装、不合规源在**换源闸**被拒且旧源不坏、三处注册正确、换源不影响已装、多版本/回滚、源宕机降级 |
| 4 | 消费方投递面（22 项） | `python -m unittest test_works_plugins` | 源归一、目录合并、sha256 拒收、安装/升级/卸载回路、兼容性判定 |
| 5 | 投递 E2E（真网关） | `bash backend/checks/run.sh e2e-plugins` | HTTP 全链路：设源→目录→安装→profile 注册→dsh 管理面无断链→卸载 |
| 6 | 全链路 E2E（真 dsh 进程） | `bash backend/checks/run.sh e2e-plugins-dsh` | 插件在 dsh 进程内真实执行、不被跳过、卸载后重启无残留 |
| 7 | 多源切换 E2E | `bash backend/checks/run.sh e2e-plugin-sources` | 生产源(HTTP)/外部源(HTTP)/单一 zip 解压(目录) 三载体切换、坏源拒收、源宕机诚实降级 |
| 8 | 仓闸 | `bash backend/checks/run.sh checks` | 物理隔离 + 网络出口闸 + 后端全量单测 + HTTP 契约冒烟 |

**换源前三步**（推荐顺序）：

```bash
# 1) 生产中心侧先验（可选，任何机器都行）
npm run verify-source -- https://your-source.example/plugins

# 2) 消费方侧体检（不落库）
curl -X POST http://127.0.0.1:3311/api/desktop/plugins/source/verify \
  -d '{"url":"https://your-source.example/plugins"}'

# 3) 正式切换（内部还会再完整校验一遍，失败自动保持旧源）
curl -X POST http://127.0.0.1:3311/api/desktop/plugins/source \
  -d '{"url":"https://your-source.example/plugins"}'
```

---

## 9. 附：最小合法源（可照抄自测）

```
demo-source/
├── index.json
└── plugins/
    └── dsh-hello-1.0.0.zip
```

```json
{
  "schema": 1,
  "channel": "stable",
  "plugins": [
    {
      "name": "dsh-hello",
      "version": "1.0.0",
      "file": "plugins/dsh-hello-1.0.0.zip",
      "sha256": "<该 zip 的 sha256>",
      "dsh": "^0.2.0-rc.2",
      "bundle": true,
      "latest": true
    }
  ]
}
```

自检：`npm run verify-source -- demo-source` → 应输出 `✓ 源符合 plugin-source/1`。
