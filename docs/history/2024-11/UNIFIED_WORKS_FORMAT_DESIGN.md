# 🎨 统一作品格式系统 - 部署配置作品化

**目标**: 让部署配置成为平台上的"作品"，使用统一的 `.works` 格式，支持版本化、分享、依赖管理和自动安装。

---

## 📋 核心概念

### 1. 统一表达语言

所有"配方"都使用 `.works` 格式：

```
%%%WORKS-META%%%
{
  "name": "作品名称",
  "brief": "简短描述",
  "tags": "标签1,标签2",
  "emoji": "🚀",
  "view": { "kind": "deployment|code|app|..." },
  "capabilities": ["capability1", "capability2"],
  "requires": { /* 依赖声明 */ },
  "schema_version": "1.0.0"
}

%%%WORKS-CODE%%%
{
  /* 作品内容（JSON 或代码） */
}
```

### 2. 作品类型扩展

在现有 `WORK_TYPES` 注册表中新增类型：

| 类型 | 说明 | 示例 |
|---|---|---|
| `deployment` | 部署配置 | PPT工作台部署 |
| `workflow` | 工作流定义 | CI/CD流程 |
| `recipe` | 配方/食谱 | 自动化脚本组合 |
| `template` | 模板 | 项目脚手架 |
| `plugin` | 插件 | DSH插件包 |

### 3. 作品生命周期

```
创建 → 编辑 → 审核 → 发布 → 使用 → fork → 更新 → 归档
  ↓      ↓      ↓      ↓      ↓      ↓      ↓      ↓
版本化   私有   待审   公开   安装   衍生   迭代   下线
```

---

## 🏗️ 系统架构

### 1. 作品存储结构

```python
# 在 app/models.py 扩展 Work 模型
class Work(Base):
    __tablename__ = "works"
    
    id: int
    user_id: int
    title: str
    brief: str
    tags: str
    emoji: str
    
    # 新增字段
    work_type: str  # 'deployment', 'workflow', 'recipe', etc.
    schema_version: str  # '1.0.0'
    capabilities: JSON  # ['deployment.dsh', ...]
    requires: JSON  # 依赖声明
    content_meta: JSON  # %%%WORKS-META%%% 部分
    content_code: JSON | Text  # %%%WORKS-CODE%%% 部分
    
    # 现有字段
    visibility: str
    status: str  # 'draft', 'pending', 'approved', 'archived'
    created_at: datetime
    updated_at: datetime
    deleted_at: datetime | None
```

### 2. Adapter 注册

```python
# app/services/works/adapters/deployment.py
class DeploymentWorkAdapter(WorkAdapter):
    """部署配置作品适配器"""
    
    type_name = "deployment"
    model = Work
    
    def validate_content(self, meta: dict, code: dict) -> bool:
        """验证部署配置格式"""
        # 检查必需字段
        required_fields = ['deployment', 'runtime']
        return all(field in code for field in required_fields)
    
    def resolve_dependencies(self, work: Work, db) -> list:
        """解析依赖"""
        requires = work.requires or {}
        deps = []
        
        # 解析 components 依赖
        for comp in requires.get('components', []):
            dep = self._find_component(comp, db)
            if dep:
                deps.append(dep)
        
        return deps
    
    def install(self, work: Work, target_path: str) -> bool:
        """安装部署配置"""
        # 生成 .json 文件
        config = self._build_config(work)
        config_path = os.path.join(target_path, f"{work.id}.json")
        
        with open(config_path, 'w') as f:
            json.dump(config, f, indent=2)
        
        return True
    
    def execute(self, work: Work, db) -> dict:
        """执行部署"""
        # 调用 dsh-deploy
        import subprocess
        result = subprocess.run(
            ['node', 'packages/dsh-suite-kit/bin/dsh-deploy.mjs', 
             'start', f'{work.id}.json'],
            capture_output=True,
            text=True
        )
        return {
            'success': result.returncode == 0,
            'stdout': result.stdout,
            'stderr': result.stderr
        }

# 注册到 WORK_TYPES
WORK_TYPES['deployment'] = DeploymentWorkAdapter()
```

### 3. API 端点

