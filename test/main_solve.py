# -*- coding: utf-8 -*-
"""
2024 国赛 C 题《农作物的种植策略》主求解脚本
运行问题1、问题2、问题3，保存结果到 results/
"""
import numpy as np
import pandas as pd
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from model import (load_data, build_suitability, solve_problem1,
                   compute_revenue, solve_problem2, solve_problem3)

BASE = os.path.dirname(os.path.abspath(__file__))
RES = os.path.join(BASE, 'results')
os.makedirs(RES, exist_ok=True)

land, crop, suit = load_data()
suit_map = build_suitability(land, crop, suit)

print("=" * 60)
print("问题1：确定性优化（2024-2030）")
print("=" * 60)

# 情况1：超过部分滞销浪费
plan1_waste, area1_waste, hist1_waste = solve_problem1(land, crop, suit_map, mode='waste')
rev1w, cost1w, profit1w, prod1w, area1w = compute_revenue(plan1_waste, area1_waste, land, crop, mode='waste')
print(f"情况1（滞销浪费）: 总收入={rev1w:.0f}元, 总成本={cost1w:.0f}元, 总利润={profit1w:.0f}元")

# 情况2：超过部分按50%降价出售
plan1_disc, area1_disc, hist1_disc = solve_problem1(land, crop, suit_map, mode='discount')
rev1d, cost1d, profit1d, prod1d, area1d = compute_revenue(plan1_disc, area1_disc, land, crop, mode='discount')
print(f"情况2（降价出售）: 总收入={rev1d:.0f}元, 总成本={cost1d:.0f}元, 总利润={profit1d:.0f}元")

# 保存问题1结果
# 按年汇总
def plan_to_df(plan, area_used, land, crop):
    rows = []
    crop_cat = dict(zip(crop['作物'], crop['类别']))
    crop_yield = dict(zip(crop['作物'], crop['亩产量']))
    for (year, plot, season), c in plan.items():
        area = area_used[(year, plot, season)]
        rows.append({
            '年份': year, '地块': plot, '季': season, '作物': c,
            '类别': crop_cat[c], '面积(亩)': area,
            '产量(kg)': area * crop_yield[c]
        })
    return pd.DataFrame(rows)

df1_waste = plan_to_df(plan1_waste, area1_waste, land, crop)
df1_disc = plan_to_df(plan1_disc, area1_disc, land, crop)
df1_waste.to_csv(os.path.join(RES, 'result1_1_种植方案.csv'), index=False, encoding='utf-8-sig')
df1_disc.to_csv(os.path.join(RES, 'result1_2_种植方案.csv'), index=False, encoding='utf-8-sig')

# 按年利润汇总
def yearly_profit(plan, area_used, land, crop, mode):
    crop_yield = dict(zip(crop['作物'], crop['亩产量']))
    crop_cost = dict(zip(crop['作物'], crop['成本']))
    crop_price = dict(zip(crop['作物'], crop['价格']))
    crop_sales = dict(zip(crop['作物'], crop['销量']))
    years = sorted(set(k[0] for k in plan.keys()))
    rows = []
    for year in years:
        prod = {}
        area = {}
        for (y, plot, season), c in plan.items():
            if y != year:
                continue
            a = area_used[(y, plot, season)]
            prod[c] = prod.get(c, 0) + a * crop_yield[c]
            area[c] = area.get(c, 0) + a
        rev = 0
        cost = 0
        for c, p in prod.items():
            cost += crop_cost[c] * area[c]
            if p <= crop_sales[c]:
                rev += p * crop_price[c]
            else:
                if mode == 'waste':
                    rev += crop_sales[c] * crop_price[c]
                else:
                    rev += crop_sales[c] * crop_price[c] + (p - crop_sales[c]) * crop_price[c] * 0.5
        rows.append({'年份': year, '收入': rev, '成本': cost, '利润': rev - cost})
    return pd.DataFrame(rows)

yp1w = yearly_profit(plan1_waste, area1_waste, land, crop, 'waste')
yp1d = yearly_profit(plan1_disc, area1_disc, land, crop, 'discount')
yp1w.to_csv(os.path.join(RES, 'result1_1_年度利润.csv'), index=False, encoding='utf-8-sig')
yp1d.to_csv(os.path.join(RES, 'result1_2_年度利润.csv'), index=False, encoding='utf-8-sig')
print("\n问题1年度利润（情况1）:")
print(yp1w.to_string(index=False))
print("\n问题1年度利润（情况2）:")
print(yp1d.to_string(index=False))

print("\n" + "=" * 60)
print("问题2：不确定性随机优化（蒙特卡洛模拟）")
print("=" * 60)
plan2, area2, mc2, exp2 = solve_problem2(land, crop, suit_map, n_sim=200)
print(f"问题2蒙特卡洛模拟结果 (n={len(mc2)}):")
print(f"  期望利润: {mc2['profit'].mean():.0f} 元")
print(f"  利润标准差: {mc2['profit'].std():.0f} 元")
print(f"  利润5%分位: {mc2['profit'].quantile(0.05):.0f} 元")
print(f"  利润95%分位: {mc2['profit'].quantile(0.95):.0f} 元")

df2 = plan_to_df(plan2, area2, land, crop)
df2.to_csv(os.path.join(RES, 'result2_种植方案.csv'), index=False, encoding='utf-8-sig')
mc2.to_csv(os.path.join(RES, 'result2_蒙特卡洛.csv'), index=False, encoding='utf-8-sig')

print("\n" + "=" * 60)
print("问题3：相关性 + 模拟对比")
print("=" * 60)
plan3, area3, mc3, exp3, scenarios3 = solve_problem3(land, crop, suit_map, n_sim=300)
print(f"问题3蒙特卡洛模拟结果 (n={len(mc3)}):")
print(f"  期望利润: {mc3['profit'].mean():.0f} 元")
print(f"  利润标准差: {mc3['profit'].std():.0f} 元")
print(f"  利润5%分位: {mc3['profit'].quantile(0.05):.0f} 元")
print(f"  利润95%分位: {mc3['profit'].quantile(0.95):.0f} 元")

df3 = plan_to_df(plan3, area3, land, crop)
df3.to_csv(os.path.join(RES, 'result3_种植方案.csv'), index=False, encoding='utf-8-sig')
mc3.to_csv(os.path.join(RES, 'result3_蒙特卡洛.csv'), index=False, encoding='utf-8-sig')

# 保存问题2 vs 问题3 对比
compare = pd.DataFrame({
    '指标': ['期望利润(元)', '利润标准差(元)', '5%分位(元)', '95%分位(元)', 'CVaR5%(元)'],
    '问题2': [
        mc2['profit'].mean(), mc2['profit'].std(),
        mc2['profit'].quantile(0.05), mc2['profit'].quantile(0.95),
        mc2['profit'][mc2['profit'] <= mc2['profit'].quantile(0.05)].mean()
    ],
    '问题3': [
        mc3['profit'].mean(), mc3['profit'].std(),
        mc3['profit'].quantile(0.05), mc3['profit'].quantile(0.95),
        mc3['profit'][mc3['profit'] <= mc3['profit'].quantile(0.05)].mean()
    ],
})
compare.to_csv(os.path.join(RES, '问题2vs3对比.csv'), index=False, encoding='utf-8-sig')
print("\n问题2 vs 问题3 对比:")
print(compare.to_string(index=False))

print("\n全部求解完成，结果已保存到 results/ 目录")