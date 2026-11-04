"""
DeploymentWorkAdapter - 部署配置作品适配器

集成到服务器端作品系统，支持部署配置的创建、管理、安装和执行。

安装到服务器：
    将此文件放到 app/services/works/adapters/deployment.py
    在 app/services/works/registry.py 中注册
"""

import json
import os
import subprocess
from pathlib import Path
from typing import Dict, List, Optional, Any

from app.models import Work
from app.services.works.adapters.base import WorkAdapter


class DeploymentWorkAdapter(WorkAdapter):
    """部署配置作品适配器"""
    
    type_name = "deployment"
    
    def validate_content(self, meta: Dict, code: Any) -> tuple[bool, Optional[str]]:
        """验证部署配置格式"""
        # 检查必需字段
        required_fields = ['deployment', 'runtime']
        
        if not isinstance(code, dict):
            return False, "CODE 段必须是 JSON 对象"
        
        for field in required_fields:
            if field not in code:
                return False, f"缺少必需字段: {field}"
        
        # 验证 deployment 配置
        deployment = code.get('deployment', {})
        if 'type' not in deployment or 'source' not in deployment:
            return False, "deployment 缺少 type 或 source 字段"
        
        # 验证 runtime 配置
        runtime = code.get('runtime', {})
        if 'driver' not in runtime:
            return False, "runtime 缺少 driver 字段"
        
        return True, None
    
    def resolve_dependencies(self, work: Work, db) -> List[Dict]:
        """解析依赖"""
        deps = []
        requires = work.requires or {}
        
        # 解析 components 依赖
        components = requires.get('components', [])
        for comp in components:
            # 检查是否为作品引用
            if comp.startswith('WORKS-') or comp.isdigit():
                dep_work = db.query(Work).filter(
                    Work.ref == comp
                ).first()
                
                if dep_work:
                    deps.append({
                        'ref': comp,
                        'title': dep_work.title,
                        'installed': dep_work.status == 'approved',
                        'type': 'work'
                    })
                else:
                    deps.append({
                        'ref': comp,
                        'title': comp,
                        'installed': False,
                        'missing': True,
                        'type': 'work'
                    })
            else:
                # 文件路径依赖
                deps.append({
                    'path': comp,
                    'installed': os.path.exists(comp),
                    'type': 'file'
                })
        
        # 解析 runtime 依赖
        runtime_req = requires.get('runtime')
        if runtime_req:
            deps.append({
                'name': 'dsh-suite-kit',
                'version': runtime_req,
                'installed': self._check_runtime_version(runtime_req),
                'type': 'runtime'
            })
        
        return deps
    
    def _check_runtime_version(self, version_req: str) -> bool:
        """检查 runtime 版本（简化实现）"""
        # TODO: 实际检查 dsh-suite-kit 版本
        return True
    
    def install(self, work: Work, target_path: str, db) -> tuple[bool, Optional[str]]:
        """安装部署配置"""
        try:
            # 生成 .works 文件
            works_content = self._generate_works_file(work)
            works_file = Path(target_path) / f"{work.ref}.works"
            
            os.makedirs(target_path, exist_ok=True)
            
            with open(works_file, 'w', encoding='utf-8') as f:
                f.write(works_content)
            
            return True, str(works_file)
        except Exception as e:
            return False, f"安装失败: {str(e)}"
    
    def _generate_works_file(self, work: Work) -> str:
        """生成 .works 文件内容"""
        meta = work.content_meta or {}
        code = work.content_code or {}
        
        # 补充默认 meta 字段
        if 'name' not in meta:
            meta['name'] = work.title
        if 'brief' not in meta:
            meta['brief'] = work.brief or ''
        if 'emoji' not in meta:
            meta['emoji'] = work.emoji or '📦'
        if 'view' not in meta:
            meta['view'] = {'kind': 'deployment'}
        
        meta_str = json.dumps(meta, ensure_ascii=False, indent=2)
        code_str = json.dumps(code, ensure_ascii=False, indent=2)
        
        return f"""%%%WORKS-META%%%
{meta_str}

%%%WORKS-CODE%%%
{code_str}
"""
    
    def execute(self, work: Work, db, options: Dict = None) -> Dict:
        """执行部署"""
        options = options or {}
        
        # 1. 检查依赖
        deps = self.resolve_dependencies(work, db)
        missing = [d for d in deps if not d.get('installed', False)]
        
        if missing and not options.get('skip_dep_check'):
            return {
                'success': False,
                'error': '存在未满足的依赖',
                'missing_dependencies': missing
            }
        
        # 2. 安装到临时目录
        import tempfile
        with tempfile.TemporaryDirectory() as tmpdir:
            success, result = self.install(work, tmpdir, db)
            
            if not success:
                return {
                    'success': False,
                    'error': result
                }
            
            works_file = result
            
            # 3. 调用 dsh-deploy
            try:
                cmd = ['node', 'packages/dsh-suite-kit/bin/dsh-deploy.mjs', 
                       'start', works_file]
                
                result = subprocess.run(
                    cmd,
                    capture_output=True,
                    text=True,
                    timeout=60
                )
                
                if result.returncode == 0:
                    # 解析输出获取 runtime ID 和 URL
                    output = result.stdout
                    runtime_id = self._extract_runtime_id(output)
                    urls = self._extract_urls(output)
                    
                    return {
                        'success': True,
                        'runtime_id': runtime_id,
                        'urls': urls,
                        'stdout': output
                    }
                else:
                    return {
                        'success': False,
                        'error': result.stderr or result.stdout,
                        'returncode': result.returncode
                    }
            except subprocess.TimeoutExpired:
                return {
                    'success': False,
                    'error': '部署超时'
                }
            except Exception as e:
                return {
                    'success': False,
                    'error': f'执行失败: {str(e)}'
                }
    
    def _extract_runtime_id(self, output: str) -> Optional[str]:
        """从输出中提取 runtime ID"""
        import re
        match = re.search(r'runtime ([rt-\w-]+)', output)
        return match.group(1) if match else None
    
    def _extract_urls(self, output: str) -> Dict[str, str]:
        """从输出中提取 URL"""
        import re
        urls = {}
        
        harness_match = re.search(r'Harness:\s*(http://[^\s]+)', output)
        if harness_match:
            urls['harness'] = harness_match.group(1)
        
        content_match = re.search(r'Content:\s*(http://[^\s]+)', output)
        if content_match:
            urls['content'] = content_match.group(1)
        
        return urls
    
    def get_display_data(self, work: Work, db) -> Dict:
        """获取展示数据"""
        code = work.content_code or {}
        deployment = code.get('deployment', {})
        runtime = code.get('runtime', {})
        
        return {
            'type': deployment.get('type'),
            'source': deployment.get('source'),
            'driver': runtime.get('driver', 'node'),
            'ports': runtime.get('ports', {}),
            'capabilities': work.content_meta.get('capabilities', []) if work.content_meta else []
        }


# 注册适配器
# 在 app/services/works/registry.py 中添加:
# from app.services.works.adapters.deployment import DeploymentWorkAdapter
# WORK_TYPES['deployment'] = DeploymentWorkAdapter()
