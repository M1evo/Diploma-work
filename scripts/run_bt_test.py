#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
==========================================================
 Тест алгоритма Брэдли-Терри на синтетическом датасете
==========================================================

Читает ground_truth.json (произведённый generate_distortions.py),
для каждого критерия:
  1. Генерирует все C(N, 2) = 45 уникальных пар.
  2. На каждую пару даёт «идеальный» ответ исходя из истинного ранга
     (изображение с меньшим уровнем деградации лучше).
  3. Опционально с вероятностью --noise-prob инвертирует ответ
     (имитация ошибок оценщика).
  4. Запускает алгоритм Brэдли-Терри с регуляризацией Лапласа
     (тот же Zermelo-Ford, что в web/database.php — Database::computeBradleyTerry).
  5. Считает корреляцию Spearman ρ и Kendall τ между
     предсказанным и истинным ранжированием.

Зависимости:
    pip install numpy scipy

Использование:
    python scripts/run_bt_test.py
    python scripts/run_bt_test.py --noise-prob 0.10
    python scripts/run_bt_test.py --noise-prob 0.20 --seed 7
"""

import argparse
import itertools
import json
import sys
from pathlib import Path

# Принудительно UTF-8 для stdout/stderr (иначе Windows cp1251 не печатает Unicode)
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')
    sys.stderr.reconfigure(encoding='utf-8')

import numpy as np
from scipy.stats import spearmanr, kendalltau


# === Параметры BT — синхронизированы с web/database.php ===
SMOOTHING_LAMBDA = 0.5   # Laplace λ
MAX_ITER = 1000          # Максимум итераций Зермело-Форда
EPS = 1e-6               # Порог сходимости


# === Семантика знаков (как в проекте) ===
#   '<'  →  Image A (left)  лучше B
#   '>'  →  Image B (right) лучше A
#   '='  →  ничья
INVERT_SIGN = {'<': '>', '>': '<', '=': '='}


def bradley_terry(comparisons: list, n: int) -> np.ndarray:
    """
    Алгоритм Зермело-Форда с λ-регуляризацией.

    comparisons: list of (i, j, sign), где i, j ∈ [0, n) и i < j;
                 sign ∈ {'<', '>', '='}.
    Возвращает: π — массив длины n, нормированный так, что mean(π) = 1.
    """
    wins = np.zeros(n, dtype=np.float64)
    pair_count: dict = {}

    for i, j, sign in comparisons:
        if sign == '<':                # i (left) лучше j (right)
            wins[i] += 1.0
        elif sign == '>':              # j лучше i
            wins[j] += 1.0
        else:                          # ничья
            wins[i] += 0.5
            wins[j] += 0.5
        key = (i, j) if i < j else (j, i)
        pair_count[key] = pair_count.get(key, 0) + 1

    pi = np.ones(n, dtype=np.float64)
    lam = SMOOTHING_LAMBDA

    iters_used = MAX_ITER
    for it in range(MAX_ITER):
        new_pi = np.zeros(n, dtype=np.float64)
        for i in range(n):
            denom = 0.0
            for j in range(n):
                if i == j:
                    continue
                key = (i, j) if i < j else (j, i)
                n_ij = pair_count.get(key, 0) + 2 * lam
                denom += n_ij / (pi[i] + pi[j])
            new_pi[i] = (wins[i] + lam) / denom if denom > 0 else pi[i]

        m = new_pi.mean()
        if m > 0:
            new_pi /= m

        delta = float(np.max(np.abs(new_pi - pi)))
        pi = new_pi
        if delta < EPS:
            iters_used = it + 1
            break

    return pi, iters_used


def generate_oracle_comparisons(items: list, noise_prob: float,
                                rng: np.random.Generator) -> tuple[list, int]:
    """
    Генерирует все C(N, 2) пар. Для каждой пары даёт «идеальный» ответ
    на основе expected_rank (меньше = лучше). С вероятностью noise_prob
    инвертирует ответ.

    Возвращает (comparisons, flips).
    """
    n = len(items)
    rank = [item['expected_rank'] for item in items]
    out = []
    flips = 0
    for i, j in itertools.combinations(range(n), 2):
        if rank[i] < rank[j]:        # i лучше → A лучше → '<'
            ans = '<'
        elif rank[i] > rank[j]:      # j лучше → B лучше → '>'
            ans = '>'
        else:
            ans = '='
        if rng.random() < noise_prob and ans != '=':
            ans = INVERT_SIGN[ans]
            flips += 1
        out.append((i, j, ans))
    return out, flips


def predicted_ranks_from_pi(pi: np.ndarray) -> np.ndarray:
    """
    Принимает π (больше = лучше) и возвращает ранги (1 = лучший).
    """
    n = len(pi)
    order = np.argsort(-pi)              # индексы по убыванию π
    ranks = np.empty(n, dtype=np.int64)
    for r, idx in enumerate(order, start=1):
        ranks[idx] = r
    return ranks


def print_table(items: list, pi: np.ndarray, pred_rank: np.ndarray) -> None:
    true_rank = np.array([it['expected_rank'] for it in items])
    print(f'    Уровень  π          Pред.ранг  True ранг  ✓')
    print(f'    -------  ---------  ---------  ---------  -')
    for i, it in enumerate(items):
        ok = '✓' if pred_rank[i] == true_rank[i] else '✗'
        print(f'    {it["level"]:^7d}  {pi[i]:>9.4f}  {pred_rank[i]:>9d}  '
              f'{true_rank[i]:>9d}  {ok}')


def main() -> None:
    parser = argparse.ArgumentParser(
        description='Standalone-тест BT на синтетическом датасете.'
    )
    parser.add_argument(
        '--ground-truth',
        default='web/test_data/synthetic/ground_truth.json',
        help='Путь к ground_truth.json',
    )
    parser.add_argument(
        '--noise-prob', type=float, default=0.0,
        help='Вероятность инвертировать ответ (имитация ошибки оценщика)',
    )
    parser.add_argument(
        '--seed', type=int, default=42,
        help='Seed для генератора шума',
    )
    args = parser.parse_args()

    gt_path = Path(args.ground_truth)
    if not gt_path.is_file():
        print(f'Ошибка: ground_truth.json не найден: {gt_path}',
              file=sys.stderr)
        print('Сначала запусти generate_distortions.py.', file=sys.stderr)
        sys.exit(1)

    ground_truth = json.loads(gt_path.read_text(encoding='utf-8'))
    rng = np.random.default_rng(args.seed)

    print('=' * 64)
    print('  Bradley-Terry sanity test on synthetic dataset')
    print('=' * 64)
    print(f'  Ground truth: {gt_path}')
    print(f'  Noise probability per pair: {args.noise_prob:.2%}')
    print(f'  Seed: {args.seed}')
    print()

    summary = []
    for crit_name, items in ground_truth.items():
        n = len(items)
        comparisons, flips = generate_oracle_comparisons(
            items, args.noise_prob, rng
        )

        pi, iters = bradley_terry(comparisons, n)
        pred_rank = predicted_ranks_from_pi(pi)
        true_rank = np.array([it['expected_rank'] for it in items])

        rho, _ = spearmanr(pred_rank, true_rank)
        tau, _ = kendalltau(pred_rank, true_rank)
        exact = int(np.sum(pred_rank == true_rank))

        print(f'─── Критерий: {crit_name:10s} ─────────────────────────────')
        print(f'    Сравнений: {len(comparisons)}, инвертировано шумом: {flips}')
        print(f'    Сошёлся за {iters} итераций')
        print(f'    Spearman ρ = {rho:+.4f}    Kendall τ = {tau:+.4f}')
        print(f'    Точное совпадение рангов: {exact}/{n}')
        print()
        print_table(items, pi, pred_rank)
        print()

        summary.append((crit_name, rho, tau, exact, n))

    print('=' * 64)
    print('  Сводка:')
    print('=' * 64)
    print(f'  {"Критерий":12s}  {"Spearman ρ":>11s}  {"Kendall τ":>11s}  '
          f'{"Точно":>8s}')
    for name, rho, tau, exact, n in summary:
        print(f'  {name:12s}  {rho:>+11.4f}  {tau:>+11.4f}  {exact:>4d}/{n:<3d}')
    print()


if __name__ == '__main__':
    main()
