# -*- coding: utf-8 -*-
"""
2024 国赛 C 题《农作物的种植策略》可视化
采用 nature-figure 风格：论文级图表、克制配色、清晰结论、完整单位
图表标签使用英文（符合 Nature 论文规范，避免中文字体缺失问题）
"""
import numpy as np
import pandas as pd
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import os

BASE = os.path.dirname(os.path.abspath(__file__))
RES = os.path.join(BASE, 'results')
FIG = os.path.join(BASE, 'figures')
os.makedirs(FIG, exist_ok=True)

# ============================================================
# nature-figure 风格配置
# ============================================================
plt.rcParams.update({
    'font.family': 'sans-serif',
    'font.sans-serif': ['DejaVu Sans', 'Arial', 'Helvetica'],
    'font.size': 9,
    'axes.titlesize': 10,
    'axes.labelsize': 9,
    'xtick.labelsize': 8,
    'ytick.labelsize': 8,
    'legend.fontsize': 8,
    'axes.linewidth': 0.8,
    'axes.edgecolor': '#333333',
    'axes.labelcolor': '#111111',
    'xtick.color': '#111111',
    'ytick.color': '#111111',
    'figure.dpi': 300,
    'savefig.dpi': 300,
    'savefig.bbox': 'tight',
    'axes.spines.top': False,
    'axes.spines.right': False,
    'axes.grid': True,
    'grid.color': '#DDDDDD',
    'grid.linewidth': 0.5,
    'grid.alpha': 0.6,
})

# 克制配色（Nature 风格）
C = {
    'blue': '#2166AC', 'red': '#B2182B', 'green': '#4DAF4A',
    'orange': '#E08214', 'purple': '#762A83', 'gray': '#999999',
    'lightblue': '#92C5DE', 'lightred': '#F4A582', 'dark': '#333333',
}
CAT_COLORS = {'Grain': C['blue'], 'Vegetable': C['green'], 'Mushroom': C['orange']}

# 作物类别映射（英文）
CAT_EN = {'粮食类': 'Grain', '蔬菜类': 'Vegetable', '食用菌': 'Mushroom'}

# 作物英文名映射
CROP_EN = {
    '小麦': 'Wheat', '玉米': 'Maize', '水稻': 'Rice', '大豆': 'Soybean',
    '花生': 'Peanut', '谷子': 'Millet', '高粱': 'Sorghum', '马铃薯': 'Potato',
    '白菜': 'Cabbage', '萝卜': 'Radish', '黄瓜': 'Cucumber', '番茄': 'Tomato',
    '茄子': 'Eggplant', '辣椒': 'Pepper', '豆角': 'Bean', '香菇': 'Shiitake',
    '平菇': 'Oyster mushroom', '羊肚菌': 'Morel',
}


# ============================================================
# 图1：问题1 年度利润对比（滞销 vs 降价）
# ============================================================
def fig1_yearly_profit():
    yp1w = pd.read_csv(os.path.join(RES, 'result1_1_年度利润.csv'))
    yp1d = pd.read_csv(os.path.join(RES, 'result1_2_年度利润.csv'))

    fig, ax = plt.subplots(figsize=(6.5, 4.2))
    years = yp1w['年份'].values
    width = 0.35
    x = np.arange(len(years))

    bars1 = ax.bar(x - width/2, yp1w['利润']/1e4, width, label='Waste (surplus discarded)',
                   color=C['lightred'], edgecolor=C['red'], linewidth=0.6)
    bars2 = ax.bar(x + width/2, yp1d['利润']/1e4, width, label='50% discount sale',
                   color=C['lightblue'], edgecolor=C['blue'], linewidth=0.6)

    ax.set_xticks(x)
    ax.set_xticklabels(years)
    ax.set_xlabel('Year')
    ax.set_ylabel('Annual profit (10,000 CNY)')
    ax.set_title('Q1: Annual profit under two surplus-handling policies (2024-2030)')
    ax.legend(frameon=False, loc='upper left')
    ax.axhline(0, color='#333333', linewidth=0.8)

    for bar in bars1:
        h = bar.get_height()
        ax.annotate(f'{h:.0f}', (bar.get_x() + bar.get_width()/2, h),
                    ha='center', va='bottom', fontsize=7, color=C['red'])
    for bar in bars2:
        h = bar.get_height()
        ax.annotate(f'{h:.0f}', (bar.get_x() + bar.get_width()/2, h),
                    ha='center', va='bottom', fontsize=7, color=C['blue'])

    fig.tight_layout()
    fig.savefig(os.path.join(FIG, 'fig1_Q1_yearly_profit.png'))
    plt.close(fig)
    print("fig1 saved")


