<?php
/**
 * ==========================================================
 *  API-обработчик для системы попарного сравнения изображений
 * ==========================================================
 *
 *  Маршруты (action):
 *    GET  ?action=pair  [&excluded=...|&included=...] — Случайная пара изображений
 *    POST action=pair   excluded=p1|p2|... | included=...
 *    POST action=submit_round                          — Раунд (батч голосов по паре)
 *    POST action=undo_round  round_id, nickname        — Отменить весь раунд
 *    GET  ?action=tree                              — Дерево папок и файлов test_data
 *    GET  ?action=image&path=...                    — Файл изображения
 *    GET  ?action=criteria                          — Список критериев
 *    GET  ?action=history&nickname=X                — Последние N сравнений ассессора
 *    GET  ?action=history&session_id=X              — (legacy) История одной сессии
 *    GET  ?action=ratings&criterion_id=X            — Рейтинги Брэдли-Терри (с recompute=1)
 *    GET  ?action=bt_results&criterion_id=X         — Полный отчёт BT по критерию
 *    GET  ?action=graph&nickname=X&criterion_id=X   — Граф сравнений оценщика
 *    GET  ?action=assessors                         — Список оценщиков
 *    POST action=start_all_sessions                 — Создать сессии для всех критериев
 *    POST action=start_session                      — (legacy) Сессия по одному критерию
 *    POST action=vote                               — Записать сравнение, вернуть id + номер
 *    POST action=undo                               — Отменить сравнение
 *    POST action=end_sessions                       — Завершить все открытые сессии + бэкап
 */

declare(strict_types=1);

require_once __DIR__ . '/database.php';

/* ============= КОНФИГУРАЦИЯ ============= */

define('IMAGE_DIR', __DIR__ . '/test_data');
define('DATA_DIR', __DIR__ . '/data');
define('DB_PATH', DATA_DIR . '/database.sqlite');
define('BACKUP_DIR', DATA_DIR . '/backups');
define('ALLOWED_EXTENSIONS', ['jpg', 'jpeg', 'png', 'bmp', 'gif', 'webp', 'tiff']);
define('AUTO_BACKUP_EVERY', 20);

/* ============= МАРШРУТИЗАЦИЯ ============= */

if (php_sapi_name() === 'cli-server') {
    $path = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
    $action = $_GET['action'] ?? $_POST['action'] ?? '';

    if ($action === '' && !str_ends_with($path, 'api.php')) {
        if ($path === '/' || $path === '/index.html' || $path === '/web/') {
            readfile(__DIR__ . '/index.html');
            exit;
        }

        if (is_file($_SERVER['DOCUMENT_ROOT'] . $path)) {
            return false;
        }

        $localPath = __DIR__ . '/' . basename($path);
        if (is_file($localPath)) {
            $ext = pathinfo($localPath, PATHINFO_EXTENSION);
            $contentTypes = [
                'css' => 'text/css',
                'js' => 'application/javascript',
                'html' => 'text/html',
            ];
            if (isset($contentTypes[$ext])) {
                header('Content-Type: ' . $contentTypes[$ext]);
                readfile($localPath);
                exit;
            }
        }
    }
}

header('Content-Type: application/json; charset=utf-8');

$action = $_GET['action'] ?? $_POST['action'] ?? '';

try {
    switch ($action) {
        case 'pair':            handlePair(); break;
        case 'tree':            handleTree(); break;
        case 'vote':            handleVote(); break;
        case 'submit_round':    handleSubmitRound(); break;
        case 'undo_round':      handleUndoRound(); break;
        case 'undo':            handleUndo(); break;
        case 'image':           handleImage(); break;
        case 'criteria':            handleCriteria(); break;
        case 'start_session':       handleStartSession(); break;
        case 'start_all_sessions':  handleStartAllSessions(); break;
        case 'end_session':         handleEndSession(); break;
        case 'end_sessions':        handleEndSessions(); break;
        case 'history':             handleHistory(); break;
        case 'ratings':             handleRatings(); break;
        case 'bt_results':          handleBtResults(); break;
        case 'graph':               handleGraph(); break;
        case 'assessors':           handleAssessors(); break;
        default:
            jsonResponse(['error' => 'Неизвестное действие.'], 400);
    }
} catch (Throwable $e) {
    jsonResponse(['error' => 'Серверная ошибка: ' . $e->getMessage()], 500);
}

