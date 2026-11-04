# @capyclaw/launch-engine-suite

按需激活引擎套件：`@capyclaw/launch-engine`（组合根）+ `@capyclaw/plugin-sync`
（bundle/entry 开关的转发通道）。

- 组件声明见 `dsh-suite.json`；`cordis.patch.yml` 由
  `dsh-suite compose` 生成（`renderCordisPatch`），改 manifest 后重跑，不手改。
- 注册表**不手写**：`registryKind: profile`，读 suite-kit 安装期生成的
  `<profile>/launch-engine.registry.json`（`dsh-suite registry` /
  `dsh-domain registry` 可预览），`dsh-suite.json` 是唯一事实来源。
- 服务进程步骤另需 serviceBroker（`@capyclaw/service-broker` 宿主插件），
  缺失时引擎诚实上报 unavailable。
