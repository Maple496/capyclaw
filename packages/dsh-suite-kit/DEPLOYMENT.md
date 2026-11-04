# DSH 统一部署系统

## 概述

通过标准化的配置文件 + 统一启动器，实现"一键部署任意 DSH 功能集合"。

## 核心理念

```text
配置文件 (JSON)  →  dsh-deploy 启动器  →  自动创建/启动/管理 Runtime
     ↓                     ↓                        ↓
  声明式描述            标准化流程              隔离的运行环境
```

## 快速开始

### 1. 创建部署配置

```json
{
  "name": "my-ppt",
  "version": "1.0.0",
  "title": "我的 PPT 工作台",
  
  "deployment": {
    "type": "domain",
    "source": "./bridges/ppt-bridge/domains/ppt",
    "autoStart": true
  },
  
  "runtime": {
    "ports": {
      "harness": 3082,
      "content": 39312
    }
  }
}
```

### 2. 一键部署

```bash
# 创建并启动
node packages/dsh-suite-kit/bin/dsh-deploy.mjs start my-ppt.json

# 查看状态
node packages/dsh-suite-kit/bin/dsh-deploy.mjs status my-ppt.json

# 停止
node packages/dsh-suite-kit/bin/dsh-deploy.mjs stop my-ppt.json

# 重启
node packages/dsh-suite-kit/bin/dsh-deploy.mjs restart my-ppt.json

# 完全清理
node packages/dsh-suite-kit/bin/dsh-deploy.mjs clean my-ppt.json

# 列出所有部署
node packages/dsh-suite-kit/bin/dsh-deploy.mjs list
```

## 配置文件详解

### 基本信息

```json
{
  "name": "ppt-dev",              // 部署名称（唯一标识）
  "version": "1.0.0",             // 配置版本
  "title": "PPT 开发环境",        // 显示名称
  "description": "开发测试用部署" // 说明
}
```

### 部署配置 (deployment)

```json
{
  "deployment": {
    "type": "domain",                        // 类型: domain | suite | custom
    "source": "../extensions/bridges/ppt-bridge/domains/ppt",  // 源路径
    "storeRoot": "~/.dsh-store",            // 存储根目录（可选）
    "autoStart": true,                       // 创建后自动启动
    "autoRestart": false                     // 崩溃后自动重启（未来支持）
  }
}
```

**部署类型**：
- `domain`: 领域包（推荐，包含完整功能集）
- `suite`: 套件（组件集合）
- `custom`: 自定义组合（高级用法）

### 运行时配置 (runtime)

```json
{
  "runtime": {
    "driver": "node",              // 隔离驱动: node | jobobject | docker
    "workId": "main",              // 工作区 ID
    
    "ports": {
      "harness": 3082,             // Harness 端口（固定值或自动分配）
      "content": {
        "preferred": 39312,        // 偏好端口
        "range": 100               // 搜索范围（39312-39412）
      }
    },
    
    "model": {
      "id": "llm-deepseek",
      "plugin": "@deepseek-ai/dsh-llm-deepseek-api-key",
      "apiKeyEnv": "DEEPSEEK_API_KEY",
      "baseURL": "https://api.deepseek.com/anthropic"
    },
    
    "env": {                       // 环境变量
      "NODE_ENV": "production",
      "DEBUG": "dsh:*"
    }
  }
}
```

### 启动器配置 (launcher)

```json
{
  "launcher": {
    "mode": "background",          // 启动模式: foreground | background | service
    "logFile": "runtime.log",      // 日志文件
    
    "healthCheck": {               // 健康检查
      "enabled": true,
      "interval": 30,              // 检查间隔（秒）
      "timeout": 10,               // 超时（秒）
      "retries": 3                 // 失败重试次数
    },
    
    "beforeStart": [               // 启动前钩子
      "echo 'Preparing...'",
      "node scripts/check-deps.mjs"
    ],
    
    "afterStart": [                // 启动后钩子
      "echo 'Started successfully'"
    ],
    
    "beforeStop": [                // 停止前钩子
      "echo 'Stopping...'"
    ],
    
    "afterStop": [                 // 停止后钩子
      "echo 'Cleanup complete'"
    ]
  }
}
```

