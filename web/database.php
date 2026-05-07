<?php
/**
 * ==========================================================
 *  Слой работы с SQLite базой данных
 * ==========================================================
 *
 *  Класс Database инкапсулирует:
 *   - Инициализацию БД (создание схемы при первом запуске)
 *   - CRUD-операции: ассессоры, сессии, сравнения, рейтинги
 *   - Реализацию модели Брэдли-Терри с регуляризацией
 *   - Автоматические бэкапы
 */

declare(strict_types=1);

class Database
{
    private PDO $pdo;
    private string $dbPath;
    private string $backupDir;

    /** Коэффициент сглаживания для регуляризации Брэдли-Терри (Laplace smoothing). */
    private const BT_SMOOTHING_LAMBDA = 0.5;

    /** Максимум итераций алгоритма Зермело-Форда. */
    private const BT_MAX_ITERATIONS = 1000;

    /** Порог сходимости итеративного алгоритма. */
    private const BT_CONVERGENCE_EPSILON = 1e-6;

    /** Сколько последних сравнений показывать в истории. */
    public const HISTORY_LIMIT = 20;

    /** Сколько бэкапов хранить. */
    private const BACKUP_RETENTION = 50;

    public function __construct(string $dbPath, string $backupDir)
    {
        $this->dbPath = $dbPath;
        $this->backupDir = $backupDir;

        $needsInit = !is_file($dbPath);

        $dataDir = dirname($dbPath);
        if (!is_dir($dataDir)) {
            mkdir($dataDir, 0775, true);
        }
        if (!is_dir($backupDir)) {
            mkdir($backupDir, 0775, true);
        }

        $this->pdo = new PDO(
            'sqlite:' . $dbPath,
            null,
            null,
            [
                PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
                PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
            ]
        );

        $this->pdo->exec('PRAGMA foreign_keys = ON');
        $this->pdo->exec('PRAGMA journal_mode = WAL');

        if ($needsInit) {
            $this->initializeSchema();
            $this->seedCriteria();
        }
    }

    /* ==================== ИНИЦИАЛИЗАЦИЯ ==================== */