/* ============= ОБРАБОТЧИКИ ============= */

function db(): Database
{
    static $instance = null;
    if ($instance === null) {
        $instance = new Database(DB_PATH, BACKUP_DIR);
    }
    return $instance;
}

function handleCriteria(): void
{
    jsonResponse(['criteria' => db()->getCriteria()]);
}

function handleStartSession(): void
{
    $nickname = trim($_POST['nickname'] ?? '');
    $criterionId = (int) ($_POST['criterion_id'] ?? 0);

    if (!preg_match('/^[A-Za-zА-Яа-яёЁ0-9_\-]{1,32}$/u', $nickname)) {
        jsonResponse(['error' => 'Недопустимый никнейм.'], 400);
        return;
    }
    if ($criterionId <= 0 || db()->getCriterion($criterionId) === null) {
        jsonResponse(['error' => 'Недопустимый критерий.'], 400);
        return;
    }

    $assessorId = db()->getOrCreateAssessor($nickname);
    $sessionId = db()->createSession($assessorId, $criterionId);

    jsonResponse([
        'session_id' => $sessionId,
        'assessor_id' => $assessorId,
        'criterion' => db()->getCriterion($criterionId),
    ]);
}

function handleStartAllSessions(): void
{
    $nickname = trim($_POST['nickname'] ?? '');
    if (!preg_match('/^[A-Za-zА-Яа-яёЁ0-9_\-]{1,32}$/u', $nickname)) {
        jsonResponse(['error' => 'Недопустимый никнейм.'], 400);
        return;
    }
    $assessorId = db()->getOrCreateAssessor($nickname);
    $sessions = db()->startAllSessions($assessorId);
    $criteria = db()->getCriteria();
    $list = [];
    foreach ($criteria as $c) {
        $cid = (int) $c['id'];
        $list[] = [
            'criterion_id' => $cid,
            'criterion_name' => $c['name'],
            'description' => $c['description'],
            'session_id' => $sessions[$cid] ?? null,
        ];
    }
    jsonResponse([
        'assessor_id' => $assessorId,
        'nickname' => $nickname,
        'sessions' => $list,
    ]);
}

function handleEndSession(): void
{
    $sessionId = (int) ($_POST['session_id'] ?? 0);
    if ($sessionId <= 0) {
        jsonResponse(['error' => 'session_id обязателен.'], 400);
        return;
    }
    db()->endSession($sessionId);
    $backupPath = db()->makeBackup();
    jsonResponse(['ok' => true, 'backup' => $backupPath !== null ? basename($backupPath) : null]);
}

function handleEndSessions(): void
{
    $ids = $_POST['session_ids'] ?? '';
    if (is_string($ids)) {
        $ids = array_filter(array_map('intval', explode(',', $ids)));
    }
    foreach ((array) $ids as $sid) {
        if ((int) $sid > 0) db()->endSession((int) $sid);
    }
    $backupPath = db()->makeBackup();
    jsonResponse(['ok' => true, 'backup' => $backupPath !== null ? basename($backupPath) : null]);
}

