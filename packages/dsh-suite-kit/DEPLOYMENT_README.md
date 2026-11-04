# DSH 统一部署配置系统

> **一个配置文件 + 一个启动命令 = 自动部署 DSH 及其功能集合**

## 🎯 核心价值

- ✅ **配置即代码**: JSON 文件，可版本控制
- ✅ **一键部署**: `dsh-deploy start config.json`
- ✅ **标准化流程**: 验证 → 创建 → 启动 → 健康检查 → 状态追踪
- ✅ **生命周期钩子**: beforeStart / afterStart / beforeStop / afterStop
- ✅ **多环境支持**: dev / staging / prod 独立配置

## 📖 文档

| 文档 | 说明 |
|---|---|
| [DEPLOYMENT_QUICKSTART.md](./DEPLOYMENT_QUICKSTART.md) | ⭐ **快速开始**：5分钟上手 |
| [DEPLOYMENT.md](./DEPLOYMENT.md) | 📘 **完整文档**：配置详解、高级用法 |
| [deployment.schema.json](./deployment.schema.json) | 📋 **配置 Schema**：VSCode 自动补全 |
| [examples/](./examples/) | 💡 **配置示例**：3个实战案例 |

## ⚡ 快速开始

### 1. 创建配置

```json
{
  "name": "my-ppt",
  "version": "1.0.0",
  "deployment": {
    "type": "domain",
    "source": "./bridges/ppt-bridge/domains/ppt"
  }
}
```

### 2. 一键部署

```bash
node packages/dsh-suite-kit/bin/dsh-deploy.mjs start my-ppt.json
```

### 3. 管理

```bash
dsh-deploy status my-ppt.json    # 查看状态
dsh-deploy restart my-ppt.json   # 重启
dsh-deploy list                  # 列出所有部署
```

## 📁 文件说明

```
packages/dsh-suite-kit/
├── deployment.schema.json              # 配置 Schema
├── bin/
│   ├── dsh-deploy.mjs                 # 🚀 统一启动器（核心）
│   └── dsh-runtime.mjs                # 底层 runtime 管理
├── examples/
│   ├── deployment-ppt-basic.json      # 基础部署
│   ├── deployment-ppt-dev.json        # 开发环境
│   └── deployment-multi-service.json  # 多服务
├── DEPLOYMENT_QUICKSTART.md           # 快速开始
├── DEPLOYMENT.md                      # 完整文档
└── README.md                          # 本文件
```

## 🎨 配置示例

### 最小配置

```json
{
  "name": "ppt-basic",
  "version": "1.0.0",
  "deployment": {
    "type": "domain",
    "source": "./bridges/ppt-bridge/domains/ppt"
  }
}
```

### 生产环境

```json
{
  "name": "ppt-prod",
  "version": "1.0.0",
  "deployment": {
    "type": "domain",
    "source": "./bridges/ppt-bridge/domains/ppt",
    "autoStart": true
  },
  "runtime": {
    "ports": {
      "harness": { "preferred": 3080, "range": 100 },
      "content": { "preferred": 39311, "range": 100 }
    }
  },
  "launcher": {
    "mode": "background",
    "healthCheck": {
      "enabled": true,
      "interval": 30,
      "retries": 3
    },
    "beforeStart": ["node scripts/backup.mjs"],
    "afterStart": ["node scripts/notify.mjs"]
  },
  "metadata": {
    "environment": "production",
    "owner": "ops-team"
  }
}
```

## 🔧 命令参考

| 命令 | 说明 |
|---|---|
| `start <config>` | 创建并启动部署 |
| `stop <config>` | 停止部署 |
| `restart <config>` | 重启部署 |
| `status <config>` | 查看状态 |
| `validate <config>` | 验证配置 |
| `list` | 列出所有部署 |
| `clean <config>` | 停止并删除 |

## 🌟 核心特性

### 1. 配置驱动

```bash
# 旧方式：多个命令 + 手动参数
dsh-runtime create --name xxx --domain yyy
dsh-runtime start xxx
curl http://localhost:39312/healthz

# 新方式：一个配置文件
dsh-deploy start config.json
# ✅ 自动创建、启动、健康检查、状态追踪
```

### 2. 生命周期钩子

```json
{
  "launcher": {
    "beforeStart": ["echo 'Preparing...'"],
    "afterStart": ["echo 'Started'"],
    "beforeStop": ["echo 'Stopping...'"],
    "afterStop": ["echo 'Cleanup complete'"]
  }
}
```

### 3. 健康检查

```json
{
  "launcher": {
    "healthCheck": {
      "enabled": true,
      "interval": 30,
      "timeout": 10,
      "retries": 3
    }
  }
}
```

### 4. 多环境隔离

```bash
deployments/
├── ppt-dev.json      # 开发：前台 + 调试
├── ppt-staging.json  # 测试：后台 + 监控
└── ppt-prod.json     # 生产：完整配置
```

## 📊 对比

| 特性 | 手动 | dsh-runtime | **dsh-deploy** |
|---|---|---|---|
| 配置管理 | ❌ 分散 | ⚠️ 命令行 | ✅ 配置文件 |
| 可版本化 | ❌ | ❌ | ✅ Git |
| 健康检查 | ❌ 手动 | ❌ | ✅ 自动 |
| 状态追踪 | ❌ | ⚠️ 基础 | ✅ 完整 |
| 钩子支持 | ❌ | ❌ | ✅ 4个钩子 |
| 多环境 | ❌ 难管理 | ⚠️ 需记忆 | ✅ 配置区分 |

## 🚀 立即试用

```bash
# 1. 验证示例配置
node packages/dsh-suite-kit/bin/dsh-deploy.mjs validate \
  packages/dsh-suite-kit/examples/deployment-ppt-basic.json

# 2. 启动部署
node packages/dsh-suite-kit/bin/dsh-deploy.mjs start \
  packages/dsh-suite-kit/examples/deployment-ppt-basic.json

# 3. 查看状态
node packages/dsh-suite-kit/bin/dsh-deploy.mjs list
```

## 📚 相关文档

- [DSH Suite Kit](./README.md) - Suite/Domain 组合标准
- [公共插件架构](../../docs/PUBLIC_PLUGINS.md) - 插件标准化
- [PPT Bridge](../../extensions/bridges/ppt-bridge/README.md) - PPT 工作台实现

---

**🎉 享受标准化部署带来的便利！**
