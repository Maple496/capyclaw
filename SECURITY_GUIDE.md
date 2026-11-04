# CapyClaw 插件安全配置指南

## 🔐 如何保护你的插件不被他人修改和发布

### 第一层：NPM 包所有权（核心保护）

#### 1. 发布后自动锁定
```bash
# 当你首次发布时
npm publish --access public

# 你的 NPM 账号自动成为 owner
# 其他人无法发布同名包
```

#### 2. 查看和管理 owner
```bash
# 查看谁可以发布这个包
npm owner ls @capyclaw/launchpad

# 输出示例：
# your-username <your-email@example.com>

# 添加信任的维护者（谨慎！）
npm owner add trusted-user @capyclaw/launchpad

# 移除维护者
npm owner rm untrusted-user @capyclaw/launchpad
```

#### 3. 包名保护
- ✅ `@capyclaw/launchpad` 一旦发布就属于你
- ✅ 别人无法创建同名包
- ✅ 即使删除包，24小时内也无法被他人占用

---

### 第二层：NPM 账号安全

#### 1. 启用双因素认证（必须！）

```bash
# 查看当前 2FA 状态
npm profile get

# 启用 2FA（用于登录和发布）
npm profile enable-2fa auth-and-writes

# 你需要：
# - 手机上的认证器 APP（Google Authenticator / Authy）
# - 每次发布时输入 6 位验证码
```

**为什么重要**：
- 即使密码泄露，攻击者也无法发布
- 必须有你的手机才能发布更新

#### 2. 使用强密码

```bash
# 修改密码
npm profile set password

# 密码建议：
# ✅ 至少 16 位
# ✅ 包含大小写字母、数字、特殊字符
# ✅ 使用密码管理器生成
```

#### 3. 定期检查登录活动

访问：https://www.npmjs.com/settings/your-username/tokens
- 查看所有 access tokens
- 撤销可疑的 token

---

### 第三层：使用 NPM 组织

#### 1. 创建组织（推荐）

```bash
# 创建 @capyclaw 组织
npm org create capyclaw

# 这样所有 @capyclaw/* 包都属于你的组织
```

#### 2. 组织权限设置

```bash
# 设置组织需要 2FA
npm org set capyclaw require-2fa true

# 查看组织成员
npm org ls capyclaw

# 邀请成员（可选）
npm org set capyclaw username developer

# 成员权限级别：
# - owner: 完全控制
# - admin: 管理成员和包
# - developer: 可以发布
# - readonly: 只读
```

---

### 第四层：GitHub 仓库保护

#### 1. 分支保护规则

在 GitHub 仓库设置中：

```
Settings → Branches → Add rule

规则配置：
☑ Require pull request reviews before merging
  └─ Required approvals: 1
☑ Require status checks to pass before merging
  └─ Require branches to be up to date
☑ Require conversation resolution before merging
☑ Include administrators
☑ Restrict who can push to matching branches
  └─ 只添加你自己
```

#### 2. 协作者管理

```
Settings → Collaborators and teams

权限级别：
- Read: 只能查看
- Triage: 可以管理 issues
- Write: 可以推送代码
- Maintain: 可以管理设置
- Admin: 完全控制

建议：不要随意添加 Write 或更高权限的协作者
```

#### 3. 保护 Secrets

```
Settings → Secrets and variables → Actions

添加 NPM_TOKEN：
- 只有你能看到这个值
- GitHub Actions 使用它自动发布
- 定期轮换（每 90 天）
```

---

### 第五层：自动化发布安全

#### 1. 使用 Access Token（而不是密码）

```bash
# 创建专用于 CI/CD 的 token
npm token create --cidr=0.0.0.0/0

# Token 类型：
# - Publish: 可以发布包
# - Read-only: 只能读取（用于下载依赖）

# 最佳实践：
# ✅ 为每个 CI/CD 系统创建独立 token
# ✅ 设置合理的过期时间
# ✅ 定期轮换 token
```

#### 2. GitHub Actions 配置

在 `.github/workflows/publish-plugins.yml` 中：

```yaml
# 只在打标签时触发
on:
  push:
    tags:
      - 'capyclaw-*-v*.*.*'
    branches-ignore:
      - '**'  # 不在普通推送时发布

# 使用环境保护
environment:
  name: production
  # 需要手动批准才能发布
```

#### 3. 环境保护规则

```
Settings → Environments → New environment

名称：production

Protection rules:
☑ Required reviewers
  └─ 添加你自己
☑ Wait timer: 5 minutes
  └─ 发布前等待 5 分钟，给你时间取消
```

---

### 第六层：包的不可变性

#### 1. 版本锁定

