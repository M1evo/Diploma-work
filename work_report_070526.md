# Отчёт о работе — 07.05.2026

> Сводный лог всех изменений, выполненных за чат-сессию: реализация
> этапов 1–5б + 7 плана развития, дальнейшая UX-полировка и
> интерактивные улучшения визуализации.

---

## Содержание

1. [Раунд 1 — Реализация плана `implementation_plan.md`](#раунд-1)
2. [Раунд 2 — Многокритериальный флоу + страница BT + документация](#раунд-2)
3. [Раунд 3 — Сворачиваемая легенда, полноэкранный граф, лайтбокс](#раунд-3)
4. [Итоговая структура проекта](#итоговая-структура-проекта)
5. [Как запустить](#как-запустить)

---

## Раунд 1
### Реализация этапов 1–5б + 7 из `implementation_plan.md`

**Цель:** перевести проект с текстового лога на SQLite, добавить отмену,
многокритериальность, рейтинги Брэдли-Терри и страницу результатов с
графом.

#### 1.1. Конфигурация PHP

PHP 8.3.30 был установлен через winget в
`C:\Users\markt\AppData\Local\Microsoft\WinGet\Packages\PHP.PHP.8.3_…\`,
но без `php.ini` — расширения SQLite не были загружены.

**Действия:**
- Скопирован `php.ini-development` → `php.ini`.
- Раскомментированы строки:
  - `extension_dir = "ext"`
  - `extension=fileinfo`
  - `extension=pdo_sqlite`
  - `extension=sqlite3`

**Проверка:** `php -r "echo PDO::getAvailableDrivers();"` → `sqlite`.

#### 1.2. Слой работы с БД — `web/database.php` (NEW)

Класс `Database`:
- **Авто-инициализация** при первом запуске: создаются таблицы
  `assessors`, `criteria`, `sessions`, `comparisons`, `ratings`.
- **Сидинг 4 критериев**: «Общее качество», «Резкость», «Контрастность», «Артефакты».
- **PRAGMA**: `foreign_keys = ON`, `journal_mode = WAL`.
- **Методы**: `getOrCreateAssessor`, `createSession/endSession`,
  `addComparison` (возвращает id + порядковый номер),
  `undoComparison` (мягкое удаление с проверкой владельца),
  `getHistory` (последние 20 сравнений сессии),
  `getCriteria/getCriterion`,
  `getAllComparisons`, `computeBradleyTerry`, `getRatings`,
  `getAssessorGraph` (данные для force-graph),
  `makeBackup` + ротация (хранится 50 шт.),
  `getActiveComparisonsCount`.

**Bradley-Terry — алгоритм Зермело-Форда с регуляризацией:**

Константы:
```php
private const BT_SMOOTHING_LAMBDA   = 0.5;
private const BT_MAX_ITERATIONS     = 1000;
private const BT_CONVERGENCE_EPSILON = 1.0e-6;
```

Шаг обновления:
```
π_i ← (W_i + λ) / Σ_{j≠i} (n_ij + 2λ) / (π_i + π_j)
```

Регуляризация Лапласа: каждой паре `(i,j)` добавляется `2λ` виртуальных
встреч, каждому изображению — `λ` виртуальных побед. Это гарантирует:
- ни один `π_i` не обнулится;
- ни один `π_i` не уйдёт в ∞;
- алгоритм сходится даже на разреженных данных.

Ничьи учитываются как «0.5 победы каждому». Нормализация после каждой
итерации — `π_i ← π_i / mean(π)`.

#### 1.3. API — `web/api.php` (REWRITE)

Старые роуты `pair`, `vote`, `image` сохранены, добавлены:
- `GET ?action=criteria` — список критериев.
- `POST action=start_session` (legacy) — создать сессию по одному критерию.
- `POST action=end_session` — завершить + бэкап.
- `GET ?action=history&session_id=X` — история сессии.
- `GET ?action=ratings&criterion_id=X[&recompute=1]` — рейтинги BT.
- `GET ?action=graph&nickname=X&criterion_id=X` — граф сравнений.
- `GET ?action=assessors` — список оценщиков.

`POST vote` теперь пишет в SQLite (вместо `results.log`), возвращает
`{comparison_id, number, auto_backup}`. Автобэкап триггерится каждые
20 активных сравнений.

#### 1.4. Фронтенд

- **`web/index.html`** — добавлены экраны выбора критерия, графа, боковая
  панель истории. Подключён D3.js v7 через CDN.
- **`web/app.js`** — флоу `login → criteria → comparison/history →
  results`, force-directed граф D3 с драгом, зумом и тултипами.
- **`web/style.css`** — стили для карточек критериев, панели истории,
  графа.

**Тестирование (через `php -S 127.0.0.1:8765`):**
| Запрос | Результат |
|--------|-----------|
| `GET criteria` | 4 критерия ✓ |
| `POST start_session` | session_id=1, assessor создан ✓ |
| `GET pair` | пара изображений ✓ |
| `POST vote ×3` | номера инкрементируют ✓ |
| `GET history` | обратный порядок с `number` ✓ |
| `POST undo` | мягкое удаление ✓ |
| `GET ratings?recompute=1` | BT-рейтинги (победитель=1.85, ничья=0.87, проигравший=0.41) ✓ |
| `POST end_session` | бэкап `data/backups/backup_20260507_184753.sqlite` создан ✓ |

---

## Раунд 2
### Многокритериальный флоу, отдельная страница BT, документация

**Запросы пользователя:**
1. Графовое окно слишком маленькое — починить.
2. Добавить легенду графа.
3. Убрать выбор критерия ДО сравнений — сравнивать по каждому критерию
   в процессе.
4. Отдельная страница рейтингов BT.
5. Отдельный markdown-файл с описанием алгоритма.

#### 2.1. Размер графа и легенда

**Корень проблемы:** `#results-screen` имел `min-height: 100dvh`, но
не `height` — поэтому SVG с `height: 100%` не получал явных размеров
(SVG не растягивается по `min-height`).

**Фикс ([web/style.css](web/style.css)):**
```css
#results-screen { height: 100dvh; overflow: hidden; }
.graph-container { display: flex; flex: 1 1 auto; min-height: 0; }
#graph-svg { flex: 1 1 auto; }
```

**Легенда** — оверлей `<aside class="graph-legend glass">` с тремя
секциями: вершины (с примером маленького/большого круга), рёбра
(зелёная/жёлтая/красная линии), управление.

**ResizeObserver** в `ensureGraphResizeObserver()` —
[web/app.js](web/app.js) — следит за `.graph-container` и
перерисовывает граф при изменении размера.

#### 2.2. Многокритериальный флоу

**Архитектурное решение:** при логине создаётся **по одной сессии на
каждый критерий**. Один пользовательский «раунд» (одна пара) генерирует
4 сравнения — по одному в каждой сессии.

**Backend:**
- `Database::startAllSessions(int $assessorId): array` — возвращает
  `criterion_id => session_id`.
- `Database::getHistoryByAssessor(string $nickname, int $limit)` —
  объединённая история по всем критериям с тегом `criterion_name` и
  per-criterion `number`.
- `Database::getAssessorTotalCount(string $nickname)` — общий счётчик.
- `addComparison()` — нумерация теперь per-(assessor, criterion).

**API:**
- `POST action=start_all_sessions` — создаёт 4 сессии за раз.
- `POST action=end_sessions&session_ids=1,2,3,4` — массовое завершение.
- `GET ?action=history&nickname=X` — новая форма (legacy
  `session_id=X` сохранена).

**Frontend:**
- Экран выбора критерия удалён полностью.
- Под парой изображений теперь 4 ряда `.criterion-row`, каждый с
  тремя кнопками `A лучше / Равны / B лучше` (`btn-vote-mini`).
- Каждый клик — один отдельный `vote` запрос в свою сессию.
- Под рядами: `Следующая пара` (заблокирована, пока не оценены все 4)
  + индикатор `0 / 4 критериев оценено`.

#### 2.3. Отдельная страница рейтингов BT (`#bt-screen`)

- Кнопка `🏆` в шапке экрана сравнения.
- Введение с формулой `P(i > j) = πᵢ / (πᵢ + πⱼ)` и пояснением
  регуляризации.
- Селектор критерия + кнопка «Пересчитать».
- Сводные карточки: число изображений, число сравнений, разбивка по
  результатам, параметры алгоритма (`λ`, `ε`, `max_iter`).
- Таблица: ранг | превью | путь | π (BT) | полоса рейтинга | число
  сравнений.
- Backend: `GET ?action=bt_results&criterion_id=X` отдаёт всё одним
  JSON.

#### 2.4. Документация — `bradley_terry.md` (NEW)

Создан в корне проекта. Разделы:
1. Постановка задачи
2. Модель Брэдли-Терри (с учётом ничьих)
3. Итеративный алгоритм Зермело-Форда
4. Регуляризация (Laplace smoothing)
5. Нормализация
6. Реализация в проекте (с ссылками на файлы и константы)
7. Интерпретация результатов
8. Просмотр текущих результатов (UI и API)
9. Литература (Bradley-Terry 1952, Hunter 2004, Davidson 1970, Cattelan 2012)

**Тестирование (фрагмент):**
```
POST start_all_sessions       → 4 сессии созданы
4× vote по одной паре         → все номера = #1 (per-criterion)
2× vote по другой паре        → номера = #2
GET history?nickname=tester   → 6 элементов с criterion_name + number, total=6
POST undo comparison_id=3     → запись undone, number=null
GET bt_results?criterion_id=1 → корректные рейтинги
```

---

## Раунд 3
### Сворачиваемая легенда, полноэкранный граф, лайтбокс изображений

**Запросы пользователя:**
1. Свернуть легенду по кнопке → отображать как `ℹ` иконку снизу справа.
2. Кнопка «развернуть граф» — скрывает фильтры/статистику, и обратная.
3. Клик по изображению → лайтбокс на 80–90% экрана с фоном; колёсико —
   масштаб; перетаскивание ЛКМ — пан; кнопка закрытия.

#### 3.1. Сворачиваемая легенда

- Панель легенды переехала в **правый нижний угол** графа.
- В заголовке панели — кнопка `✕` («Свернуть»).
- При сворачивании показывается круглая FAB-кнопка `ℹ` (SVG-иконка info)
  на той же позиции; клик разворачивает обратно.
- Плавная анимация через `transform: scale(...) translateY(...)` +
  `opacity`.

CSS:
```css
.graph-legend { position: absolute; bottom: 14px; right: 14px; }
.graph-legend.collapsed { opacity: 0; transform: scale(0.85) translateY(8px); pointer-events: none; }
.legend-toggle-btn { opacity: 0; pointer-events: none; }
.legend-toggle-btn.visible { opacity: 1; pointer-events: auto; }
```

JS: `setLegendCollapsed(boolean)` — единая точка управления состоянием.

#### 3.2. Полноэкранный режим графа

- FAB `⛶` в правом верхнем углу графа.
- Тогглит `.graph-maximized` на `#results-screen`.
- При активном классе:
  - `.results-controls` — `display: none`
  - `.results-stats` — `display: none`
  - `.graph-container` — без отступов и без border-radius
- После переключения — `requestAnimationFrame(() => drawGraph(...))`
  для пересчёта центра force-симуляции под новый размер. Дополнительно
  срабатывает уже подключённый `ResizeObserver`.

#### 3.3. Лайтбокс изображений

HTML:
```html
<div id="lightbox" class="lightbox hidden" role="dialog" aria-modal="true">
    <button id="lightbox-close" class="lightbox-close">✕</button>
    <div class="lightbox-zoom-info" id="lightbox-zoom-info">100%</div>
    <div id="lightbox-viewport" class="lightbox-viewport">
        <img id="lightbox-img" alt="" draggable="false">
    </div>
    <div class="lightbox-hint">Колёсико — масштаб · перетаскивание ЛКМ — перемещение · Esc</div>
</div>
```

**Открытие:** клик по `<img id="img-left">` или `<img id="img-right">`.
Курсор: `zoom-in`. Изображение вписано в `90vw × 90vh` через
`object-fit: contain` + `transform`.

**Масштаб (колёсико):** `wheel`-listener с `passive: false`. Якорь
масштабирования у курсора:
```js
const r = newScale / lb.scale;
lb.tx = cx * (1 - r) + lb.tx * r;   // cx,cy — смещение курсора
lb.ty = cy * (1 - r) + lb.ty * r;   // от центра viewport
lb.scale = newScale;
```
Точка под курсором остаётся неподвижной при зуме. Диапазон 1×–8×; при
откате до 1× координаты сбрасываются.

**Пан (ЛКМ-drag):** активен только при `scale > 1`. `mousedown` на
`<img>`, `mousemove` и `mouseup` на `window` (чтобы пан не обрывался при
выходе курсора за край). Курсор: `grab` → `grabbing`.

**Закрытие:**
- Кнопка `✕` (фиксированно в правом верхнем углу окна)
- Клавиша `Esc` (обработчик добавлен в `handleKeyboard` ДО проверки
  активного экрана — закрывается с любого).

**Индикатор:** `100%`, `285%`, и т.д. в верхней части — обновляется
синхронно с трансформом.

---

## Итоговая структура проекта

```
Диплом/
├── bradley_terry.md             ← NEW (Раунд 2): описание алгоритма
├── work_report_070526.md        ← NEW (этот отчёт)
├── implementation_plan.md       ← исходный план (был у пользователя)
├── development_plan.md          ← исходный план развития
├── plan_c_details.md            ← (не трогали)
├── README.md                    ← (не трогали)
├── generate_test_data.py        ← (не трогали)
└── web/
    ├── api.php                  ← REWRITE: 11 endpoints
    ├── database.php             ← NEW (Раунд 1): класс БД, BT-алгоритм
    ├── index.html               ← REWRITE × 3 раунда
    ├── app.js                   ← REWRITE × 3 раунда
    ├── style.css                ← существенно расширен
    ├── data/                    ← создаётся автоматически на 1-м запуске
    │   ├── database.sqlite
    │   └── backups/
    └── test_data/               ← (не трогали)
```

### Изменённые/созданные файлы

| Файл | Статус | Что внутри |
|------|--------|------------|
| `web/database.php` | **NEW** | Класс `Database`, BT-алгоритм с регуляризацией |
| `web/api.php` | **REWRITE** | 11 эндпоинтов вместо 3 |
| `web/index.html` | **REWRITE** | 4 экрана: login, comparison (с 4 крит. рядами), results (граф+легенда+FAB), bt-screen; модал лайтбокса |
| `web/app.js` | **REWRITE** | Per-criterion voting, история, граф+легенда+fullscreen, лайтбокс с zoom/pan |
| `web/style.css` | **EXTEND** | +~700 строк: ряды критериев, история, BT-таблица, граф, FAB-кнопки, лайтбокс |
| `bradley_terry.md` | **NEW** | Документация по BT |
| `work_report_070526.md` | **NEW** | Этот отчёт |
| `<PHP_DIR>/php.ini` | **NEW** | Скопирован из `php.ini-development` + 4 раскомментированные строки |

### Реализованные этапы плана развития

| Этап | Статус | Где |
|------|--------|-----|
| 1. Миграция на SQLite | ✅ | `database.php`, схема `assessors/criteria/sessions/comparisons/ratings` |
| 2. Undo | ✅ | `undoComparison()`, мягкое удаление, Ctrl+Z |
| 3. Автобэкапы | ✅ | каждые 20 голосов + при `end_session` + ротация 50 шт. |
| 4. Многокритериальность | ✅ | 4 критерия + per-pair голосование по каждому |
| 5а. Elo-рейтинг | ⏸ | поле в схеме есть, реализация отложена (Раунд 1 был ограничен 5б) |
| 5б. Брэдли-Терри | ✅ | `computeBradleyTerry()` с λ=0.5 регуляризацией |
| 6. Умный выбор пар | ⏸ | (не входило в текущий объём) |
| 7. Страница результатов | ✅ | граф + страница BT |
| 8. IAA | ⏸ | (не входило в текущий объём) |

### Сверх плана

- Лайтбокс изображений (zoom-anchored-at-cursor + drag pan)
- Полноэкранный режим графа
- Сворачиваемая легенда
- Боковая панель истории с per-criterion нумерацией и просмотром пар
- Документация алгоритма BT отдельным markdown-файлом

---

## Как запустить

```powershell
cd "c:\Users\markt\Desktop\Учёба\Диплом\web"
php -S 127.0.0.1:8000 api.php
```

Открыть: <http://127.0.0.1:8000/>.

При первом запуске автоматически создаются:
- `web/data/database.sqlite` — БД с 4 предзаполненными критериями
- `web/data/backups/` — каталог для автобэкапов

### Базовый сценарий проверки в браузере

1. Логин по никнейму → автоматически создаются 4 сессии.
2. Под парой изображений — 4 ряда критериев. Кликнуть в каждом ряду
   `A лучше / Равны / B лучше`. После 4-го клика разблокируется
   `Следующая пара`.
3. Клик по изображению → лайтбокс. Колёсико для масштаба, ЛКМ-drag для
   пана. `Esc` или `✕` для закрытия.
4. История справа: каждая запись помечена тегом критерия и
   per-criterion номером; клик показывает пару (read-only); `↩` —
   отменить; `Ctrl+Z` — отменить последнюю.
5. `📊` в шапке → граф сравнений. Кнопка `⛶` — на весь экран.
   `ℹ`/`✕` — свернуть/развернуть легенду.
6. `🏆` в шапке → таблица рейтингов BT по выбранному критерию.

---

## Открытые вопросы

1. **Критерии оценки** — оставлены 4 стандартных. Если для медицинских
   снимков нужны другие формулировки — изменить через сидинг в
   `Database::seedCriteria()` или через прямую правку записей в
   таблице `criteria`.
2. **Библиотека графа** — D3.js v7 через CDN. Альтернативы (vis.js,
   Cytoscape) обсуждались, но не реализованы.
3. **Не реализованы этапы 5а (Elo), 6 (умный выбор пар), 8 (IAA)** —
   остались по плану на следующие раунды.