function handlePair(): void
{
    $images = scanImagesRecursive(IMAGE_DIR);

    // Поддержка фильтра. Можно передать ИЛИ списком исключённых путей
    // (excluded=p1|p2|...) ИЛИ списком включённых (included=p1|p2|...).
    // Если оба — included имеет приоритет.
    $includedRaw = $_POST['included'] ?? $_GET['included'] ?? '';
    $excludedRaw = $_POST['excluded'] ?? $_GET['excluded'] ?? '';

    if ($includedRaw !== '') {
        $includedList = array_filter(array_map('trim', explode('|', $includedRaw)));
        $included = array_flip($includedList);
        $images = array_values(array_filter(
            $images,
            static fn($p) => isset($included[$p])
        ));
    } elseif ($excludedRaw !== '') {
        $excludedList = array_filter(array_map('trim', explode('|', $excludedRaw)));
        $excluded = array_flip($excludedList);
        $images = array_values(array_filter(
            $images,
            static fn($p) => !isset($excluded[$p])
        ));
    }

    if (count($images) < 2) {
        jsonResponse([
            'error' => 'Недостаточно изображений после применения фильтра (нужно ≥ 2).'
        ], 500);
        return;
    }

    // Информативная (умная) выборка пары:
    //   1. Уникальные пары C(N,2) по фильтру.
    //   2. Вычитаем глобально увиденные раунды.
    //   3. Если непокрытых нет → all_done.
    //   4. Иначе предпочитаем пары, где хотя бы одно изображение наименее
    //      сравнённое (min count), а второе — наиболее сравнённое
    //      (информативный «мост»).

    sort($images, SORT_STRING);
    $n = count($images);
    $totalUnique = intdiv($n * ($n - 1), 2);

    $seenMap   = db()->getSeenPairsGlobal();         // "pathA|pathB" => cnt
    $countMap  = db()->getPairCountsGlobal();        // path => cnt

    // Считаем seen_unique только в пределах текущего фильтра.
    $availableSet = array_flip($images);
    $seenUnique = 0;
    foreach ($seenMap as $key => $_cnt) {
        [$a, $b] = explode('|', $key, 2);
        if (isset($availableSet[$a]) && isset($availableSet[$b])) {
            $seenUnique++;
        }
    }
    $remaining = $totalUnique - $seenUnique;

    if ($remaining <= 0) {
        $scope = !empty($_POST['included']) || !empty($_GET['included'])
              || !empty($_POST['excluded']) || !empty($_GET['excluded'])
            ? 'filter' : 'all';
        jsonResponse([
            'all_done' => true,
            'total_unique' => $totalUnique,
            'seen_unique' => $seenUnique,
            'remaining_unique' => 0,
            'scope' => $scope,
            'images' => $n,
        ]);
        return;
    }

    // Перечисляем непокрытые пары и считаем score информативности.
    // score = (-min(cI, cJ), max(cI, cJ)) — сначала «least-compared image»,
    // затем «most-connected partner». Для лексико-минимизации работаем с
    // отрицанием первого компонента.
    $candidates = [];     // [pair_idxA, pair_idxB, scoreKey]
    $bestKey = null;      // (negMin, maxC)
    for ($i = 0; $i < $n; $i++) {
        for ($j = $i + 1; $j < $n; $j++) {
            $a = $images[$i];
            $b = $images[$j];
            $key = $a <= $b ? "$a|$b" : "$b|$a";
            if (isset($seenMap[$key])) continue;

            $ca = $countMap[$a] ?? 0;
            $cb = $countMap[$b] ?? 0;
            $minC = $ca < $cb ? $ca : $cb;
            $maxC = $ca > $cb ? $ca : $cb;
            // Лексикографический ключ: сначала меньшее min => больший приоритет;
            // среди равных — большее max => больший приоритет.
            $scoreKey = [-$minC, $maxC];

            if ($bestKey === null || $scoreKey > $bestKey) {
                $bestKey = $scoreKey;
                $candidates = [[$a, $b]];
            } elseif ($scoreKey === $bestKey) {
                $candidates[] = [$a, $b];
            }
        }
    }

    // Из топ-кандидатов берём случайного.
    [$picked0, $picked1] = $candidates[array_rand($candidates)];

    // Рандомизируем сторону left/right (50/50), чтобы избежать bias.
    if (random_int(0, 1) === 1) {
        [$picked0, $picked1] = [$picked1, $picked0];
    }

    jsonResponse([
        'left' => $picked0,
        'right' => $picked1,
        'total_unique' => $totalUnique,
        'seen_unique' => $seenUnique,
        'remaining_unique' => $remaining,
    ]);
}

/**
 * Возвращает дерево папок и файлов внутри IMAGE_DIR в виде JSON.
 * Структура каждого узла: { name, type: 'dir'|'file', path?, children? }.
 */
function handleTree(): void
{
    $tree = scanTree(IMAGE_DIR, IMAGE_DIR);
    jsonResponse([
        'name' => basename(IMAGE_DIR),
        'type' => 'dir',
        'children' => $tree,
    ]);
}