```bash
# 一旦发布某个版本，就无法修改
npm publish @capyclaw/launchpad@1.1.0

# 即使是 owner 也不能修改已发布的版本
# 只能发布新版本
```

#### 2. Deprecate（而不是删除）

```bash
# 如果版本有问题，标记为废弃
npm deprecate @capyclaw/launchpad@1.1.0 "请升级到 1.1.1"

# 不要 unpublish（会影响依赖它的用户）
```

---

### 第七层：监控和审计

#### 1. 设置发布通知

```bash
# NPM 会发邮件通知每次发布
# 检查邮箱：your-email@example.com

# 如果看到不是你发布的，立即：
npm owner rm suspicious-user @capyclaw/launchpad
npm token revoke <token-id>
```

#### 2. 定期审计

```bash
# 每月检查一次
npm owner ls @capyclaw/launchpad
npm token list

# 撤销不再使用的 token
npm token revoke <token-id>
```

#### 3. 使用 npm audit

```bash
# 检查依赖的安全问题
npm audit

# 自动修复
npm audit fix
```

---

## 🎯 推荐的完整配置

### 最小配置（必须做）

1. ✅ 启用 NPM 双因素认证
   ```bash
   npm profile enable-2fa auth-and-writes
   ```

2. ✅ 使用强密码

3. ✅ 定期检查 npm owners
   ```bash
   npm owner ls @capyclaw/launchpad
   ```

### 标准配置（推荐做）

4. ✅ 创建 NPM 组织
   ```bash
   npm org create capyclaw
   ```

5. ✅ 设置 GitHub 分支保护

6. ✅ 使用 access token 而不是密码

### 高级配置（最安全）

7. ✅ 配置 GitHub 环境保护规则

8. ✅ 设置发布审批流程

9. ✅ 定期轮换 tokens

---

## 🚨 如果账号被盗怎么办？

### 立即行动

1. **重置 NPM 密码**
   ```bash
   # 访问 https://www.npmjs.com/forgot
   ```

2. **撤销所有 tokens**
   ```bash
   npm token list
   npm token revoke <each-token-id>
   ```

3. **检查包的 owners**
   ```bash
   npm owner ls @capyclaw/launchpad
   # 移除可疑用户
   npm owner rm suspicious-user @capyclaw/launchpad
   ```

4. **联系 NPM 支持**
   - 邮件：support@npmjs.com
   - 说明情况，请求帮助

---

## 📝 安全检查清单

在首次发布前：

- [ ] 启用 NPM 双因素认证
- [ ] 创建 NPM 组织（@capyclaw）
- [ ] 设置强密码
- [ ] 配置 GitHub 分支保护
- [ ] 创建 NPM access token（用于 CI/CD）
- [ ] 将 token 添加到 GitHub Secrets
- [ ] 配置 GitHub Actions 工作流
- [ ] 测试发布流程

发布后每月检查：

- [ ] 检查 npm owners 列表
- [ ] 检查 npm tokens 列表
- [ ] 检查 GitHub 协作者
- [ ] 检查发布邮件通知
- [ ] 运行 npm audit

---

## 💡 常见问题

### Q: 如果我忘记密码怎么办？
A: 使用 NPM 的密码重置功能：https://www.npmjs.com/forgot

### Q: 我可以让朋友帮我发布吗？
A: 可以，但要谨慎：
```bash
npm owner add friend-username @capyclaw/launchpad
```
只添加完全信任的人，他们将有完全的发布权限。

### Q: GitHub 和 NPM 哪个更重要？
A: **NPM 更重要**！
- NPM 控制谁能发布包
- GitHub 只是代码托管
- 即使 GitHub 被入侵，攻击者也无法发布到 NPM（如果你启用了 2FA）

### Q: 使用组织是否需要付费？
A: 不需要！公开包的组织是免费的。

### Q: 如何撤销已发布的版本？
A: 不推荐撤销。改用 deprecate：
```bash
npm deprecate @capyclaw/launchpad@1.0.0 "有安全问题，请升级到 1.0.1"
```

---

## 🎉 总结

**核心原则**：
1. **NPM 账号是关键** - 启用 2FA 是必须的
2. **不要共享密码** - 使用 npm owner 管理权限
3. **使用 tokens** - 不要在 CI/CD 中使用密码
4. **定期审计** - 每月检查一次权限

**记住**：
- ✅ NPM 包名在发布后就被锁定
- ✅ 只有 owner 可以发布更新
- ✅ 启用 2FA 后，即使密码泄露也安全
- ✅ GitHub 只是代码托管，真正的控制在 NPM

---

**设置好这些后，你的插件就非常安全了！** 🔐
