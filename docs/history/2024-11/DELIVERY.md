# DSH 插件投递契约（生产中心 → 源 → 消费方）

> **本文是投递流程说明。格式规范（"什么样的源才算合法"）见
> [PLUGIN_SOURCE_STANDARD.md](./PLUGIN_SOURCE_STANDARD.md)（`plugin-source/1`）。
> 任何满足该标准的软件源都能直接作为安装源被切换使用。**

三方**互不认识**：

```
deepseekharness_dev                中间层（源）                      消费方（任意多个）
  发布工具 / 插件源码   ──zip──▶  index.json + plugins/*.zip  ──▶  桌前面前端 / 其他桌面
  tools/plugin-release             静态 HTTP · 对象存储 · 本地目录      拉取 → 校验 → 落装 → 注册
```

- 生产中心**不知道**有几个消费方，也不需要知道。
- 消费方**不知道**插件从哪来，只知道一个**源地址**。
- 双方唯一的共同语言 = **源目录里的 `index.json`**。

---

## 一、生产中心：产出物

```bash
npm run release-all                      # 发布本仓所有可发布插件 → dist/
npm run release-plugin -- dsh-port-sidebar   # 只发一个
npm run release-index                    # 重建 index.json（扫 dist/plugins/*.zip）
npm run release-source                   # 把整个源打成单一 zip → release/
npm run verify-source -- dist            # 按 plugin-source/1 校验源（也接受 URL）
```

产出：

```
dist/
├── index.json                           ← 源索引（消费方唯一入口）
└── plugins/
    └── dsh-port-sidebar-1.0.0.zip       ← 每个插件一个 zip（根 = 包根）

release/
└── dsh-plugin-source-<stamp>.zip        ← 整个源 = 可一次传播的单一文件
```

`release/dsh-plugin-source-*.zip` 就是"可轻易传播的那个压缩包"：解压到任何
静态目录 / 对象存储 / 本机文件夹，它就是一个可用的源。

### 发布闸

发布前依次过两道：

1. **插件规范闸** = `tools/plugin-validator`（目录结构、命名、必填字段、测试）
2. **发布闸**（分发必需，验证器不管）：
   - `engines.dsh` 必须声明兼容的 dsh 运行时范围（消费方据此判断能不能装）
   - `dsh.bundle.patch` 必须存在且文件真实存在（否则 dsh 只会静默 `skipping profile bundle`）
   - `dependencies` 里不许有 `link:` / `file:`（分发件不能依赖源码树位置）

不通过即拒发，`npm run release-all` 退出码非 0。

### 内置依赖（vendor）

workspace 内的依赖（如 `dsh-plugin-kit`）会自动打进 `node_modules/<name>/`，
消费方侧解包即用，**零 npm、零构建**。外部 npm 包不 vendor。

---

## 二、源：`index.json` 契约

```json
{
  "schema": 1,
  "channel": "stable",
  "generatedAt": "2026-11-01T09:56:28.538Z",
  "plugins": [
    {
      "name": "dsh-port-sidebar",
      "version": "1.0.0",
      "title": "端口侧边栏",
      "description": "……",
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
  ]
}
```

| 字段 | 语义 |
|---|---|
| `schema` | 固定 `1`。不认识的 schema 一律拒收 |
| `file` | 相对**源根**的路径（不是相对 index.json） |
| `sha256` | zip 的强校验值；不符即拒装 |
| `dsh` | 兼容的 dsh 运行时范围（来自插件 `engines.dsh`） |
| `latest` | 同名插件的最新版本；缺版本时消费方取它 |
| `bundle` | 包内声明了 `dsh.bundle.patch` → 可作为 profile 层加载 |

源可以放任意位置，只要消费方能访问到 `<源>/index.json` 和 `<源>/<file>`：

- `https://…/dsh-plugins/`（静态托管 / 对象存储目录）
- `file:///D:/dsh-plugins/`（U 盘、共享盘、本机目录）

---

## 三、消费方：注册语义

消费方把插件装上后，**唯一权威注册点是 dsh 自己的 profile**：

```
<DSH_HOME>/profiles/<DSH_PROFILE>/
├── package.json          dependencies[<name>] + dsh.profile.bundles[]
├── node_modules/<name>/  实际被 loader 解析的包目录
└── cordis.patch.yml      本人覆盖层（不参与 plugin 选择）
```

安装动作 = 三件事同时成立，缺一不生效：

1. `node_modules/<name>/` 有位（否则 `resolveBundleDir` 抛错）
2. `dependencies[<name>]` 有登记（否则被当作无关目录）
3. `dsh.profile.bundles[]` 里有名字（否则不会被加载）

卸载 = 反向三件事，并把包目录移出。

`DSH_HOME` / `DSH_PROFILE` 由消费方自己的服务声明决定（桌面前端 = `user_works/services.json` 的 `env`），插件投递方无需知道。

---

## 四、兼容性

- 插件声明 `engines.dsh`（如 `^0.2.0-rc.2`）
- 消费方运行时版本 = `<程序包>/node_modules/@deepseek-ai/dsh/package.json` 的 `version`
- 不满足时：**拒装并在目录页标记 `incompatible`**（诚实失败，不静默跳过）

---

## 五、新增一个消费方

对方只需要实现"读 `index.json` → 按 `sha256` 校验 → 解包 → 写自己 profile 的三处"。
参考实现：`桌前面前端/backend/works_plugins.py`（Python）与本仓
`tools/plugin-release/lib/index.mjs` 的 `readIndex` / `pickEntry`（Node）。

生产中心侧**零改动**。

---

## 五之二、切换源（任何合规源都能用）

消费方只有一个概念：**源地址**。换成另一个源，只需重新设一次：

```http
POST /api/desktop/plugins/source     {"url": "<新源地址>"}
```

- 设源前会按 `plugin-source/1` **完整校验**（索引形状 + 逐包 sha256 + 包内元数据）。
- 不合法 → `400` + 具体原因，**旧源配置原样保留**（不会把自己搞成无源）。
- 换源**不影响已装插件**（它们已落在本地并注册在 profile 里）。
- 只体检不切换：`POST /api/desktop/plugins/source/verify {"url": "<候选源>"}`。

详细判定表（已装/更新/新增/消失各是什么结果）见
[PLUGIN_SOURCE_STANDARD.md §6](./PLUGIN_SOURCE_STANDARD.md#6-切换源的操作标准)。

---

## 六、当前源里的插件

| 插件 | 版本 | 用途 |
|---|---|---|
| `dsh-port-sidebar` | 1.0.0 | 右侧边栏常驻端口页面（强制保活），验证整条投递链路 |