function scanTree(string $dir, string $baseDir): array
{
    $entries = [];
    if (!is_dir($dir)) return $entries;

    $items = @scandir($dir) ?: [];
    sort($items, SORT_NATURAL | SORT_FLAG_CASE);

    foreach ($items as $name) {
        if ($name === '.' || $name === '..') continue;
        $full = $dir . DIRECTORY_SEPARATOR . $name;

        if (is_dir($full)) {
            $children = scanTree($full, $baseDir);
            // Скрываем пустые директории, чтобы не засорять дерево.
            if (empty($children)) continue;
            $entries[] = [
                'name' => $name,
                'type' => 'dir',
                'children' => $children,
            ];
        } elseif (is_file($full)) {
            $ext = strtolower(pathinfo($name, PATHINFO_EXTENSION));
            if (!in_array($ext, ALLOWED_EXTENSIONS, true)) continue;
            $rel = './' . ltrim(
                str_replace('\\', '/', substr($full, strlen($baseDir))),
                '/'
            );
            $entries[] = [
                'name' => $name,
                'type' => 'file',
                'path' => $rel,
            ];
        }
    }

    // Папки выше файлов.
    usort($entries, static function ($a, $b) {
        if ($a['type'] !== $b['type']) {
            return $a['type'] === 'dir' ? -1 : 1;
        }
        return strnatcasecmp($a['name'], $b['name']);
    });

    return $entries;
}

function handleVote(): void
{
    $sessionId = (int) ($_POST['session_id'] ?? 0);
    $left = trim($_POST['left'] ?? '');
    $right = trim($_POST['right'] ?? '');
    $sign = trim($_POST['sign'] ?? '');

    if ($sessionId <= 0 || $left === '' || $right === '' || $sign === '') {
        jsonResponse(['error' => 'Поля обязательны: session_id, left, right, sign.'], 400);
        return;
    }
    if (!in_array($sign, ['<', '=', '>'], true)) {
        jsonResponse(['error' => 'Недопустимый знак сравнения.'], 400);
        return;
    }
    $session = db()->getSession($sessionId);
    if ($session === null) {
        jsonResponse(['error' => 'Сессия не найдена.'], 404);
        return;
    }

    $info = db()->addComparison($sessionId, $left, $right, $sign);

    // Автобэкап каждые N сравнений.
    $total = db()->getActiveComparisonsCount();
    $backupCreated = false;
    if ($total > 0 && $total % AUTO_BACKUP_EVERY === 0) {
        $backup = db()->makeBackup();
        $backupCreated = $backup !== null;
    }

    jsonResponse([
        'ok' => true,
        'comparison_id' => $info['id'],
        'number' => $info['number'],
        'auto_backup' => $backupCreated,
    ]);
}

function handleUndo(): void
{
    $comparisonId = (int) ($_POST['comparison_id'] ?? 0);
    $nickname = trim($_POST['nickname'] ?? '');

    if ($comparisonId <= 0 || $nickname === '') {
        jsonResponse(['error' => 'Поля обязательны: comparison_id, nickname.'], 400);
        return;
    }

    $undone = db()->undoComparison($comparisonId, $nickname);
    if ($undone === null) {
        jsonResponse(['error' => 'Сравнение не найдено или уже отменено.'], 404);
        return;
    }
    jsonResponse(['ok' => true, 'undone' => $undone]);
}

/**
 * Принимает раунд (батч голосов по одной паре):
 *   POST nickname=X  left=...  right=...  votes=<JSON-массив>
 * где votes — JSON формата [{"session_id": int, "sign": "<"|"="|">"}, ...].
 */
