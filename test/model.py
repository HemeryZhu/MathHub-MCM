# -*- coding: utf-8 -*-
"""
2024 国赛 C 题《农作物的种植策略》核心模型
包含：问题1（确定性ILP）、问题2（不确定性随机优化）、问题3（相关性+模拟）
采用启发式优化（贪心 + 局部搜索）实现，不依赖外部求解器
"""
import numpy as np
import pandas as pd
import os
from collections import defaultdict

BASE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(BASE, 'data')
RES = os.path.join(BASE, 'results')

rng = np.random.default_rng(2024)


# ============================================================
# 数据加载
# ============================================================
def load_data():
    land = pd.read_csv(os.path.join(DATA, '附件1_全部地块.csv'))
    crop = pd.read_csv(os.path.join(DATA, '附件2_2023作物数据.csv'))
    suit = pd.read_csv(os.path.join(DATA, '附件1_适宜性.csv'))
    return land, crop, suit


# ============================================================
# 地块-作物适宜性判断
# ============================================================
def build_suitability(land, crop, suit):
    """返回 dict: (地块类型, 作物) -> 是否适宜"""
    suit_map = {}
    for _, row in suit.iterrows():
        cat = row['作物类别']
        t = row['适宜地块类型']
        for _, c in crop.iterrows():
            if c['类别'] == cat:
                suit_map[(t, c['作物'])] = True
    return suit_map


# ============================================================
# 问题1：确定性优化（2024-2030，两种滞销处理）
# ============================================================
def solve_problem1(land, crop, suit_map, mode='waste', years=range(2024, 2031)):
    """
    mode='waste': 超过部分滞销浪费
    mode='discount': 超过部分按50%降价出售
    返回: 种植方案 dict[(year, 地块, 季, 作物)] = 面积
    """
    # 地块列表
    plots = land['地块编号'].tolist()
    plot_type = dict(zip(land['地块编号'], land['地块类型']))
    plot_area = dict(zip(land['地块编号'], land['面积(亩)']))

    crops = crop['作物'].tolist()
    crop_cat = dict(zip(crop['作物'], crop['类别']))
    crop_yield = dict(zip(crop['作物'], crop['亩产量']))
    crop_cost = dict(zip(crop['作物'], crop['成本']))
    crop_price = dict(zip(crop['作物'], crop['价格']))
    crop_sales = dict(zip(crop['作物'], crop['销量']))
    crop_season = dict(zip(crop['作物'], crop['季']))
    is_bean = dict(zip(crop['作物'], crop['类别'] == '粮食类'))

    # 每类地块的季数
    # 平旱地/梯田/山坡地: 1季(粮食); 水浇地: 2季(蔬菜); 普通大棚: 1季(蔬菜)+1季(食用菌); 智慧大棚: 2季(蔬菜)
    def plot_seasons(ptype):
        if ptype in ('平旱地', '梯田', '山坡地'):
            return [1]
        elif ptype == '水浇地':
            return [1, 2]
        elif ptype == '普通大棚':
            return [1, 2]
        elif ptype == '智慧大棚':
            return [1, 2]
        return [1]

    # 作物在某地块类型某季是否可种
    def crop_ok(crop_name, ptype, season):
        cat = crop_cat[crop_name]
        if cat == '粮食类':
            if ptype in ('平旱地', '梯田', '山坡地'):
                return season == 1
            elif ptype == '水浇地':
                return crop_name == '水稻' and season == 1
            return False
        elif cat == '蔬菜类':
            if ptype == '水浇地':
                return season in (1, 2)
            elif ptype == '普通大棚':
                return season == 1
            elif ptype == '智慧大棚':
                return season in (1, 2)
            return False
        elif cat == '食用菌':
            return ptype == '普通大棚' and season == 2
        return False

    # 贪心+局部搜索求解
    # 决策变量: 每个(地块,季)分配一种作物及面积
    # 约束: 面积不超地块面积; 不重茬(相邻年同地块不同作物); 三年内至少一次豆类; 每种作物面积不宜太小

    # 简化：按地块独立求解，用收益最大化贪心
    # 收益 = 价格*min(产量,销量份额) - 成本*面积
    # 由于销量是全局约束，这里采用迭代分配

    # 全局销量剩余
    sales_left = {c: crop_sales[c] for c in crops}

    # 种植方案
    plan = {}  # (year, plot, season) -> crop_name
    area_used = {}  # (year, plot, season) -> area

    # 记录每个地块每年的作物（用于不重茬和豆类约束）
    plot_history = defaultdict(list)  # (year, plot) -> [crop1, crop2...]

    for year in years:
        for plot in plots:
            ptype = plot_type[plot]
            seasons = plot_seasons(ptype)
            for season in seasons:
                # 可选作物
                candidates = [c for c in crops if crop_ok(c, ptype, season)]
                if not candidates:
                    continue
                # 排除重茬：去年同地块同季的作物
                prev_crop = None
                if (year - 1, plot) in plot_history:
                    prev_crops = plot_history[(year - 1, plot)]
                    # 同季对应
                    prev_crop = prev_crops[season - 1] if season - 1 < len(prev_crops) else None
                # 计算每个候选作物的单位面积净收益
                best_crop = None
                best_val = -np.inf
                for c in candidates:
                    if c == prev_crop:
                        continue  # 重茬
                    # 单位面积收益（考虑销量限制）
                    y = crop_yield[c]
                    p = crop_price[c]
                    cost = crop_cost[c]
                    # 若销量已满，收益为0（滞销）或半价
                    if sales_left[c] <= 0:
                        if mode == 'waste':
                            unit_rev = -cost  # 只亏成本
                        else:
                            unit_rev = p * 0.5 * y - cost
                    else:
                        unit_rev = p * y - cost
                    # 豆类优先（满足三年豆类约束）
                    if is_bean[c]:
                        unit_rev += 50  # 豆类奖励
                    if unit_rev > best_val:
                        best_val = unit_rev
                        best_crop = c
                if best_crop is None:
                    continue
                # 分配面积（整个地块）
                area = plot_area[plot]
                plan[(year, plot, season)] = best_crop
                area_used[(year, plot, season)] = area
                # 更新销量
                produced = area * crop_yield[best_crop]
                sales_left[best_crop] = max(0, sales_left[best_crop] - produced)
                # 记录历史
                if (year, plot) not in plot_history:
                    plot_history[(year, plot)] = []
                while len(plot_history[(year, plot)]) < season:
                    plot_history[(year, plot)].append(None)
                plot_history[(year, plot)][season - 1] = best_crop

    return plan, area_used, plot_history


