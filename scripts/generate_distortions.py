#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
==========================================================
 Генерация синтетического датасета для теста Брэдли-Терри
==========================================================

Берёт одно исходное изображение и накладывает на него возрастающую
деградацию по каждому из четырёх критериев (резкость, контрастность,
артефакты, общее качество). Получаем 10 уровней × 4 критерия =
40 изображений с известным ground-truth ранжированием.

Уровень 0 = оригинал (лучший), уровень 9 = самая сильная деградация
(худший). Между ними — монотонный градиент.

Зависимости:
    pip install Pillow numpy

Использование:
    python scripts/generate_distortions.py <путь_к_исходному_изображению>

Пример:
    python scripts/generate_distortions.py web/test_data/labeled/img_001.png

Вывод:
    web/test_data/synthetic/sharpness/img_0.png ... img_9.png
    web/test_data/synthetic/contrast/img_0.png  ... img_9.png
    web/test_data/synthetic/artifacts/img_0.png ... img_9.png
    web/test_data/synthetic/overall/img_0.png   ... img_9.png
    web/test_data/synthetic/ground_truth.json   (истинное ранжирование)
"""

import argparse
import json
import os
import sys
from pathlib import Path

# Принудительно UTF-8 для stdout/stderr (иначе Windows cp1251 не печатает Unicode)
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')
    sys.stderr.reconfigure(encoding='utf-8')

import numpy as np
from PIL import Image, ImageEnhance, ImageFilter

# === Параметры ===

N_LEVELS = 10                       # Уровень 0 (оригинал) … 9 (худший)
NOISE_SEED = 42                     # Воспроизводимость случайного шума
DEFAULT_OUT = 'web/test_data/synthetic'


# === Деградации по критериям ===

def degrade_sharpness(img: Image.Image, level: int) -> Image.Image:
    """
    Гауссово размытие. level=0 — без, level=9 — сильное (radius ≈ 10.8).
    Чем выше level, тем хуже резкость.
    """
    radius = level * 1.2
    if radius <= 0.001:
        return img.copy()
    return img.filter(ImageFilter.GaussianBlur(radius=radius))


def degrade_contrast(img: Image.Image, level: int) -> Image.Image:
    """
    Снижение контраста через ImageEnhance.Contrast.
    factor = 1.0 → без изменений; factor = 0.0 → полностью серое.
    На level=9 контраст снижается до ~0.10.
    """
    factor = max(0.10, 1.0 - level * 0.10)
    return ImageEnhance.Contrast(img).enhance(factor)


def degrade_artifacts(img: Image.Image, level: int) -> Image.Image:
    """
    Гауссов шум. level=0 — без, level=9 — сильный (σ ≈ 54).
    Шум добавляется к каждому каналу.
    """
    if level == 0:
        return img.copy()
    sigma = level * 6.0
    arr = np.asarray(img, dtype=np.float32)
    noise = np.random.normal(0.0, sigma, arr.shape).astype(np.float32)
    out = np.clip(arr + noise, 0, 255).astype(np.uint8)
    return Image.fromarray(out, img.mode)


def degrade_overall(img: Image.Image, level: int) -> Image.Image:
    """
    Композитная деградация: лёгкие blur + шум + потеря контраста сразу.
    Каждый аспект на уровне level/2 от полного, чтобы суммарная деградация
    шла монотонно от нуля до «всё плохо».
    """
    half = max(0, level // 2)
    out = degrade_sharpness(img, half)
    out = degrade_contrast(out, half)
    out = degrade_artifacts(out, half)
    return out


CRITERIA = {
    'sharpness': degrade_sharpness,
    'contrast': degrade_contrast,
    'artifacts': degrade_artifacts,
    'overall': degrade_overall,
}


# === Точка входа ===

def main() -> None:
    parser = argparse.ArgumentParser(
        description='Генерация синтетического датасета для теста BT.'
    )
    parser.add_argument(
        'input_image',
        help='Путь к исходному изображению (любой формат, читаемый PIL).',
    )
    parser.add_argument(
        '--out-root',
        default=DEFAULT_OUT,
        help=f'Корневая папка вывода (по умолчанию: {DEFAULT_OUT})',
    )
    args = parser.parse_args()

    src_path = Path(args.input_image)
    if not src_path.is_file():
        print(f'Ошибка: файл не найден: {src_path}', file=sys.stderr)
        sys.exit(1)

    src = Image.open(src_path).convert('RGB')

    out_root = Path(args.out_root)
    out_root.mkdir(parents=True, exist_ok=True)

    # Чёткий seed для воспроизводимости шума
    np.random.seed(NOISE_SEED)

    print('=' * 60)
    print('  Generating synthetic distortion dataset')
    print('=' * 60)
    print(f'  Source: {src_path}  ({src.size[0]}×{src.size[1]} {src.mode})')
    print(f'  Output: {out_root.resolve()}')
    print()

    ground_truth: dict = {}

    for crit_name, fn in CRITERIA.items():
        crit_dir = out_root / crit_name
        crit_dir.mkdir(parents=True, exist_ok=True)
        items = []
        for level in range(N_LEVELS):
            distorted = fn(src, level)
            out_path = crit_dir / f'img_{level}.png'
            distorted.save(out_path, 'PNG')
            items.append({
                'level': level,
                'rel_path': f'./synthetic/{crit_name}/img_{level}.png',
                # expected_rank: 1 = лучший, N = худший
                'expected_rank': level + 1,
            })
        ground_truth[crit_name] = items
        print(f'  [{crit_name:10s}]  {N_LEVELS} images → {crit_dir}')

    gt_path = out_root / 'ground_truth.json'
    gt_path.write_text(
        json.dumps(ground_truth, ensure_ascii=False, indent=2),
        encoding='utf-8',
    )

    print()
    print(f'  Ground truth: {gt_path}')
    print()
    print('  Done. Дальше:')
    print('    python scripts/run_bt_test.py')
    print('=' * 60)


if __name__ == '__main__':
    main()
