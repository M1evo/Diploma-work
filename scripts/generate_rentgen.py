#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
==========================================================
 Генерация искажённых версий рентгеновского снимка
==========================================================

Берёт одно исходное изображение (рентген) и создаёт по 3 ухудшенных
версии для каждого из критериев: резкость, контрастность, артефакты.
Плюс копия оригинала. Всего 10 файлов в одной папке.

Имена файлов отражают тип и силу искажения:
    rentgen_original.png
    rentgen_sharpness_low.png      (blur radius ≈ 3.6)
    rentgen_sharpness_medium.png   (blur radius ≈ 7.2)
    rentgen_sharpness_high.png     (blur radius ≈ 10.8)
    rentgen_contrast_low.png       (factor 0.70)
    rentgen_contrast_medium.png    (factor 0.40)
    rentgen_contrast_high.png      (factor 0.10)
    rentgen_artifacts_low.png      (gaussian noise σ = 18)
    rentgen_artifacts_medium.png   (gaussian noise σ = 36)
    rentgen_artifacts_high.png     (gaussian noise σ = 54)

Зависимости:
    pip install Pillow numpy

Использование:
    python scripts/generate_rentgen.py <путь_к_исходному_изображению>

Пример:
    python scripts/generate_rentgen.py web/test_data/rentgen_source.jpg

Вывод:
    web/test_data/rentgen/<10 файлов>
"""

import argparse
import sys
from pathlib import Path

# Принудительно UTF-8 для stdout/stderr (Windows cp1251 иначе не печатает Unicode)
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')
    sys.stderr.reconfigure(encoding='utf-8')

import numpy as np
from PIL import Image, ImageEnhance, ImageFilter


# === Параметры искажений ===
# Три уровня для каждого критерия. Числа подобраны так, чтобы:
#   low    — деградация заметна только при внимательном просмотре
#   medium — явно хуже, но изображение остаётся читаемым
#   high   — сильно ухудшено, но узнать снимок ещё можно
LEVELS = {
    'sharpness': {                # Gaussian blur radius
        'low':    3.6,
        'medium': 7.2,
        'high':   10.8,
    },
    'contrast': {                 # ImageEnhance.Contrast factor (1=без, 0=серое)
        'low':    0.70,
        'medium': 0.40,
        'high':   0.10,
    },
    'artifacts': {                # Gaussian noise sigma
        'low':    18.0,
        'medium': 36.0,
        'high':   54.0,
    },
}

OUTPUT_SUBFOLDER = 'rentgen'
NOISE_SEED = 42


# === Функции искажений ===

def apply_blur(img: Image.Image, radius: float) -> Image.Image:
    if radius <= 0.001:
        return img.copy()
    return img.filter(ImageFilter.GaussianBlur(radius=radius))


def apply_contrast(img: Image.Image, factor: float) -> Image.Image:
    return ImageEnhance.Contrast(img).enhance(factor)


def apply_noise(img: Image.Image, sigma: float) -> Image.Image:
    if sigma <= 0.001:
        return img.copy()
    arr = np.asarray(img, dtype=np.float32)
    noise = np.random.normal(0.0, sigma, arr.shape).astype(np.float32)
    out = np.clip(arr + noise, 0, 255).astype(np.uint8)
    return Image.fromarray(out, img.mode)


PROCESSORS = {
    'sharpness': apply_blur,
    'contrast':  apply_contrast,
    'artifacts': apply_noise,
}


def main() -> None:
    parser = argparse.ArgumentParser(
        description='Генератор искажённых версий рентгеновского снимка.'
    )
    parser.add_argument(
        'input_image',
        help='Путь к исходному снимку (любой формат, читаемый PIL).',
    )
    parser.add_argument(
        '--out-root',
        default='web/test_data',
        help='Корневая папка с изображениями проекта (по умолчанию: web/test_data)',
    )
    args = parser.parse_args()

    src_path = Path(args.input_image)
    if not src_path.is_file():
        print(f'Ошибка: файл не найден: {src_path}', file=sys.stderr)
        sys.exit(1)

    src = Image.open(src_path).convert('RGB')

    out_dir = Path(args.out_root) / OUTPUT_SUBFOLDER
    out_dir.mkdir(parents=True, exist_ok=True)

    np.random.seed(NOISE_SEED)

    print('=' * 60)
    print('  Generating rentgen distortion set')
    print('=' * 60)
    print(f'  Source:   {src_path}  ({src.size[0]}×{src.size[1]} {src.mode})')
    print(f'  Output:   {out_dir.resolve()}')
    print()

    # 1. Оригинал.
    orig_path = out_dir / 'rentgen_original.png'
    src.save(orig_path, 'PNG')
    print(f'  [original]  → {orig_path.name}')

    # 2. По 3 уровня для каждого критерия.
    for crit, levels in LEVELS.items():
        proc = PROCESSORS[crit]
        for level_name, level_value in levels.items():
            out_img = proc(src, level_value)
            fname = f'rentgen_{crit}_{level_name}.png'
            out_img.save(out_dir / fname, 'PNG')
            print(f'  [{crit:9s}] {level_name:6s} (param={level_value})  → {fname}')

    print()
    print(f'  Сохранено: 10 файлов в {out_dir}')
    print('=' * 60)


if __name__ == '__main__':
    main()