function handleSubmitRound(): void
{
    $nickname = trim($_POST['nickname'] ?? '');
    $left = trim($_POST['left'] ?? '');
    $right = trim($_POST['right'] ?? '');
    $votesRaw = $_POST['votes'] ?? '';

    if ($nickname === '' || $left === '' || $right === '' || $votesRaw === '') {
        jsonResponse(['error' => 'Поля обязательны: nickname, left, right, votes.'], 400);
        return;
    }
    if (!preg_match('/^[A-Za-zА-Яа-яёЁ0-9_\-]{1,32}$/u', $nickname)) {
        jsonResponse(['error' => 'Недопустимый никнейм.'], 400);
        return;
    }
    $votes = json_decode($votesRaw, true);
    if (!is_array($votes) || count($votes) === 0) {
        jsonResponse(['error' => 'Поле votes должно быть непустым JSON-массивом.'], 400);
        return;
    }

    $clean = [];
    foreach ($votes as $v) {
        if (!isset($v['session_id'], $v['sign'])) {
            jsonResponse(['error' => 'Каждый голос требует session_id и sign.'], 400);
            return;
        }
        if (!in_array($v['sign'], ['<', '=', '>'], true)) {
            jsonResponse(['error' => 'Недопустимый знак: ' . $v['sign']], 400);
            return;
        }
        $sid = (int) $v['session_id'];
        if ($sid <= 0 || db()->getSession($sid) === null) {
            jsonResponse(['error' => 'Сессия не найдена: ' . $v['session_id']], 404);
            return;
        }
        $clean[] = ['session_id' => $sid, 'sign' => $v['sign']];
    }

    // Все сессии должны принадлежать одному ассессору с указанным никнеймом.
    $assessor = db()->getAssessorByNickname($nickname);
    if ($assessor === null) {
        jsonResponse(['error' => 'Оценщик не найден.'], 404);
        return;
    }
    $assessorId = (int) $assessor['id'];

    foreach ($clean as $v) {
        $session = db()->getSession($v['session_id']);
        if ((int) $session['assessor_id'] !== $assessorId) {
            jsonResponse(['error' => 'Сессия не принадлежит ассессору.'], 403);
            return;
        }
    }

    $info = db()->createRound($assessorId, $left, $right, $clean);

    // Автобэкап каждые N активных сравнений (учитываем все индивидуальные голоса).
    $total = db()->getActiveComparisonsCount();
    $backupCreated = false;
    if ($total > 0 && intdiv($total, AUTO_BACKUP_EVERY) >
        intdiv($total - count($clean), AUTO_BACKUP_EVERY)) {
        $backup = db()->makeBackup();
        $backupCreated = $backup !== null;
    }

    jsonResponse([
        'ok' => true,
        'round_id' => $info['round_id'],
        'number' => $info['number'],
        'comparison_ids' => $info['comparison_ids'],
        'auto_backup' => $backupCreated,
    ]);
}

/**
 * Отменяет весь раунд (вместе со всеми голосами по критериям).
 *   POST round_id=N  nickname=X
 */
function handleUndoRound(): void
{
    $roundId = (int) ($_POST['round_id'] ?? 0);
    $nickname = trim($_POST['nickname'] ?? '');

    if ($roundId <= 0 || $nickname === '') {
        jsonResponse(['error' => 'Поля обязательны: round_id, nickname.'], 400);
        return;
    }
    $undone = db()->undoRound($roundId, $nickname);
    if ($undone === null) {
        jsonResponse(['error' => 'Раунд не найден или уже отменён.'], 404);
        return;
    }
    jsonResponse(['ok' => true, 'undone' => $undone]);
}

function handleHistory(): void
{
    $nickname = trim($_GET['nickname'] ?? '');
    if ($nickname !== '') {
        // Новый формат: история раундов (объединённое сравнение).
        // limit=0 → вся история пользователя без ограничений.
        $limit = (int) ($_GET['limit'] ?? 0);
        $rounds = db()->getRoundsByAssessor($nickname, max(0, $limit));
        $total = db()->getAssessorTotalCount($nickname);
        $totalRounds = db()->getAssessorRoundCount($nickname);
        jsonResponse([
            'rounds' => $rounds,
            'total' => $total,
            'total_rounds' => $totalRounds,
        ]);
        return;
    }
    $sessionId = (int) ($_GET['session_id'] ?? 0);
    if ($sessionId <= 0) {
        jsonResponse(['error' => 'nickname или session_id обязателен.'], 400);
        return;
    }
    $history = db()->getHistory($sessionId);
    jsonResponse(['history' => $history]);
}

function handleRatings(): void
{
    $criterionId = (int) ($_GET['criterion_id'] ?? 0);
    if ($criterionId <= 0) {
        jsonResponse(['error' => 'criterion_id обязателен.'], 400);
        return;
    }
    $recompute = !empty($_GET['recompute']);
    if ($recompute) {
        db()->computeBradleyTerry($criterionId);
    }
    jsonResponse(['ratings' => db()->getRatings($criterionId)]);
}

/**
 * Полный отчёт по работе алгоритма Брэдли-Терри для критерия:
 *   - метаданные критерия
 *   - параметры алгоритма (lambda, eps, max_iter)
 *   - число активных сравнений
 *   - отсортированный список рейтингов
 */
