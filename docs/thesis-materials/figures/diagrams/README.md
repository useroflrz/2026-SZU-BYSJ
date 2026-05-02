# 图2~图7草图文件说明

- `fig2-grid-column-structure.md`：图2手工建模说明（PPT/Blender）
- `fig3-adaptive-los-principle.md`：图3原理图构图说明
- `fig4-dual-render-switch.mmd`：图4 Mermaid 流程图源码
- `fig5-system-architecture.mmd`：图5 Mermaid 架构图源码
- `fig6-async-task-sequence.mmd`：图6 Mermaid 时序图源码
- `fig7-boundary-terrain-same-source.mmd`：图7 Mermaid 数据同源图源码

## Mermaid 导出命令（可选）

在安装 `@mermaid-js/mermaid-cli` 后，可在仓库根目录执行：

```powershell
npx -y @mermaid-js/mermaid-cli -i "docs/thesis-materials/figures/diagrams/fig4-dual-render-switch.mmd" -o "docs/thesis-materials/figures/output/fig4-dual-render-switch.svg"
npx -y @mermaid-js/mermaid-cli -i "docs/thesis-materials/figures/diagrams/fig5-system-architecture.mmd" -o "docs/thesis-materials/figures/output/fig5-system-architecture.svg"
npx -y @mermaid-js/mermaid-cli -i "docs/thesis-materials/figures/diagrams/fig6-async-task-sequence.mmd" -o "docs/thesis-materials/figures/output/fig6-async-task-sequence.svg"
npx -y @mermaid-js/mermaid-cli -i "docs/thesis-materials/figures/diagrams/fig7-boundary-terrain-same-source.mmd" -o "docs/thesis-materials/figures/output/fig7-boundary-terrain-same-source.svg"
```