# ============================================================
# 图2：问题1 各作物种植面积分布（降价模式）
# ============================================================
def fig2_crop_area():
    df = pd.read_csv(os.path.join(RES, 'result1_2_种植方案.csv'))
    df['类别EN'] = df['类别'].map(CAT_EN)
    df['作物EN'] = df['作物'].map(CROP_EN)
    cat_area = df.groupby('类别EN')['面积(亩)'].sum()
    crop_area = df.groupby('作物EN')['面积(亩)'].sum().sort_values()

    fig, axes = plt.subplots(1, 2, figsize=(9, 4.2))

    # 左：类别饼图
    ax1 = axes[0]
    colors = [CAT_COLORS[c] for c in cat_area.index]
    wedges, texts, autotexts = ax1.pie(
        cat_area.values, labels=cat_area.index, autopct='%1.1f%%',
        colors=colors, startangle=90, textprops={'fontsize': 8},
        wedgeprops={'edgecolor': 'white', 'linewidth': 1})
    for at in autotexts:
        at.set_fontsize(7)
        at.set_color('white')
    ax1.set_title('Planting area share by crop category')

    # 右：作物面积条形图
    ax2 = axes[1]
    crop_cat_map = dict(zip(df['作物EN'], df['类别EN']))
    colors2 = [CAT_COLORS[crop_cat_map[c]] for c in crop_area.index]
    ax2.barh(crop_area.index, crop_area.values, color=colors2,
             edgecolor='white', linewidth=0.5)
    ax2.set_xlabel('Planting area (mu)')
    ax2.set_title('Planting area by crop (Q1, discount mode)')
    ax2.grid(axis='x', alpha=0.4)

    fig.tight_layout()
    fig.savefig(os.path.join(FIG, 'fig2_Q1_crop_area.png'))
    plt.close(fig)
    print("fig2 saved")


# ============================================================
# 图3：问题2 蒙特卡洛利润分布
# ============================================================
def fig3_mc_distribution():
    mc2 = pd.read_csv(os.path.join(RES, 'result2_蒙特卡洛.csv'))

    fig, ax = plt.subplots(figsize=(6.5, 4.2))
    profits = mc2['profit'] / 1e4
    ax.hist(profits, bins=30, color=C['blue'], alpha=0.7,
            edgecolor='white', linewidth=0.5)
    mean_p = profits.mean()
    p5 = profits.quantile(0.05)
    p95 = profits.quantile(0.95)

    ax.axvline(mean_p, color=C['red'], linewidth=1.5, linestyle='--',
               label=f'Mean = {mean_p:.0f}')
    ax.axvline(p5, color=C['orange'], linewidth=1.2, linestyle=':',
               label=f'5th pct = {p5:.0f}')
    ax.axvline(p95, color=C['green'], linewidth=1.2, linestyle=':',
               label=f'95th pct = {p95:.0f}')

    ax.set_xlabel('Annual profit (10,000 CNY)')
    ax.set_ylabel('Frequency')
    ax.set_title('Q2: Profit distribution from Monte Carlo simulation (n=200)')
    ax.legend(frameon=False, loc='upper right')

    fig.tight_layout()
    fig.savefig(os.path.join(FIG, 'fig3_Q2_MC_distribution.png'))
    plt.close(fig)
    print("fig3 saved")


# ============================================================
# 图4：问题2 vs 问题3 风险收益对比
# ============================================================
def fig4_risk_return():
    mc2 = pd.read_csv(os.path.join(RES, 'result2_蒙特卡洛.csv'))
    mc3 = pd.read_csv(os.path.join(RES, 'result3_蒙特卡洛.csv'))

    fig, ax = plt.subplots(figsize=(6.5, 4.2))
    data = [
        ('Q2', mc2['profit'].mean()/1e4, mc2['profit'].std()/1e4, C['blue']),
        ('Q3', mc3['profit'].mean()/1e4, mc3['profit'].std()/1e4, C['red']),
    ]
    for name, mean, std, color in data:
        ax.scatter(std, mean, s=120, color=color, edgecolor='white',
                   linewidth=1.5, zorder=5, label=name)
        ax.errorbar(std, mean, xerr=std*0.05, fmt='none', color=color, alpha=0.5)

    ax.set_xlabel('Profit std (10,000 CNY) - Risk')
    ax.set_ylabel('Expected profit (10,000 CNY) - Return')
    ax.set_title('Q2 vs Q3: Risk-return trade-off')
    ax.legend(frameon=False, loc='lower right')

    for name, mean, std, color in data:
        ax.annotate(f'{name}\n(mu={mean:.0f}, sigma={std:.0f})',
                    (std, mean), textcoords='offset points',
                    xytext=(12, 8), fontsize=8, color=color)

    fig.tight_layout()
    fig.savefig(os.path.join(FIG, 'fig4_Q2vsQ3_risk_return.png'))
    plt.close(fig)
    print("fig4 saved")