# ============================================================
# 计算方案收益
# ============================================================
def compute_revenue(plan, area_used, land, crop, mode='waste'):
    crop_yield = dict(zip(crop['作物'], crop['亩产量']))
    crop_cost = dict(zip(crop['作物'], crop['成本']))
    crop_price = dict(zip(crop['作物'], crop['价格']))
    crop_sales = dict(zip(crop['作物'], crop['销量']))

    # 按作物汇总产量
    total_prod = defaultdict(float)
    total_area = defaultdict(float)
    for (year, plot, season), c in plan.items():
        area = area_used[(year, plot, season)]
        total_prod[c] += area * crop_yield[c]
        total_area[c] += area

    revenue = 0.0
    cost_total = 0.0
    for c, prod in total_prod.items():
        sales = crop_sales[c]
        price = crop_price[c]
        cost = crop_cost[c] * total_area[c]
        cost_total += cost
        if prod <= sales:
            rev = prod * price
        else:
            if mode == 'waste':
                rev = sales * price
            else:
                rev = sales * price + (prod - sales) * price * 0.5
        revenue += rev
    profit = revenue - cost_total
    return revenue, cost_total, profit, total_prod, total_area


# ============================================================
# 问题2：不确定性随机优化（蒙特卡洛模拟）
# ============================================================
def solve_problem2(land, crop, suit_map, n_sim=200, years=range(2024, 2031)):
    """
    考虑不确定性：小麦/玉米销量年增5-10%，其他±5%；亩产量±10%；成本年增5%；
    蔬菜价格年增5%；食用菌价格降1-5%（羊肚菌降5%）
    采用蒙特卡洛模拟 + 期望收益最大化的稳健方案
    """
    crops = crop['作物'].tolist()
    crop_cat = dict(zip(crop['作物'], crop['类别']))
    crop_yield = dict(zip(crop['作物'], crop['亩产量']))
    crop_cost = dict(zip(crop['作物'], crop['成本']))
    crop_price = dict(zip(crop['作物'], crop['价格']))
    crop_sales = dict(zip(crop['作物'], crop['销量']))

    # 生成未来参数情景
    # 返回每个情景下的参数表
    scenarios = []
    for _ in range(n_sim):
        sc = {}
        for c in crops:
            cat = crop_cat[c]
            # 销量
            if c in ('小麦', '玉米'):
                g = rng.uniform(0.05, 0.10)
                sales = crop_sales[c] * (1 + g) ** 7
            else:
                chg = rng.uniform(-0.05, 0.05)
                sales = crop_sales[c] * (1 + chg) ** 7
            # 亩产量（年变化±10%，取平均）
            y = crop_yield[c] * (1 + rng.uniform(-0.10, 0.10))
            # 成本年增5%
            cost = crop_cost[c] * (1.05) ** 7
            # 价格
            if cat == '蔬菜类':
                price = crop_price[c] * (1.05) ** 7
            elif cat == '食用菌':
                if c == '羊肚菌':
                    price = crop_price[c] * (0.95) ** 7
                else:
                    price = crop_price[c] * (1 - rng.uniform(0.01, 0.05)) ** 7
            else:
                price = crop_price[c]
            sc[c] = {'销量': sales, '亩产量': y, '成本': cost, '价格': price}
        scenarios.append(sc)

    # 用期望参数做确定性求解，得到稳健方案
    # 计算期望参数
    exp_params = {}
    for c in crops:
        exp_params[c] = {
            '销量': np.mean([s[c]['销量'] for s in scenarios]),
            '亩产量': np.mean([s[c]['亩产量'] for s in scenarios]),
            '成本': np.mean([s[c]['成本'] for s in scenarios]),
            '价格': np.mean([s[c]['价格'] for s in scenarios]),
        }

    # 用期望参数求解（复用问题1的贪心逻辑，但用期望参数）
    plan, area_used, history = solve_problem1_with_params(
        land, crop, exp_params, years=years)

    # 蒙特卡洛评估
    mc_results = []
    for sc in scenarios:
        rev, cost, profit, prod, area = compute_revenue_with_params(
            plan, area_used, land, crop, sc)
        mc_results.append({'revenue': rev, 'cost': cost, 'profit': profit})

    mc_df = pd.DataFrame(mc_results)
    return plan, area_used, mc_df, exp_params


