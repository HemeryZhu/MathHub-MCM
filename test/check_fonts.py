# -*- coding: utf-8 -*-
"""检查系统中可用的中文字体"""
import matplotlib.font_manager as fm

fonts = set(f.name for f in fm.fontManager.ttflist)
# 常见中文字体
cjk_fonts = [f for f in fonts if any(k in f for k in
    ['SimHei', 'SimSun', 'Microsoft YaHei', 'Hei', 'Song', 'Kai',
     'WenQuanYi', 'Noto Sans CJK', 'Noto Serif CJK', 'Source Han',
     'PingFang', 'Hiragino', 'AR PL', 'Droid Sans Fallback',
     'STHeiti', 'STSong', 'Arial Unicode'])]
print("所有字体数量:", len(fonts))
print("中文字体候选:")
for f in sorted(cjk_fonts):
    print("  ", f)

# 也列出所有字体看看
print("\n全部字体列表:")
for f in sorted(fonts):
    print("  ", f)