# ============================================================
# 图5：问题2 vs 问题3 利润分布对比（箱线图）
# ============================================================
def fig5_distribution_compare():
    mc2 = pd.read_csv(os.path.join(RES, 'result2_蒙特卡洛.csv'))
    mc3 = pd.read_csv(os.path.join(RES, 'result3_蒙特卡洛.csv'))

    fig, ax = plt.subplots(figsize=(6.5, 4.2))
    data = [mc2['profit']/1e4, mc3['profit']/1e4]
    bp = ax.boxplot(data, labels=['Q2', 'Q3'], patch_artist=True,
                    widths=0.5, showfliers=False)
    colors = [C['blue'], C['red']]
    for patch, color in zip(bp['boxes'], colors):
        patch.set_facecolor(color)
        patch.set_alpha(0.6)
    for median in bp['medians']:
        median.set_color('white')
        median.set_linewidth(1.5)

    ax.set_ylabel('Annual profit (10,000 CNY)')
    ax.set_title('Q2 vs Q3: Profit distribution comparison')
    ax.grid(axis='y', alpha=0.4)

    fig.tight_layout()
    fig.savefig(os.path.join(FIG, 'fig5_Q2vsQ3_distribution.png'))
    plt.close(fig)
    print("fig5 saved")


# ============================================================
# 图6：问题3 相关性热力图
# ============================================================
def fig6_correlation():
    crop = pd.read_csv(os.path.join('data', '附件2_2023作物数据.csv'))
    crops = [CROP_EN[c] for c in crop['作物'].tolist()]
    n = len(crops)
    corr = np.eye(n)
    cat = dict(zip(crops, crop['类别'].map(CAT_EN)))
    for i, ci in enumerate(crops):
        for j, cj in enumerate(crops):
            if i == j:
                continue
            if cat[ci] == cat[cj]:
                corr[i, j] = 0.6
            else:
                corr[i, j] = -0.2
    corr = (corr + corr.T) / 2

    fig, ax = plt.subplots(figsize=(8, 7))
    im = ax.imshow(corr, cmap='RdBu_r', vmin=-1, vmax=1)
    ax.set_xticks(np.arange(n))
    ax.set_yticks(np.arange(n))
    ax.set_xticklabels(crops, rotation=90, fontsize=7)
    ax.set_yticklabels(crops, fontsize=7)
    ax.set_title('Q3: Assumed crop correlation matrix')

    cbar = fig.colorbar(im, ax=ax, shrink=0.8)
    cbar.set_label('Correlation coefficient')

    ax.set_xticks(np.arange(-0.5, n, 1), minor=True)
    ax.set_yticks(np.arange(-0.5, n, 1), minor=True)
    ax.grid(which='minor', color='white', linewidth=0.8)
    ax.tick_params(which='minor', length=0)

    fig.tight_layout()
    fig.savefig(os.path.join(FIG, 'fig6_Q3_correlation.png'))
    plt.close(fig)
    print("fig6 saved")


# ============================================================
# 图7：问题2 vs 问题3 各作物种植面积对比
# ============================================================
def fig7_crop_area_compare():
    df2 = pd.read_csv(os.path.join(RES, 'result2_种植方案.csv'))
    df3 = pd.read_csv(os.path.join(RES, 'result3_种植方案.csv'))

    area2 = df2.groupby('作物')['面积(亩)'].sum()
    area3 = df3.groupby('作物')['面积(亩)'].sum()
    all_crops = sorted(set(area2.index) | set(area3.index))
    all_crops_en = [CROP_EN.get(c, c) for c in all_crops]

    fig, ax = plt.subplots(figsize=(8, 4.5))
    x = np.arange(len(all_crops))
    width = 0.35
    a2 = [area2.get(c, 0) for c in all_crops]
    a3 = [area3.get(c, 0) for c in all_crops]

    ax.bar(x - width/2, a2, width, label='Q2', color=C['blue'], alpha=0.8)
    ax.bar(x + width/2, a3, width, label='Q3', color=C['red'], alpha=0.8)

    ax.set_xticks(x)
    ax.set_xticklabels(all_crops_en, rotation=45, ha='right', fontsize=7)
    ax.set_ylabel('Planting area (mu)')
    ax.set_title('Q2 vs Q3: Planting area by crop')
    ax.legend(frameon=False)

    fig.tight_layout()
    fig.savefig(os.path.join(FIG, 'fig7_Q2vsQ3_crop_area.png'))
    plt.close(fig)
    print("fig7 saved")


if __name__ == '__main__':
    print("Generating nature-figure style charts...")
    fig1_yearly_profit()
    fig2_crop_area()
    fig3_mc_distribution()
    fig4_risk_return()
    fig5_distribution_compare()
    fig6_correlation()
    fig7_crop_area_compare()
    print("\nAll figures generated in figures/")