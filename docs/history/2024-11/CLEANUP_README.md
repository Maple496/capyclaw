# 清理重复文件说明

## 当前状况

所有 DeepSeek Harness 相关项目已经**完整迁移**到 `deepseekharness_dev` 目录，但以下两个目录仍残留在 workplace 根目录：

- `<workplace>/dsh-ppt-bundle`
- `<workplace>/dsh-ppt-windows-bundle`

这两个目录无法自动删除，可能原因：
1. 当前 shell 工作目录在其中之一
2. 文件资源管理器正在浏览这些目录
3. 某些进程持有文件句柄

## 如何清理

### 方法一：运行清理脚本（推荐）

1. **关闭所有相关窗口**：
   - 关闭所有打开 `workplace` 或其子目录的文件资源管理器窗口
   - 关闭所有命令行/PowerShell/Git Bash 窗口
   - 停止任何可能使用这些目录的程序

2. **运行清理脚本**：
   - 双击 `cleanup-duplicates.bat`
   - 按提示操作

### 方法二：手动删除

1. 关闭所有相关窗口和进程（同上）

2. 打开新的文件资源管理器，导航到：
   ```
   <workplace>
   ```

3. 选中以下两个文件夹并删除：
   - `dsh-ppt-bundle`
   - `dsh-ppt-windows-bundle`

4. 如果仍然无法删除，重启计算机后再试

## 验证清理结果

清理完成后，workplace 根目录应该只包含 `deepseekharness_dev` 目录和其他无关项目。

运行以下命令验证：
```bash
cd <workplace>
ls -d */ | grep -E "(dsh|canvas|ppt|bridge)"
```

如果只显示 `deepseekharness_dev/`，说明清理成功。

## 重要提示

⚠️ **在清理之前**，已经确认：
- `deepseekharness_dev/bundles/` 中有完整的项目副本
- 文件大小完全一致（517MB 和 616MB）
- 所有文件都已成功复制

✅ 删除 workplace 根目录的副本**不会丢失任何数据**！

## 单一真源（Single Source of Truth）

清理完成后，`deepseekharness_dev` 将成为唯一的真实来源：

```
<repo>\
├── core-harness/          # 核心框架
├── bridges/               # 桥接服务
├── plugins/               # 插件
├── bundles/               # 发布包（包含 dsh-ppt-bundle 和 dsh-ppt-windows-bundle）
├── archives/              # 归档文件
├── scripts/               # 构建脚本
└── docs/                  # 文档
```

---

**创建时间**: 2026-10-29  
**状态**: 等待手动清理重复文件
