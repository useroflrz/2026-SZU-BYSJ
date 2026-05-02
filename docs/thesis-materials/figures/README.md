# 论文12图出图交付包

本目录对应“论文12图出图实施计划”的落地文件。

## 已完成内容

1. 统一数据字典：`00-data-dictionary.md`
2. 方法与架构图草稿（图2~图7）：
   - `diagrams/fig2-grid-column-structure.md`
   - `diagrams/fig3-adaptive-los-principle.md`
   - `diagrams/fig4-dual-render-switch.mmd`
   - `diagrams/fig5-system-architecture.mmd`
   - `diagrams/fig6-async-task-sequence.mmd`
   - `diagrams/fig7-boundary-terrain-same-source.mmd`
3. 实验统计图脚本（图10~图12）：
   - `scripts/generate_fig10_11_12.py`
   - 输出文件在 `output/`
4. 截图与合成模板（图1/图8/图9）：
   - `templates/fig1-capture-and-compose.md`
   - `templates/fig8-capture-and-compose.md`
   - `templates/fig9-capture-and-compose.md`
   - `templates/capture-checklist.csv`

## 一键生成（图10~图12）

在仓库根目录执行：

```powershell
python "docs/thesis-materials/figures/scripts/generate_fig10_11_12.py"
```

生成：

- `output/fig10-render-performance.png|svg`
- `output/fig11-end2end-stacked.png|svg`
- `output/fig12-confusion-matrix.png|svg`

## Mermaid 导出（图4~图7）

参考 `diagrams/README.md` 的 `mmdc` 命令导出到 `output/`。

## 终检顺序

1. 按 `templates/capture-checklist.csv` 完成图1/8/9素材采集与合成。
2. 导出图2~图7与图10~图12终稿到 `output/`。
3. 对照 `00-data-dictionary.md` 做图文一致性校对。
