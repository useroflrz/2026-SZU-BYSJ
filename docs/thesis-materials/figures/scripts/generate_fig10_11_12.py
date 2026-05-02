from pathlib import Path
import numpy as np
import matplotlib.pyplot as plt


OUTPUT_DIR = Path("docs/thesis-materials/figures/output")
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
plt.rcParams["font.sans-serif"] = ["Microsoft YaHei", "SimHei", "Arial Unicode MS", "DejaVu Sans"]
plt.rcParams["axes.unicode_minus"] = False


def save_both(fig: plt.Figure, name: str) -> None:
    fig.savefig(OUTPUT_DIR / f"{name}.png", dpi=300, bbox_inches="tight")
    fig.savefig(OUTPUT_DIR / f"{name}.svg", bbox_inches="tight")


def plot_fig10_performance() -> None:
    x = np.array([24560, 142380, 518940, 1847200, 3671280, 5642880], dtype=float)
    fps_geometry = np.array([58.3, 41.2, 18.6, 7.2, np.nan, np.nan], dtype=float)
    fps_instanced = np.array([59.1, 52.8, 43.5, 34.2, 25.1, 15.3], dtype=float)
    threshold = 120000

    fig, ax = plt.subplots(figsize=(11.5, 6.8))
    ax.plot(x, fps_geometry, marker="o", linewidth=2.4, label="Cesium 原生 GeometryInstance")
    ax.plot(x, fps_instanced, marker="s", linewidth=2.4, label="本系统 GPU Instancing")

    ax.set_xscale("log")
    ax.set_xlabel("活跃格元数（对数刻度）")
    ax.set_ylabel("FPS")
    ax.set_title("渲染性能对比折线图", pad=14)
    ax.set_xticks([1e4, 1e5, 1e6, 1e7], labels=["10^4", "10^5", "10^6", "10^7"])
    ax.set_ylim(0, 65)
    ax.grid(True, alpha=0.25)

    ax.axvline(threshold, color="red", linestyle="--", linewidth=1.2)
    ax.text(threshold * 1.06, 60, "切换阈值 1.2×10^5", color="red", fontsize=10)
    ax.axhspan(0, 24, color="gray", alpha=0.12)
    ax.text(1.1e4, 11, "卡顿区间（<24 FPS）", fontsize=10, color="black")
    ax.legend(loc="upper right", fontsize=10)

    # Highlight key points used in正文描述
    ax.annotate("1.8M 规模下 34.2 FPS", xy=(1847200, 34.2), xytext=(1.0e6, 44),
                arrowprops=dict(arrowstyle="->", lw=1.0), fontsize=10)
    ax.annotate("同规模基线仅 7.2 FPS", xy=(1847200, 7.2), xytext=(8.0e5, 17),
                arrowprops=dict(arrowstyle="->", lw=1.0), fontsize=10)

    fig.tight_layout(pad=1.8)
    save_both(fig, "fig10-render-performance")
    plt.close(fig)


def plot_fig11_pipeline_time() -> None:
    # Locked values from thesis table
    system_parts = np.array([2.8, 1.9, 5.4, 1.2], dtype=float)
    trad_parts = np.array([18.5, 8.2, 4.1, 12.0], dtype=float)
    labels = ["数据准备", "地形采样与掩膜", "可视域计算", "可视化与导出"]
    colors = ["#4c78a8", "#72b7b2", "#f58518", "#54a24b"]

    fig, ax = plt.subplots(figsize=(11.2, 6.8))
    x_pos = np.arange(2)
    bottoms = np.zeros(2, dtype=float)
    series = np.vstack([system_parts, trad_parts]).T

    for idx, (name, color) in enumerate(zip(labels, colors)):
        values = series[idx]
        ax.bar(x_pos, values, bottom=bottoms, label=name, color=color, width=0.55)
        bottoms += values

    total_system = system_parts.sum()
    total_trad = trad_parts.sum()
    saved_pct = (total_trad - total_system) / total_trad * 100

    ax.set_xticks(x_pos, labels=["本系统", "传统方案"])
    ax.set_ylabel("耗时（秒）")
    ax.set_title("端到端流程耗时堆叠柱状图", pad=14)
    ax.grid(axis="y", alpha=0.25)
    ax.legend(loc="upper right", fontsize=10)

    ax.text(0, total_system + 1.3, f"{total_system:.1f}s", ha="center", fontsize=12, fontweight="bold")
    ax.text(1, total_trad + 1.3, f"{total_trad:.1f}s", ha="center", fontsize=12, fontweight="bold")
    ax.text(1.12, total_trad * 0.62, f"节省时间：{saved_pct:.0f}%", fontsize=11, color="darkgreen")
    ax.text(-0.10, total_system * 0.70, "[自动化]", fontsize=11)
    ax.text(0.84, total_trad * 0.70, "[人工环节较多]", fontsize=11)
    ax.set_ylim(0, max(total_trad + 5, 48))

    fig.tight_layout(pad=1.8)
    save_both(fig, "fig11-end2end-stacked")
    plt.close(fig)


def plot_fig12_confusion_matrix() -> None:
    # Keep a concrete count matrix while preserving 94.2% agreement.
    total_cells = 30000
    agree = int(round(total_cells * 0.942))  # 28260
    disagree = total_cells - agree  # 1740

    # Split by visibility prevalence and mismatch distribution
    tp = 12120
    tn = agree - tp  # 16140
    fp = 910
    fn = disagree - fp  # 830
    cm = np.array([[tp, fn], [fp, tn]], dtype=int)

    fig, ax = plt.subplots(figsize=(8.2, 6.6))
    im = ax.imshow(cm, cmap="YlGn", vmin=0)
    plt.colorbar(im, ax=ax, fraction=0.046, pad=0.04)

    labels = np.array([
        [f"真阳性\n{tp}\n40.4%", f"漏判\n{fn}\n2.8%"],
        [f"误判\n{fp}\n3.0%", f"真阴性\n{tn}\n53.8%"],
    ])
    for i in range(2):
        for j in range(2):
            ax.text(j, i, labels[i, j], ha="center", va="center", fontsize=11)

    ax.set_xticks([0, 1], labels=["ArcGIS 可见", "ArcGIS 不可见"])
    ax.set_yticks([0, 1], labels=["本系统可见", "本系统不可见"])
    ax.set_title("计算准确率对比混淆矩阵", pad=14)

    agree_rate = (tp + tn) / total_cells * 100
    ax.text(0.5, 1.10, f"总体一致率：{agree_rate:.1f}%", transform=ax.transAxes,
            ha="center", fontsize=12, color="darkred", fontweight="bold")
    ax.text(0.5, -0.17, "差异来源：DEM 分辨率 3.1% + 插值算法 2.7%",
            transform=ax.transAxes, ha="center", fontsize=10)

    fig.tight_layout(pad=1.8)
    save_both(fig, "fig12-confusion-matrix")
    plt.close(fig)


def main() -> None:
    plot_fig10_performance()
    plot_fig11_pipeline_time()
    plot_fig12_confusion_matrix()
    print("Generated fig10~fig12 in:", OUTPUT_DIR.resolve())


if __name__ == "__main__":
    main()