### 监控配置 (monitoring) - 未来特性

```json
{
  "monitoring": {
    "enabled": true,
    "metricsPort": 9090,
    "alerts": {
      "cpuThreshold": 80,
      "memoryThreshold": 85,
      "diskThreshold": 90
    }
  }
}
```

### 元数据 (metadata)

```json
{
  "metadata": {
    "owner": "admin",
    "environment": "production",   // development | staging | production
    "tags": ["ppt", "stable"],
    "notes": "生产环境部署"
  }
}
```

## 配置示例

### 示例 1: 基础 PPT 部署

```json
{
  "$schema": "./deployment.schema.json",
  "name": "ppt-basic",
  "version": "1.0.0",
  "title": "PPT 工作台 - 基础版",
  
  "deployment": {
    "type": "domain",
    "source": "../../../extensions/bridges/ppt-bridge/domains/ppt",
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
    "healthCheck": { "enabled": true }
  }
}
```

### 示例 2: 开发环境（前台 + 详细日志）

```json
{
  "name": "ppt-dev",
  "version": "1.0.0",
  
  "deployment": {
    "type": "domain",
    "source": "../../../extensions/bridges/ppt-bridge/domains/ppt",
    "autoStart": true,
    "autoRestart": true
  },
  
  "runtime": {
    "workId": "dev",
    "ports": { "harness": 3082, "content": 39312 },
    "env": {
      "NODE_ENV": "development",
      "DEBUG": "dsh:*"
    }
  },
  
  "launcher": {
    "mode": "foreground",
    "logFile": "dev.log",
    "healthCheck": {
      "enabled": true,
      "interval": 10,
      "retries": 1
    }
  },
  
  "metadata": {
    "environment": "development",
    "tags": ["dev", "debug"]
  }
}
```

### 示例 3: 多服务组合部署

```json
{
  "name": "multi-service",
  "version": "1.0.0",
  "title": "多服务组合",
  
  "deployment": {
    "type": "custom",
    "source": "./multi-service-manifest.json"
  },
  
  "runtime": {
    "ports": {
      "harness": { "preferred": 3090, "range": 100 },
      "content": { "preferred": 39400, "range": 100 }
    }
  },
  
  "launcher": {
    "mode": "background",
    "beforeStart": [
      "node scripts/check-deps.mjs",
      "node scripts/migrate-data.mjs"
    ],
    "afterStart": [
      "node scripts/notify-ready.mjs"
    ]
  },
  
  "monitoring": {
    "enabled": true,
    "metricsPort": 9090
  },
  
  "metadata": {
    "environment": "production",
    "tags": ["multi-service", "ppt", "canvas"],
    "owner": "admin"
  }
}
```

## 部署流程

### 启动流程

```text
1. 加载配置文件
   ↓
2. 验证配置（schema + 路径检查）
   ↓
3. 执行 beforeStart 钩子
   ↓
4. 调用 dsh-runtime create
   ↓
5. 调用 dsh-runtime start
   ↓
6. 健康检查（重试机制）
   ↓
7. 执行 afterStart 钩子
   ↓
8. 保存部署状态
   ↓
9. 显示访问地址
```

### 停止流程

```text
1. 读取部署状态
   ↓
2. 执行 beforeStop 钩子
   ↓
3. 调用 dsh-runtime stop
   ↓
4. 执行 afterStop 钩子
   ↓
5. 更新部署状态
```

## 部署状态管理

### 状态文件位置

```
~/.dsh-store/deployments/<name>.json
```

### 状态文件格式

```json
{
  "name": "ppt-basic",
  "version": "1.0.0",
  "runtimeId": "rt-ppt-basic-100",
  "configPath": "/path/to/config.json",
  "status": "running",
  "createdAt": "2024-10-31T12:00:00.000Z",
  "updatedAt": "2024-10-31T12:05:00.000Z"
}
```