```python
# app/routers/works/deployments.py
from fastapi import APIRouter, Depends
from app.services.works.adapters.deployment import DeploymentWorkAdapter

router = APIRouter(prefix="/api/works/deployments", tags=["deployments"])

@router.post("/")
async def create_deployment_work(
    data: CreateDeploymentRequest,
    db = Depends(get_db),
    user = Depends(get_current_user)
):
    """创建部署配置作品"""
    work = Work(
        user_id=user.id,
        work_type='deployment',
        title=data.name,
        brief=data.brief,
        content_meta=data.meta,
        content_code=data.code,
        requires=data.requires
    )
    db.add(work)
    db.commit()
    return work_response(work, db)

@router.get("/{work_id}/dependencies")
async def get_dependencies(
    work_id: int,
    db = Depends(get_db)
):
    """获取依赖树"""
    work = get_work_or_404(db, work_id)
    adapter = DeploymentWorkAdapter()
    deps = adapter.resolve_dependencies(work, db)
    return {"dependencies": deps}

@router.post("/{work_id}/install")
async def install_deployment(
    work_id: int,
    target: str,
    db = Depends(get_db),
    user = Depends(get_current_user)
):
    """安装部署配置"""
    work = get_work_or_404(db, work_id)
    adapter = DeploymentWorkAdapter()
    
    # 检查依赖
    deps = adapter.resolve_dependencies(work, db)
    missing = [d for d in deps if not d.is_installed]
    
    if missing:
        return {
            "success": False,
            "missing_dependencies": [d.title for d in missing]
        }
    
    # 安装
    success = adapter.install(work, target)
    return {"success": success}

@router.post("/{work_id}/execute")
async def execute_deployment(
    work_id: int,
    db = Depends(get_db),
    user = Depends(get_current_user)
):
    """执行部署"""
    work = get_work_or_404(db, work_id)
    check_work_edit(db, work, user)
    
    adapter = DeploymentWorkAdapter()
    result = adapter.execute(work, db)
    
    return result
```

---

## 🔄 工作流程

### 1. 创建部署配置作品

```bash
# 用户在平台上创建
POST /api/works/deployments
{
  "name": "PPT工作台部署",
  "brief": "标准PPT工作台部署配置",
  "meta": {
    "emoji": "🚀",
    "tags": "部署,PPT",
    "capabilities": ["deployment.dsh"]
  },
  "code": {
    "deployment": { ... },
    "runtime": { ... }
  },
  "requires": {
    "runtime": "dsh-suite-kit@>=1.0.0",
    "components": ["ppt-bridge/domains/ppt"]
  }
}

# 返回
{
  "id": 12345,
  "ref": "WORKS-12345",
  "title": "PPT工作台部署",
  "status": "draft"
}
```

### 2. 审核和发布

```bash
# 提交审核
POST /api/works/12345/review

# 审核通过，发布
POST /api/works/12345/approve

# 作品状态变为 'approved'，对社区可见
```

### 3. 搜索和浏览

```bash
# 搜索部署配置
GET /api/works/deployments?q=PPT&tags=部署

# 返回列表
{
  "items": [
    {
      "id": 12345,
      "ref": "WORKS-12345",
      "title": "PPT工作台部署",
      "emoji": "🚀",
      "author": "张三",
      "stars": 42,
      "forks": 5
    }
  ]
}
```

### 4. 检查依赖

```bash
# 获取依赖树
GET /api/works/12345/dependencies

# 返回
{
  "dependencies": [
    {
      "ref": "WORKS-11111",
      "title": "dsh-suite-kit",
      "version": "1.0.0",
      "installed": true
    },
    {
      "ref": "WORKS-22222",
      "title": "ppt-bridge",
      "version": "2.2.0",
      "installed": false  // ⚠️ 缺失
    }
  ]
}
```

### 5. 自动安装依赖

```bash
# 安装作品（自动安装依赖）
POST /api/works/12345/install
{
  "target": "/path/to/workspace",
  "auto_install_deps": true
}

# 返回
{
  "success": true,
  "installed": [
    "WORKS-22222",  // 自动安装了缺失的依赖
    "WORKS-12345"
  ],
  "files": [
    "/path/to/workspace/deployments/WORKS-12345.json"
  ]
}
```

### 6. 执行部署

```bash
# 执行部署
POST /api/works/12345/execute

# 返回
{
  "success": true,
  "runtime_id": "rt-ppt-prod-12345",
  "urls": {
    "harness": "http://127.0.0.1:3080/",
    "content": "http://127.0.0.1:39311/"
  }
}
```

---

## 🤖 AI Agent 集成

### 场景 1: Agent 任务自动检查依赖

```python
# app/services/agents/task_executor.py
class TaskExecutor:
    def execute_task(self, task: dict, db):
        """执行任务前自动检查依赖"""
        
        # 1. 解析任务需要的能力
        required_caps = task.get('requires_capabilities', [])
        
        # 2. 检查本地是否有对应的"配方"
        missing = []
        for cap in required_caps:
            work = self.find_work_by_capability(cap, db)
            if not work:
                missing.append(cap)
            elif not self.is_installed(work):
                missing.append(work.ref)
        
        # 3. 提示或自动安装
        if missing:
            if task.get('auto_install', False):
                for ref in missing:
                    self.install_work(ref, db)
            else:
                return {
                    "error": "缺少依赖",
                    "missing": missing,
                    "suggestion": f"请先安装: {', '.join(missing)}"
                }
        
        # 4. 执行任务
        return self.run_task(task)
```