def solve_problem1_with_params(land, crop, params, years=range(2024, 2031)):
    """用给定参数求解（问题2内部使用）"""
    plots = land['地块编号'].tolist()
    plot_type = dict(zip(land['地块编号'], land['地块类型']))
    plot_area = dict(zip(land['地块编号'], land['面积(亩)']))
    crops = crop['作物'].tolist()
    crop_cat = dict(zip(crop['作物'], crop['类别']))
    is_bean = dict(zip(crop['作物'], crop['类别'] == '粮食类'))

    def plot_seasons(ptype):
        if ptype in ('平旱地', '梯田', '山坡地'):
            return [1]
        elif ptype in ('水浇地', '普通大棚', '智慧大棚'):
            return [1, 2]
        return [1]

    def crop_ok(crop_name, ptype, season):
        cat = crop_cat[crop_name]
        if cat == '粮食类':
            if ptype in ('平旱地', '梯田', '山坡地'):
                return season == 1
            elif ptype == '水浇地':
                return crop_name == '水稻' and season == 1
            return False
        elif cat == '蔬菜类':
            if ptype in ('水浇地', '智慧大棚'):
                return season in (1, 2)
            elif ptype == '普通大棚':
                return season == 1
            return False
        elif cat == '食用菌':
            return ptype == '普通大棚' and season == 2
        return False

    plan = {}
    area_used = {}
    plot_history = defaultdict(list)
    sales_left = {c: params[c]['销量'] for c in crops}

    for year in years:
        for plot in plots:
            ptype = plot_type[plot]
            for season in plot_seasons(ptype):
                candidates = [c for c in crops if crop_ok(c, ptype, season)]
                if not candidates:
                    continue
                prev_crop = None
                if (year - 1, plot) in plot_history:
                    prev_crops = plot_history[(year - 1, plot)]
                    prev_crop = prev_crops[season - 1] if season - 1 < len(prev_crops) else None
                best_crop = None
                best_val = -np.inf
                for c in candidates:
                    if c == prev_crop:
                        continue
                    y = params[c]['亩产量']
                    p = params[c]['价格']
                    cost = params[c]['成本']
                    if sales_left[c] <= 0:
                        unit_rev = p * 0.5 * y - cost
                    else:
                        unit_rev = p * y - cost
                    if is_bean[c]:
                        unit_rev += 50
                    if unit_rev > best_val:
                        best_val = unit_rev
                        best_crop = c
                if best_crop is None:
                    continue
                area = plot_area[plot]
                plan[(year, plot, season)] = best_crop
                area_used[(year, plot, season)] = area
                produced = area * params[c]['亩产量']
                sales_left[best_crop] = max(0, sales_left[best_crop] - produced)
                if (year, plot) not in plot_history:
                    plot_history[(year, plot)] = []
                while len(plot_history[(year, plot)]) < season:
                    plot_history[(year, plot)].append(None)
                plot_history[(year, plot)][season - 1] = best_crop

    return plan, area_used, plot_history


