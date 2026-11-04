# Research & Experiments

本目录包含项目的实验性研究、基准测试和演化分析。

## 目录结构

### cases/
测试用例定义，用于验证各模块的功能和性能。

### evaluators/
评估器实现，执行测试用例并收集结果。

### results/
测试和评估结果输出。

## 使用方式

```bash
# 运行基准测试
node research/chain-bench.mjs

# 分析结果
node research/analyze-relay.mjs
```

## 注意事项

- 这是**实验代码**，不是生产代码
- 用于探索新想法、验证假设、性能测试
- 稳定后的功能会迁移到正式的 packages/ 或 extensions/