function handleBtResults(): void
{
    $criterionId = (int) ($_GET['criterion_id'] ?? 0);
    if ($criterionId <= 0) {
        jsonResponse(['error' => 'criterion_id обязателен.'], 400);
        return;
    }
    $criterion = db()->getCriterion($criterionId);
    if ($criterion === null) {
        jsonResponse(['error' => 'Критерий не найден.'], 404);
        return;
    }

    db()->computeBradleyTerry($criterionId);
    $ratings = db()->getRatings($criterionId);
    $allComp = db()->getAllComparisons($criterionId);

    $byResult = ['<' => 0, '=' => 0, '>' => 0];
    foreach ($allComp as $c) {
        $byResult[$c['result']]++;
    }

    jsonResponse([
        'criterion' => $criterion,
        'algorithm' => [
            'name' => 'Bradley-Terry (Zermelo-Ford with Laplace smoothing)',
            'lambda' => 0.5,
            'epsilon' => 1.0e-6,
            'max_iterations' => 1000,
            'normalization' => 'mean = 1',
        ],
        'stats' => [
            'images' => count($ratings),
            'comparisons' => count($allComp),
            'by_result' => $byResult,
        ],
        'ratings' => $ratings,
    ]);
}

function handleGraph(): void
{
    $nickname = trim($_GET['nickname'] ?? '');
    $criterionId = (int) ($_GET['criterion_id'] ?? 0);
    if ($nickname === '' || $criterionId <= 0) {
        jsonResponse(['error' => 'nickname и criterion_id обязательны.'], 400);
        return;
    }
    db()->computeBradleyTerry($criterionId);
    $graph = db()->getAssessorGraph($nickname, $criterionId);
    jsonResponse($graph);
}

function handleAssessors(): void
{
    $stmt = db()->pdo()->query('SELECT id, nickname FROM assessors ORDER BY nickname');
    jsonResponse(['assessors' => $stmt->fetchAll()]);
}

function handleImage(): void
{
    $relPath = $_GET['path'] ?? '';
    if ($relPath === '') {
        http_response_code(400);
        exit('Missing path parameter');
    }

    $fullPath = realpath(IMAGE_DIR . DIRECTORY_SEPARATOR . $relPath);

    if ($fullPath === false || !str_starts_with($fullPath, realpath(IMAGE_DIR))) {
        http_response_code(403);
        exit('Access denied');
    }
    if (!is_file($fullPath) || !is_readable($fullPath)) {
        http_response_code(404);
        exit('File not found');
    }

    if (class_exists('finfo')) {
        $finfo = new finfo(FILEINFO_MIME_TYPE);
        $mime = $finfo->file($fullPath);
    } elseif (function_exists('mime_content_type')) {
        $mime = mime_content_type($fullPath);
    } else {
        $ext = strtolower(pathinfo($fullPath, PATHINFO_EXTENSION));
        $mimeTypes = [
            'png' => 'image/png',
            'jpg' => 'image/jpeg',
            'jpeg' => 'image/jpeg',
            'gif' => 'image/gif',
            'webp' => 'image/webp',
            'bmp' => 'image/bmp',
        ];
        $mime = $mimeTypes[$ext] ?? 'application/octet-stream';
    }

    header('Content-Type: ' . $mime);
    header('Content-Length: ' . filesize($fullPath));
    header('Cache-Control: public, max-age=86400');
    readfile($fullPath);
    exit;
}

/* ============= УТИЛИТЫ ============= */

function scanImagesRecursive(string $baseDir): array
{
    $images = [];
    if (!is_dir($baseDir)) return $images;

    $iterator = new RecursiveIteratorIterator(
        new RecursiveDirectoryIterator(
            $baseDir,
            RecursiveDirectoryIterator::SKIP_DOTS | RecursiveDirectoryIterator::FOLLOW_SYMLINKS
        )
    );

    foreach ($iterator as $file) {
        /** @var SplFileInfo $file */
        if (!$file->isFile()) continue;
        $ext = strtolower($file->getExtension());
        if (!in_array($ext, ALLOWED_EXTENSIONS, true)) continue;

        $relative = './' . ltrim(
            str_replace('\\', '/', substr($file->getPathname(), strlen($baseDir))),
            '/'
        );
        $images[] = $relative;
    }

    return $images;
}

function jsonResponse(mixed $data, int $status = 200): void
{
    http_response_code($status);
    echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}
