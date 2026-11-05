# templates —— 「DSH 桌面」产品装配清单历史快照

来源：`dsh-runtime/product/products/dsh-desktop/`（2026-11-05 收编）。

- `dsh-desktop.product.json` —— base dsh + launchers 的产品装配清单
  （原由 product-packager 消费，组装 `dsh.exe` + 便携 node + `app/` + `data/`）
- `dsh-desktop.runtime-manifest.json` —— 便携 Node.js 运行时清单（版本/SHA256）

⚠️ 两份清单引用的 `packages/dsh-*`、`extensions/official/dsh-launchpad` 等均为
**本仓改名前路径**（现已为 `capyclaw-*` / `extensions/bridges/...`），且
product-packager 工具已随 dsh-runtime 退役——此处仅存装配思路，不可直接复用。