    private function initializeSchema(): void
    {
        $this->pdo->exec("
            CREATE TABLE assessors (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                nickname TEXT UNIQUE NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE criteria (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT UNIQUE NOT NULL,
                description TEXT
            );

            CREATE TABLE sessions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                assessor_id INTEGER NOT NULL,
                criterion_id INTEGER NOT NULL,
                started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                ended_at DATETIME,
                FOREIGN KEY (assessor_id) REFERENCES assessors(id),
                FOREIGN KEY (criterion_id) REFERENCES criteria(id)
            );

            CREATE TABLE comparisons (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id INTEGER NOT NULL,
                image_left TEXT NOT NULL,
                image_right TEXT NOT NULL,
                result TEXT NOT NULL CHECK(result IN ('<', '=', '>')),
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                is_undone INTEGER DEFAULT 0,
                FOREIGN KEY (session_id) REFERENCES sessions(id)
            );

            CREATE INDEX idx_comparisons_session ON comparisons(session_id);
            CREATE INDEX idx_comparisons_undone ON comparisons(is_undone);

            CREATE TABLE ratings (
                image_path TEXT NOT NULL,
                criterion_id INTEGER NOT NULL,
                elo_rating REAL DEFAULT 1500.0,
                bt_score REAL DEFAULT 1.0,
                comparison_count INTEGER DEFAULT 0,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (image_path, criterion_id),
                FOREIGN KEY (criterion_id) REFERENCES criteria(id)
            );
        ");
    }

    private function seedCriteria(): void
    {
        $stmt = $this->pdo->prepare(
            'INSERT INTO criteria (name, description) VALUES (?, ?)'
        );
        $criteria = [
            ['Общее качество', 'Какое изображение вы считаете лучшим в целом?'],
            ['Резкость', 'На каком изображении детали видны чётче?'],
            ['Контрастность', 'На каком изображении лучше различимы структуры?'],
            ['Артефакты', 'На каком изображении меньше помех и искажений?'],
        ];
        foreach ($criteria as [$name, $desc]) {
            $stmt->execute([$name, $desc]);
        }
    }

    /* ==================== ОЦЕНЩИКИ ==================== */

    public function getOrCreateAssessor(string $nickname): int
    {
        $stmt = $this->pdo->prepare('SELECT id FROM assessors WHERE nickname = ?');
        $stmt->execute([$nickname]);
        $row = $stmt->fetch();
        if ($row !== false) {
            return (int) $row['id'];
        }

        $stmt = $this->pdo->prepare('INSERT INTO assessors (nickname) VALUES (?)');
        $stmt->execute([$nickname]);
        return (int) $this->pdo->lastInsertId();
    }

    public function getAssessorByNickname(string $nickname): ?array
    {
        $stmt = $this->pdo->prepare('SELECT * FROM assessors WHERE nickname = ?');
        $stmt->execute([$nickname]);
        $row = $stmt->fetch();
        return $row !== false ? $row : null;
    }

    /* ==================== КРИТЕРИИ ==================== */

    public function getCriteria(): array
    {
        $stmt = $this->pdo->query('SELECT id, name, description FROM criteria ORDER BY id');
        return $stmt->fetchAll();
    }

    public function getCriterion(int $id): ?array
    {
        $stmt = $this->pdo->prepare('SELECT * FROM criteria WHERE id = ?');
        $stmt->execute([$id]);
        $row = $stmt->fetch();
        return $row !== false ? $row : null;
    }

    /* ==================== СЕССИИ ==================== */

    public function createSession(int $assessorId, int $criterionId): int
    {
        $stmt = $this->pdo->prepare(
            'INSERT INTO sessions (assessor_id, criterion_id) VALUES (?, ?)'
        );
        $stmt->execute([$assessorId, $criterionId]);
        return (int) $this->pdo->lastInsertId();
    }

    public function endSession(int $sessionId): void
    {
        $stmt = $this->pdo->prepare(
            'UPDATE sessions SET ended_at = CURRENT_TIMESTAMP WHERE id = ?'
        );
        $stmt->execute([$sessionId]);
    }

    public function getSession(int $sessionId): ?array
    {
        $stmt = $this->pdo->prepare('SELECT * FROM sessions WHERE id = ?');
        $stmt->execute([$sessionId]);
        $row = $stmt->fetch();
        return $row !== false ? $row : null;
    }

    /* ==================== СРАВНЕНИЯ ==================== */

    /**
     * Создаёт по одной сессии для каждого критерия (если ещё не создавалась).
     * Возвращает массив: criterion_id => session_id.
     */
    public function startAllSessions(int $assessorId): array
    {
        $criteria = $this->getCriteria();
        $map = [];
        foreach ($criteria as $c) {
            $cid = (int) $c['id'];
            $map[$cid] = $this->createSession($assessorId, $cid);
        }
        return $map;
    }

    /**
     * Записывает сравнение и возвращает массив:
     *   ['id' => int, 'number' => int (номер сравнений ассессора по этому критерию)]
     */
    public function addComparison(int $sessionId, string $left, string $right, string $result): array
    {
        $stmt = $this->pdo->prepare(
            'INSERT INTO comparisons (session_id, image_left, image_right, result)
             VALUES (?, ?, ?, ?)'
        );
        $stmt->execute([$sessionId, $left, $right, $result]);
        $id = (int) $this->pdo->lastInsertId();

        $session = $this->getSession($sessionId);
        $assessorId = (int) $session['assessor_id'];
        $criterionId = (int) $session['criterion_id'];
        $countStmt = $this->pdo->prepare(
            'SELECT COUNT(*) AS cnt
             FROM comparisons c
             JOIN sessions s ON c.session_id = s.id
             WHERE s.assessor_id = ? AND s.criterion_id = ? AND c.is_undone = 0'
        );
        $countStmt->execute([$assessorId, $criterionId]);
        $number = (int) $countStmt->fetch()['cnt'];

        return ['id' => $id, 'number' => $number];
    }

    /**
     * Общее число активных сравнений ассессора по всем критериям.
     */
    public function getAssessorTotalCount(string $nickname): int
    {
        $stmt = $this->pdo->prepare(
            'SELECT COUNT(*) AS cnt
             FROM comparisons c
             JOIN sessions s ON c.session_id = s.id
             JOIN assessors a ON s.assessor_id = a.id
             WHERE a.nickname = ? AND c.is_undone = 0'
        );
        $stmt->execute([$nickname]);
        return (int) $stmt->fetch()['cnt'];
    }

    /**
     * Мягкое удаление сравнения. Проверяет, что оно принадлежит указанному ассессору.
     * Возвращает отменённое сравнение или null.
     */
    public function undoComparison(int $comparisonId, string $assessorNickname): ?array
    {
        $stmt = $this->pdo->prepare(
            'SELECT c.*
             FROM comparisons c
             JOIN sessions s ON c.session_id = s.id
             JOIN assessors a ON s.assessor_id = a.id
             WHERE c.id = ? AND a.nickname = ? AND c.is_undone = 0'
        );
        $stmt->execute([$comparisonId, $assessorNickname]);
        $row = $stmt->fetch();
        if ($row === false) {
            return null;
        }

        $upd = $this->pdo->prepare(
            'UPDATE comparisons SET is_undone = 1 WHERE id = ?'
        );
        $upd->execute([$comparisonId]);
        return $row;
    }

    /**
     * Возвращает последние N сравнений ассессора по всем критериям (новые сверху).
     * Каждый элемент содержит порядковый номер по своему критерию (number).
     */
    public function getHistoryByAssessor(string $nickname, int $limit = self::HISTORY_LIMIT): array
    {
        $stmt = $this->pdo->prepare(
            'SELECT c.id, c.image_left, c.image_right, c.result, c.created_at, c.is_undone,
                    c.session_id, s.criterion_id, cr.name AS criterion_name
             FROM comparisons c
             JOIN sessions s ON c.session_id = s.id
             JOIN assessors a ON s.assessor_id = a.id
             JOIN criteria cr ON s.criterion_id = cr.id
             WHERE a.nickname = ?
             ORDER BY c.id DESC
             LIMIT ?'
        );
        $stmt->execute([$nickname, $limit]);
        $rows = $stmt->fetchAll();
        if (empty($rows)) return [];

        // Для каждой строки считаем per-criterion порядковый номер.
        $numStmt = $this->pdo->prepare(
            'SELECT COUNT(*) AS cnt
             FROM comparisons c
             JOIN sessions s ON c.session_id = s.id
             JOIN assessors a ON s.assessor_id = a.id
             WHERE a.nickname = ? AND s.criterion_id = ?
               AND c.is_undone = 0 AND c.id <= ?'
        );
        foreach ($rows as &$row) {
            if ((int)$row['is_undone'] === 0) {
                $numStmt->execute([$nickname, (int)$row['criterion_id'], (int)$row['id']]);
                $row['number'] = (int) $numStmt->fetch()['cnt'];
            } else {
                $row['number'] = null;
            }
        }
        unset($row);
        return $rows;
    }

    /**
     * (Legacy) Возвращает последние N сравнений сессии (новые сверху).
     * Каждый элемент содержит порядковый номер (number) глобально по ассессору.
     */
    public function getHistory(int $sessionId, int $limit = self::HISTORY_LIMIT): array
    {
        $session = $this->getSession($sessionId);
        if ($session === null) {
            return [];
        }
        $assessorId = (int) $session['assessor_id'];

        $stmt = $this->pdo->prepare(
            'SELECT c.id, c.image_left, c.image_right, c.result, c.created_at, c.is_undone, c.session_id
             FROM comparisons c
             WHERE c.session_id = ?
             ORDER BY c.id DESC
             LIMIT ?'
        );
        $stmt->execute([$sessionId, $limit]);
        $rows = $stmt->fetchAll();

        if (empty($rows)) {
            return [];
        }

        $minId = min(array_map(fn($r) => (int)$r['id'], $rows));
        $countStmt = $this->pdo->prepare(
            'SELECT COUNT(*) AS cnt
             FROM comparisons c
             JOIN sessions s ON c.session_id = s.id
             WHERE s.assessor_id = ? AND c.is_undone = 0 AND c.id < ?'
        );
        $countStmt->execute([$assessorId, $minId]);
        $baseCount = (int) $countStmt->fetch()['cnt'];

        usort($rows, fn($a, $b) => (int)$a['id'] - (int)$b['id']);
        $running = $baseCount;
        foreach ($rows as &$row) {
            if ((int)$row['is_undone'] === 0) {
                $running++;
                $row['number'] = $running;
            } else {
                $row['number'] = null;
            }
        }
        unset($row);

        $rows = array_reverse($rows);
        return $rows;
    }

    /* ==================== BRADLEY-TERRY / ELO ==================== */

    public function getAllComparisons(int $criterionId): array
    {
        $stmt = $this->pdo->prepare(
            'SELECT c.id, c.image_left, c.image_right, c.result, c.created_at,
                    s.assessor_id, a.nickname AS assessor
             FROM comparisons c
             JOIN sessions s ON c.session_id = s.id
             JOIN assessors a ON s.assessor_id = a.id
             WHERE s.criterion_id = ? AND c.is_undone = 0
             ORDER BY c.id'
        );
        $stmt->execute([$criterionId]);
        return $stmt->fetchAll();
    }

    /**
     * Пересчитывает рейтинги Брэдли-Терри (с регуляризацией) для указанного критерия.
     * Записывает результаты в таблицу ratings и возвращает массив рейтингов.
     */
    public function computeBradleyTerry(int $criterionId): array
    {
        $comparisons = $this->getAllComparisons($criterionId);
        if (empty($comparisons)) {
            return [];
        }

        $images = [];
        foreach ($comparisons as $cmp) {
            $images[$cmp['image_left']] = true;
            $images[$cmp['image_right']] = true;
        }
        $imageList = array_keys($images);
        $n = count($imageList);

        if ($n < 2) {
            return [];
        }

        $idx = array_flip($imageList);

        // Подсчёт побед W_i и матрицы пар n_ij = число сравнений между i и j (включая ничьи).
        $wins = array_fill(0, $n, 0.0);
        $pair = [];
        $pairCount = array_fill(0, $n, 0);

        foreach ($comparisons as $cmp) {
            $i = $idx[$cmp['image_left']];
            $j = $idx[$cmp['image_right']];
            $r = $cmp['result'];

            if ($r === '<') {
                $wins[$j] += 1.0;
            } elseif ($r === '>') {
                $wins[$i] += 1.0;
            } else {
                $wins[$i] += 0.5;
                $wins[$j] += 0.5;
            }

            $key = $i < $j ? "$i:$j" : "$j:$i";
            $pair[$key] = ($pair[$key] ?? 0) + 1;
            $pairCount[$i]++;
            $pairCount[$j]++;
        }

        $lambda = self::BT_SMOOTHING_LAMBDA;

        // Инициализация π_i = 1.
        $pi = array_fill(0, $n, 1.0);

        for ($iter = 0; $iter < self::BT_MAX_ITERATIONS; $iter++) {
            $newPi = array_fill(0, $n, 0.0);

            for ($i = 0; $i < $n; $i++) {
                $denom = 0.0;
                for ($j = 0; $j < $n; $j++) {
                    if ($i === $j) continue;
                    $key = $i < $j ? "$i:$j" : "$j:$i";
                    $nij = ($pair[$key] ?? 0) + 2 * $lambda;
                    $denom += $nij / ($pi[$i] + $pi[$j]);
                }

                if ($denom <= 0) {
                    $newPi[$i] = $pi[$i];
                } else {
                    $newPi[$i] = ($wins[$i] + $lambda) / $denom;
                }
            }

            $mean = array_sum($newPi) / $n;
            if ($mean > 0) {
                for ($i = 0; $i < $n; $i++) {
                    $newPi[$i] /= $mean;
                }
            }

            $maxDelta = 0.0;
            for ($i = 0; $i < $n; $i++) {
                $d = abs($newPi[$i] - $pi[$i]);
                if ($d > $maxDelta) $maxDelta = $d;
            }
            $pi = $newPi;

            if ($maxDelta < self::BT_CONVERGENCE_EPSILON) {
                break;
            }
        }

        // Запись в БД.
        $this->pdo->beginTransaction();
        try {
            $upsert = $this->pdo->prepare(
                'INSERT INTO ratings (image_path, criterion_id, bt_score, comparison_count, updated_at)
                 VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
                 ON CONFLICT(image_path, criterion_id) DO UPDATE SET
                    bt_score = excluded.bt_score,
                    comparison_count = excluded.comparison_count,
                    updated_at = CURRENT_TIMESTAMP'
            );

            $result = [];
            foreach ($imageList as $i => $path) {
                $upsert->execute([$path, $criterionId, $pi[$i], $pairCount[$i]]);
                $result[] = [
                    'image_path' => $path,
                    'bt_score' => $pi[$i],
                    'comparison_count' => $pairCount[$i],
                ];
            }
            $this->pdo->commit();
        } catch (Throwable $e) {
            $this->pdo->rollBack();
            throw $e;
        }

        return $result;
    }

    /**
     * Возвращает текущие рейтинги для критерия (отсортированы по bt_score DESC).
     * Если рейтинги пусты или устарели — пересчитывает.
     */
    public function getRatings(int $criterionId): array
    {
        $stmt = $this->pdo->prepare(
            'SELECT image_path, bt_score, elo_rating, comparison_count, updated_at
             FROM ratings
             WHERE criterion_id = ?
             ORDER BY bt_score DESC'
        );
        $stmt->execute([$criterionId]);
        $rows = $stmt->fetchAll();

        if (empty($rows)) {
            $this->computeBradleyTerry($criterionId);
            $stmt->execute([$criterionId]);
            $rows = $stmt->fetchAll();
        }

        return $rows;
    }

    /* ==================== ГРАФ ОЦЕНЩИКА ==================== */

    /**
     * Возвращает данные для force-directed графа сравнений конкретного оценщика
     * по выбранному критерию. Структура:
     *   [
     *     'nodes' => [{'id' => path, 'rating' => bt_score, 'count' => int}, ...],
     *     'links' => [{'source' => path, 'target' => path, 'result' => '<'|'='|'>', 'created_at' => ...}, ...]
     *   ]
     */
    public function getAssessorGraph(string $assessorNickname, int $criterionId): array
    {
        $stmt = $this->pdo->prepare(
            'SELECT c.image_left, c.image_right, c.result, c.created_at
             FROM comparisons c
             JOIN sessions s ON c.session_id = s.id
             JOIN assessors a ON s.assessor_id = a.id
             WHERE a.nickname = ? AND s.criterion_id = ? AND c.is_undone = 0
             ORDER BY c.id'
        );
        $stmt->execute([$assessorNickname, $criterionId]);
        $rows = $stmt->fetchAll();

        $ratings = $this->getRatings($criterionId);
        $ratingsMap = [];
        foreach ($ratings as $r) {
            $ratingsMap[$r['image_path']] = [
                'rating' => (float) $r['bt_score'],
                'count' => (int) $r['comparison_count'],
            ];
        }

        $nodeSet = [];
        $links = [];
        foreach ($rows as $row) {
            $nodeSet[$row['image_left']] = true;
            $nodeSet[$row['image_right']] = true;
            $links[] = [
                'source' => $row['image_left'],
                'target' => $row['image_right'],
                'result' => $row['result'],
                'created_at' => $row['created_at'],
            ];
        }

        $nodes = [];
        foreach (array_keys($nodeSet) as $path) {
            $info = $ratingsMap[$path] ?? ['rating' => 1.0, 'count' => 0];
            $nodes[] = [
                'id' => $path,
                'rating' => $info['rating'],
                'count' => $info['count'],
            ];
        }

        return ['nodes' => $nodes, 'links' => $links];
    }

    /* ==================== БЭКАПЫ ==================== */

    public function makeBackup(): ?string
    {
        if (!is_file($this->dbPath)) {
            return null;
        }
        $timestamp = date('Ymd_His');
        $target = $this->backupDir . DIRECTORY_SEPARATOR . "backup_$timestamp.sqlite";
        if (!@copy($this->dbPath, $target)) {
            return null;
        }
        $this->pruneBackups();
        return $target;
    }

    private function pruneBackups(): void
    {
        $files = glob($this->backupDir . DIRECTORY_SEPARATOR . 'backup_*.sqlite') ?: [];
        if (count($files) <= self::BACKUP_RETENTION) {
            return;
        }
        usort($files, fn($a, $b) => filemtime($a) <=> filemtime($b));
        $excess = count($files) - self::BACKUP_RETENTION;
        for ($i = 0; $i < $excess; $i++) {
            @unlink($files[$i]);
        }
    }

    /** Общее число активных сравнений (не отменённых) — для триггера автобэкапа. */
    public function getActiveComparisonsCount(): int
    {
        $stmt = $this->pdo->query('SELECT COUNT(*) AS cnt FROM comparisons WHERE is_undone = 0');
        return (int) $stmt->fetch()['cnt'];
    }

    /* ==================== ВСПОМОГАТЕЛЬНОЕ ==================== */

    public function pdo(): PDO
    {
        return $this->pdo;
    }
}
