<?php
/**
 * ==========================================================
 *  API-обработчик для системы попарного сравнения изображений
 * ==========================================================
 *
 *  Маршруты (action):
 *    GET  ?action=pair                              — Случайная пара изображений
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
        case 'vote':            handleVote(); break;
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

    if (count($images) < 2) {
        jsonResponse(['error' => 'Недостаточно изображений (нужно ≥ 2).'], 500);
        return;
    }

    $idx1 = array_rand($images);
    do {
        $idx2 = array_rand($images);
    } while ($idx2 === $idx1);

    jsonResponse([
        'left' => $images[$idx1],
        'right' => $images[$idx2],
    ]);
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

function handleHistory(): void
{
    $nickname = trim($_GET['nickname'] ?? '');
    if ($nickname !== '') {
        $history = db()->getHistoryByAssessor($nickname);
        $total = db()->getAssessorTotalCount($nickname);
        jsonResponse(['history' => $history, 'total' => $total]);
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