**状态值**：
- `running`: 运行中
- `stopped`: 已停止
- `failed`: 失败

## 钩子变量

钩子命令中可以使用以下变量：

- `${runtimeId}`: Runtime ID
- `${configPath}`: 配置文件路径
- `${configDir}`: 配置文件所在目录

示例：
```json
{
  "launcher": {
    "afterStart": [
      "echo 'Runtime ${runtimeId} started'",
      "node ${configDir}/scripts/notify.mjs"
    ]
  }
}
```

## 高级用法

### 1. 多环境部署

为不同环境创建不同配置：

```bash
deployments/
├── ppt-dev.json          # 开发环境
├── ppt-staging.json      # 测试环境
└── ppt-prod.json         # 生产环境
```

### 2. 批量部署

```bash
#!/bin/bash
for config in deployments/*.json; do
  dsh-deploy start "$config"
done
```

### 3. CI/CD 集成

```yaml
# .github/workflows/deploy.yml
jobs:
  deploy:
    steps:
      - name: Deploy
        run: |
          node packages/dsh-suite-kit/bin/dsh-deploy.mjs validate deploy-prod.json
          node packages/dsh-suite-kit/bin/dsh-deploy.mjs start deploy-prod.json
```

### 4. 配置模板

使用 JSON Schema 验证 + VSCode 自动补全：

```json
{
  "$schema": "./deployment.schema.json",
  // VSCode 会提供字段提示和验证
}
```

## 与现有系统对比

| 功能 | 手动部署 | dsh-runtime | dsh-deploy (新) |
|---|---|---|---|
| 配置管理 | 分散 | 命令行参数 | ✅ 统一配置文件 |
| 启动流程 | 手动多步 | 单命令 | ✅ 一键部署 |
| 钩子支持 | ❌ | ❌ | ✅ before/after 钩子 |
| 健康检查 | 手动 | ❌ | ✅ 自动检查 + 重试 |
| 状态追踪 | ❌ | runtime.json | ✅ 部署状态文件 |
| 多环境 | 难管理 | 需记忆参数 | ✅ 配置文件区分 |
| 版本控制 | ❌ | ❌ | ✅ 配置可版本化 |

## 未来扩展

- [ ] 自动重启机制（进程监控）
- [ ] 指标采集和监控集成
- [ ] 配置热更新（无需重启）
- [ ] 多实例负载均衡
- [ ] 蓝绿部署 / 金丝雀发布
- [ ] Docker / K8s 部署支持
- [ ] Web 管理界面

## 最佳实践

1. **配置版本控制**: 将 `deployment-*.json` 纳入 Git 管理
2. **环境隔离**: 不同环境使用不同配置文件
3. **健康检查**: 生产环境必须启用健康检查
4. **钩子脚本**: 将复杂逻辑放到独立脚本，钩子只调用脚本
5. **日志管理**: 指定明确的日志文件路径
6. **端口规划**: 使用端口范围避免冲突
7. **元数据完善**: 添加 owner/tags 便于管理

## 故障排查

### 部署失败

```bash
# 1. 验证配置
dsh-deploy validate config.json

# 2. 查看详细状态
dsh-deploy status config.json

# 3. 手动测试源路径
node packages/dsh-suite-kit/bin/dsh-domain.mjs validate <source>

# 4. 查看 runtime 日志
cat ~/.dsh-store/runtimes/<runtime-id>/logs/runtime.log
```

### 健康检查失败

```bash
# 手动检查端口
curl http://127.0.0.1:39312/healthz

# 查看 runtime 状态
node packages/dsh-suite-kit/bin/dsh-runtime.mjs doctor <runtime-id>
```

## 参考资料

- 配置 Schema: `packages/dsh-suite-kit/deployment.schema.json`
- 配置示例: `packages/dsh-suite-kit/examples/deployment-*.json`
- 启动器源码: `packages/dsh-suite-kit/bin/dsh-deploy.mjs`
- Domain 规范: `packages/dsh-suite-kit/README.md`