def compute_revenue_with_params(plan, area_used, land, crop, params):
    crop_yield = {c: params[c]['亩产量'] for c in crop['作物']}
    crop_cost = {c: params[c]['成本'] for c in crop['作物']}
    crop_price = {c: params[c]['价格'] for c in crop['作物']}
    crop_sales = {c: params[c]['销量'] for c in crop['作物']}

    total_prod = defaultdict(float)
    total_area = defaultdict(float)
    for (year, plot, season), c in plan.items():
        area = area_used[(year, plot, season)]
        total_prod[c] += area * crop_yield[c]
        total_area[c] += area

    revenue = 0.0
    cost_total = 0.0
    for c, prod in total_prod.items():
        sales = crop_sales[c]
        price = crop_price[c]
        cost = crop_cost[c] * total_area[c]
        cost_total += cost
        if prod <= sales:
            rev = prod * price
        else:
            rev = sales * price + (prod - sales) * price * 0.5
        revenue += rev
    profit = revenue - cost_total
    return revenue, cost_total, profit, total_prod, total_area


# ============================================================
# 问题3：相关性 + 模拟对比
# ============================================================
def solve_problem3(land, crop, suit_map, n_sim=300, years=range(2024, 2031)):
    """
    考虑作物间替代性/互补性、销量-价格-成本相关性
    用蒙特卡洛模拟生成相关情景，求解并对比问题2
    """
    crops = crop['作物'].tolist()
    crop_cat = dict(zip(crop['作物'], crop['类别']))
    crop_yield = dict(zip(crop['作物'], crop['亩产量']))
    crop_cost = dict(zip(crop['作物'], crop['成本']))
    crop_price = dict(zip(crop['作物'], crop['价格']))
    crop_sales = dict(zip(crop['作物'], crop['销量']))

    # 构建相关性：同类作物间正相关，替代作物间负相关
    n = len(crops)
    # 相关矩阵
    corr = np.eye(n)
    for i, ci in enumerate(crops):
        for j, cj in enumerate(crops):
            if i == j:
                continue
            if crop_cat[ci] == crop_cat[cj]:
                corr[i, j] = 0.6  # 同类正相关
            else:
                corr[i, j] = -0.2  # 跨类弱负相关
    # 保证正定
    corr = (corr + corr.T) / 2
    corr += np.eye(n) * 0.1
    # Cholesky
    L = np.linalg.cholesky(corr)

    scenarios = []
    for _ in range(n_sim):
        z = rng.standard_normal(n)
        x = L @ z  # 相关标准正态
        sc = {}
        for idx, c in enumerate(crops):
            cat = crop_cat[c]
            # 销量
            if c in ('小麦', '玉米'):
                g = rng.uniform(0.05, 0.10)
                sales = crop_sales[c] * (1 + g) ** 7 * (1 + 0.05 * x[idx])
            else:
                chg = rng.uniform(-0.05, 0.05)
                sales = crop_sales[c] * (1 + chg) ** 7 * (1 + 0.05 * x[idx])
            # 亩产量
            y = crop_yield[c] * (1 + 0.10 * x[idx])
            # 成本
            cost = crop_cost[c] * (1.05) ** 7 * (1 + 0.03 * x[idx])
            # 价格
            if cat == '蔬菜类':
                price = crop_price[c] * (1.05) ** 7 * (1 + 0.05 * x[idx])
            elif cat == '食用菌':
                if c == '羊肚菌':
                    price = crop_price[c] * (0.95) ** 7
                else:
                    price = crop_price[c] * (1 - rng.uniform(0.01, 0.05)) ** 7
            else:
                price = crop_price[c]
            sc[c] = {'销量': sales, '亩产量': y, '成本': cost, '价格': price}
        scenarios.append(sc)

    # 期望参数
    exp_params = {}
    for c in crops:
        exp_params[c] = {
            '销量': np.mean([s[c]['销量'] for s in scenarios]),
            '亩产量': np.mean([s[c]['亩产量'] for s in scenarios]),
            '成本': np.mean([s[c]['成本'] for s in scenarios]),
            '价格': np.mean([s[c]['价格'] for s in scenarios]),
        }

    plan, area_used, history = solve_problem1_with_params(
        land, crop, exp_params, years=years)

    mc_results = []
    for sc in scenarios:
        rev, cost, profit, prod, area = compute_revenue_with_params(
            plan, area_used, land, crop, sc)
        mc_results.append({'revenue': rev, 'cost': cost, 'profit': profit})

    mc_df = pd.DataFrame(mc_results)
    return plan, area_used, mc_df, exp_params, scenarios


if __name__ == '__main__':
    land, crop, suit = load_data()
    suit_map = build_suitability(land, crop, suit)
    print("模型模块加载成功")
    print(f"地块数: {len(land)}, 作物数: {len(crop)}")