### 场景 2: Agent 对话中推荐配方

```
User: 帮我部署一个PPT工作台

Agent: 我找到了一个现成的部署配方:

📦 PPT工作台部署 (WORKS-12345) ⭐ 42
   作者: 张三 | 最后更新: 2天前
   
   这个配方包含:
   ✓ 完整的PPT编辑器
   ✓ 18个AI工具
   ✓ 8个专业技能包
   
   需要安装以下依赖:
   • dsh-suite-kit (已安装 ✓)
   • ppt-bridge (未安装 ⚠️)
   
   我可以帮你:
   1. [一键安装并部署] - 自动安装依赖 + 启动服务
   2. [查看配置详情] - 先看看配置内容
   3. [Fork后修改] - 基于这个配方创建你的版本

请选择...
```

---

## 📦 本地缓存机制

### 1. 配方缓存结构

```bash
~/.dsh-store/
├── works/                    # 作品缓存
│   ├── WORKS-12345/
│   │   ├── meta.json        # 元数据
│   │   ├── content.json     # 内容
│   │   ├── dependencies.json # 依赖树
│   │   └── installed        # 安装标记
│   └── WORKS-22222/
│       └── ...
├── deployments/             # 已安装的部署配置
│   ├── WORKS-12345.json
│   └── ...
└── registry.json            # 本地注册表
```

### 2. 注册表格式

```json
{
  "version": "1.0.0",
  "works": [
    {
      "ref": "WORKS-12345",
      "type": "deployment",
      "title": "PPT工作台部署",
      "version": "1.0.0",
      "installed": true,
      "installed_at": "2024-10-31T12:00:00Z",
      "capabilities": ["deployment.dsh", "deployment.domain"],
      "dependencies": ["WORKS-22222"]
    }
  ],
  "capabilities": {
    "deployment.dsh": ["WORKS-12345", "WORKS-56789"],
    "deployment.domain": ["WORKS-12345"]
  }
}
```

### 3. CLI 工具

```bash
# 安装作品
dsh-works install WORKS-12345

# 列出已安装的作品
dsh-works list

# 搜索作品
dsh-works search "PPT部署"

# 查看作品详情
dsh-works show WORKS-12345

# 检查依赖
dsh-works check WORKS-12345

# 更新作品
dsh-works update WORKS-12345

# 卸载作品
dsh-works uninstall WORKS-12345
```

---

## 🔗 与现有系统集成

### 1. dsh-deploy 集成

```javascript
// packages/dsh-suite-kit/bin/dsh-deploy.mjs
async function loadConfig(configPath) {
  // 支持 .json 和 .works 两种格式
  if (configPath.endsWith('.works')) {
    return loadWorksFormat(configPath);
  }
  return loadJsonFormat(configPath);
}

function loadWorksFormat(worksPath) {
  const content = fs.readFileSync(worksPath, 'utf-8');
  const [meta, code] = parseWorksFile(content);
  
  // 将 .works 格式转换为 deployment config
  return {
    name: meta.name,
    version: meta.schema_version,
    deployment: code.deployment,
    runtime: code.runtime,
    launcher: code.launcher,
    metadata: code.metadata
  };
}

function parseWorksFile(content) {
  const metaMatch = content.match(/%%%WORKS-META%%%\n([\s\S]+?)\n\n%%%WORKS-CODE%%%/);
  const codeMatch = content.match(/%%%WORKS-CODE%%%\n([\s\S]+)$/);
  
  const meta = JSON.parse(metaMatch[1]);
  const code = JSON.parse(codeMatch[1]);
  
  return [meta, code];
}
```

### 2. 作品引用

```javascript
// 支持通过作品引用启动
dsh-deploy start WORKS-12345

// 自动从本地缓存加载
// 如果本地没有，从平台下载
```

---

## 🎨 前端集成

### 1. 作品详情页

