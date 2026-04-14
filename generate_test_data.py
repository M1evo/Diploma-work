#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
==========================================================
 Генерация тестового датасета изображений
==========================================================

Скрипт создаёт иерархию папок с изображениями-заглушками
для тестирования рекурсивного обхода системы попарного
сравнения.

Типы генерируемых изображений:
  - Цветной шум (random noise)
  - Линейные градиенты
  - Номер файла на цветном фоне

Зависимости:
  pip install Pillow numpy

Использование:
  python generate_test_data.py
"""

import os
import random
import numpy as np
from PIL import Image, ImageDraw, ImageFont

# ============= КОНФИГУРАЦИЯ =============

# Корневая директория для генерации (относительно скрипта)
OUTPUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'web', 'test_data')

# Структура папок и количество изображений в каждой
FOLDER_STRUCTURE = {
    'noise':       20,   # Цветной шум
    'gradients':   20,   # Градиенты
    'labeled':     20,   # Номера на фоне
    'mixed/set_a': 15,   # Вложенная папка — микс
    'mixed/set_b': 15,   # Вложенная папка — микс
    'extra':       10,   # Дополнительные
}

# Размер генерируемых изображений (ширина × высота)
IMAGE_WIDTH  = 640
IMAGE_HEIGHT = 480

# ============= ГЕНЕРАТОРЫ ИЗОБРАЖЕНИЙ =============


def generate_noise_image(width: int, height: int) -> Image.Image:
    """
    Генерирует изображение с цветным шумом (RGB).
    Каждый пиксель получает случайное значение по каждому каналу.
    """
    noise = np.random.randint(0, 256, (height, width, 3), dtype=np.uint8)
    return Image.fromarray(noise, 'RGB')


def generate_gradient_image(width: int, height: int) -> Image.Image:
    """
    Генерирует изображение с линейным градиентом между двумя
    случайными цветами. Направление — горизонтальное.
    """
    # Два случайных цвета
    color_a = np.array([random.randint(0, 255) for _ in range(3)])
    color_b = np.array([random.randint(0, 255) for _ in range(3)])

    # Линейная интерполяция по горизонтали
    t = np.linspace(0.0, 1.0, width).reshape(1, width, 1)
    gradient = ((1 - t) * color_a + t * color_b).astype(np.uint8)

    # Растягиваем по вертикали
    img_array = np.broadcast_to(gradient, (height, width, 3)).copy()
    return Image.fromarray(img_array, 'RGB')


def generate_labeled_image(
    width: int,
    height: int,
    label: str
) -> Image.Image:
    """
    Генерирует изображение с текстовой меткой (номером файла)
    на случайном цветном фоне.
    """
    # Случайный цвет фона
    bg_color = tuple(random.randint(30, 220) for _ in range(3))

    img = Image.new('RGB', (width, height), bg_color)
    draw = ImageDraw.Draw(img)

    # Пытаемся использовать шрифт покрупнее, иначе — дефолтный
    try:
        font = ImageFont.truetype("arial.ttf", 72)
    except (IOError, OSError):
        try:
            font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", 72)
        except (IOError, OSError):
            font = ImageFont.load_default()

    # Вычисляем позицию текста (центр)
    bbox = draw.textbbox((0, 0), label, font=font)
    text_w = bbox[2] - bbox[0]
    text_h = bbox[3] - bbox[1]
    x = (width - text_w) // 2
    y = (height - text_h) // 2

    # Контрастный цвет текста
    luminance = 0.299 * bg_color[0] + 0.587 * bg_color[1] + 0.114 * bg_color[2]
    text_color = (255, 255, 255) if luminance < 128 else (0, 0, 0)

    # Тень для читаемости
    shadow_color = (0, 0, 0) if luminance < 128 else (180, 180, 180)
    draw.text((x + 3, y + 3), label, fill=shadow_color, font=font)
    draw.text((x, y), label, fill=text_color, font=font)

    return img


def generate_mixed_image(
    width: int,
    height: int,
    index: int
) -> Image.Image:
    """
    Генерирует случайный тип изображения (микс из трёх типов).
    Используется для вложенных папок, чтобы разнообразить датасет.
    """
    choice = random.choice(['noise', 'gradient', 'labeled'])
    if choice == 'noise':
        return generate_noise_image(width, height)
    elif choice == 'gradient':
        return generate_gradient_image(width, height)
    else:
        return generate_labeled_image(width, height, f"MIX-{index:03d}")


# ============= ОСНОВНАЯ ЛОГИКА =============


def main() -> None:
    """Точка входа: создание папок и генерация изображений."""
    total = 0

    print("=" * 56)
    print("  Test Dataset Generator")
    print("=" * 56)
    print(f"  Output directory: {OUTPUT_DIR}")
    print()

    for folder_name, count in FOLDER_STRUCTURE.items():
        folder_path = os.path.join(OUTPUT_DIR, folder_name)
        os.makedirs(folder_path, exist_ok=True)

        # Определяем тип генератора по имени папки
        folder_base = folder_name.split('/')[0]

        for i in range(1, count + 1):
            filename = f"img_{i:03d}.png"
            filepath = os.path.join(folder_path, filename)

            if folder_base == 'noise':
                img = generate_noise_image(IMAGE_WIDTH, IMAGE_HEIGHT)
            elif folder_base == 'gradients':
                img = generate_gradient_image(IMAGE_WIDTH, IMAGE_HEIGHT)
            elif folder_base == 'labeled':
                img = generate_labeled_image(IMAGE_WIDTH, IMAGE_HEIGHT, f"#{i:03d}")
            elif folder_base == 'extra':
                # Extra: генерируем шум с пониженным разрешением
                # для имитации «размытого» изображения
                small = generate_noise_image(IMAGE_WIDTH // 4, IMAGE_HEIGHT // 4)
                img = small.resize((IMAGE_WIDTH, IMAGE_HEIGHT), Image.NEAREST)
            else:
                img = generate_mixed_image(IMAGE_WIDTH, IMAGE_HEIGHT, i)

            img.save(filepath, 'PNG')
            total += 1

        print(f"  [OK] {folder_name:20s} -- {count} images")

    print()
    print(f"  Total generated: {total} images")
    print("=" * 56)
    print("  Done! Ready to start the web application.")
    print("=" * 56)


if __name__ == '__main__':
    main()
