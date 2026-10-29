# -*- coding: utf-8 -*-
"""HarmonyOS Sans SC 子集化：GB2312 全集 + ASCII + 常用标点/符号 -> woff2"""
import os
from fontTools import subset

HERE = os.path.dirname(os.path.abspath(__file__))
FONT_DIR = os.path.join(os.path.dirname(HERE), 'assets', 'fonts')

chars = set()
for c in range(0x20, 0x7F):                      # ASCII
    chars.add(chr(c))
for hi in range(0xB0, 0xF8):                     # GB2312 汉字
    for lo in range(0xA1, 0xFF):
        try:
            chars.add(bytes([hi, lo]).decode('gb2312'))
        except Exception:
            pass
for cp in list(range(0x3000, 0x303F)) + list(range(0xFF01, 0xFF5F)):  # 全角标点
    chars.add(chr(cp))
for cp in [0x00B0, 0x00B7, 0x00D7, 0x2014, 0x2018, 0x2019, 0x201C, 0x201D,  # °·×—''""
           0x2026, 0x2039, 0x203A, 0x2032, 0x2033, 0x2103, 0x2109,           # …‹›′″℃℉
           0x2190, 0x2191, 0x2192, 0x2193, 0x2600, 0x2602, 0x2713, 0x2715]:  # ←↑→↓ ☀ ☂ ✓ ✕
    chars.add(chr(cp))

text = ''.join(sorted(chars))
print('charset size:', len(chars))

for w in ['Light', 'Regular', 'Medium', 'Bold']:
    src = os.path.join(FONT_DIR, f'HarmonyOS_Sans_SC_{w}.ttf')
    dst = os.path.join(FONT_DIR, f'HarmonyOS_Sans_SC_{w}.woff2')
    subset.main([src, f'--text={text}', '--flavor=woff2', f'--output-file={dst}'])
    print(w, '->', os.path.getsize(dst) // 1024, 'KB')