```vue
<template>
  <div class="work-detail deployment-work">
    <header>
      <h1>{{ work.emoji }} {{ work.title }}</h1>
      <div class="meta">
        <span class="author">@{{ work.author }}</span>
        <span class="stars">⭐ {{ work.stars }}</span>
        <span class="forks">🔱 {{ work.forks }}</span>
      </div>
    </header>
    
    <section class="preview">
      <h2>配置预览</h2>
      <CodeBlock :code="work.content_code" language="json" />
    </section>
    
    <section class="dependencies">
      <h2>依赖项</h2>
      <ul>
        <li v-for="dep in dependencies" :key="dep.ref">
          <router-link :to="`/works/${dep.ref}`">
            {{ dep.emoji }} {{ dep.title }}
          </router-link>
          <span v-if="dep.installed" class="badge success">✓ 已安装</span>
          <span v-else class="badge warning">⚠️ 未安装</span>
        </li>
      </ul>
    </section>
    
    <section class="actions">
      <button @click="install" :disabled="installing">
        <span v-if="!installed">📦 安装</span>
        <span v-else>✓ 已安装</span>
      </button>
      <button @click="execute" :disabled="!installed">
        🚀 执行部署
      </button>
      <button @click="fork">
        🔱 Fork
      </button>
    </section>
  </div>
</template>
```

### 2. 作品创建表单

```vue
<template>
  <form @submit.prevent="createWork">
    <h2>创建部署配置作品</h2>
    
    <input v-model="form.name" placeholder="作品名称" required />
    <textarea v-model="form.brief" placeholder="简短描述" required />
    <input v-model="form.tags" placeholder="标签（逗号分隔）" />
    <input v-model="form.emoji" placeholder="表情符号" />
    
    <h3>配置内容</h3>
    <CodeEditor v-model="form.code" language="json" />
    
    <h3>依赖声明</h3>
    <div v-for="(dep, i) in form.requires.components" :key="i">
      <input v-model="form.requires.components[i]" placeholder="组件路径或作品引用" />
      <button @click="removeDep(i)">删除</button>
    </div>
    <button @click="addDep">+ 添加依赖</button>
    
    <button type="submit">创建作品</button>
  </form>
</template>
```

---

## 📊 数据迁移

### 1. 现有 deployment.json 迁移为作品

```python
# scripts/migrate_deployments_to_works.py
def migrate_deployments():
    """将现有的 deployment-*.json 文件迁移为作品"""
    
    examples_dir = Path("packages/dsh-suite-kit/examples")
    
    for json_file in examples_dir.glob("deployment-*.json"):
        config = json.load(json_file.open())
        
        # 创建作品
        work = Work(
            user_id=1,  # system user
            work_type='deployment',
            title=config['name'],
            brief=config.get('description', ''),
            content_meta={
                "emoji": "🚀",
                "tags": "deployment",
                "view": {"kind": "deployment"}
            },
            content_code=config,
            requires=config.get('deployment', {}).get('source'),
            status='approved'
        )
        
        db.add(work)
        
        # 生成 .works 文件
        works_file = json_file.with_suffix('.works')
        write_works_format(works_file, work)
    
    db.commit()
```

---

## 🚀 实施路线图

### Phase 1: 基础设施（1-2周）
- [x] `.works` 格式解析器
- [ ] `DeploymentWorkAdapter` 实现
- [ ] 数据模型扩展
- [ ] 基础 API 端点

### Phase 2: 依赖管理（1周）
- [ ] 依赖解析算法
- [ ] 本地缓存机制
- [ ] CLI 工具 (`dsh-works`)

### Phase 3: 前端集成（1-2周）
- [ ] 作品详情页
- [ ] 创建/编辑表单
- [ ] 依赖树可视化

### Phase 4: AI Agent 集成（1周）
- [ ] 任务依赖自动检查
- [ ] 配方推荐
- [ ] 对话式安装

### Phase 5: 社区功能（1周）
- [ ] 审核流程
- [ ] Fork机制
- [ ] 评论和点赞

---

## 💡 最佳实践

1. **作品命名**: 清晰描述用途，如"PPT工作台-生产环境部署"
2. **依赖声明**: 明确列出所有依赖，包括版本要求
3. **文档完善**: 在 brief 和 code 注释中详细说明
4. **版本管理**: 重大变更创建新版本，向后兼容
5. **标签规范**: 使用统一的标签体系便于搜索

---

## 🎯 预期效果

### 用户体验
- ✅ 一键安装部署配置，无需手动编辑 JSON
- ✅ 自动检查和安装依赖
- ✅ 浏览社区优秀配置，快速上手
- ✅ Fork后定制化，降低学习成本

### 平台价值
- ✅ 配置也是作品，丰富平台内容
- ✅ 社区驱动的最佳实践沉淀
- ✅ 版本化管理，追踪变更历史
- ✅ 统一的表达语言，降低认知负担

### 技术优势
- ✅ 代码即作品，可复用可组合
- ✅ 依赖关系清晰，自动化程度高
- ✅ 与现有系统无缝集成
- ✅ 可扩展到其他类型（workflow, recipe, plugin等）

---

**下一步**: 开始实施 Phase 1，创建 `DeploymentWorkAdapter` 并集成到现有系统。
