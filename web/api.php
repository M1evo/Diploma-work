<?php
/**
 * ==========================================================
 *  API-обработчик для системы попарного сравнения изображений
 * ==========================================================
 *
 *  Маршруты (action):
 *    GET  ?action=pair                — Получить случайную пару изображений
 *    GET  ?action=image&path=...      — Отдать файл изображения
 *    POST  action=vote                — Сохранить результат сравнения
 *
 *  Конфигурация:
 *    IMAGE_DIR  — абсолютный или относительный путь к корневой
 *                 директории с изображениями
 *    LOG_FILE   — путь к файлу лога результатов
 */

/* ============= КОНФИГУРАЦИЯ ============= */

/**
 * Путь к директории с изображениями (рекурсивный обход).
 * Измените на актуальный путь к вашему набору данных.
 */
define('IMAGE_DIR', __DIR__ . '/test_data');

/**
 * Путь к текстовому файлу лога результатов сравнений.
 */
define('LOG_FILE', __DIR__ . '/results.log');

/**
 * Допустимые расширения файлов изображений.
 */
define('ALLOWED_EXTENSIONS', ['jpg', 'jpeg', 'png', 'bmp', 'gif', 'webp', 'tiff']);

/* ============= МАРШРУТИЗАЦИЯ ============= */

// Поддержка запуска через встроенный сервер (например, в IDE при выборе api.php)
if (php_sapi_name() === 'cli-server') {
    $path = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
    $action = $_GET['action'] ?? $_POST['action'] ?? '';

    // Перехватываем только не-API запросы
    if ($action === '' && !str_ends_with($path, 'api.php')) {
        if ($path === '/' || $path === '/index.html' || $path === '/web/') {
            readfile(__DIR__ . '/index.html');
            exit;
        }

        // Если файл существует относительно DOCUMENT_ROOT, пусть PHP сервер отдаст его сам
        if (is_file($_SERVER['DOCUMENT_ROOT'] . $path)) {
            return false;
        }

        // Страховочный вариант для статики (если DOCUMENT_ROOT установлен выше папки web)
        $localPath = __DIR__ . '/' . basename($path);
        if (is_file($localPath)) {
            $ext = pathinfo($localPath, PATHINFO_EXTENSION);
            if ($ext === 'css') {
                header('Content-Type: text/css');
                readfile($localPath);
                exit;
            } elseif ($ext === 'js') {
                header('Content-Type: application/javascript');
                readfile($localPath);
                exit;
            }
        }
    }
}

header('Content-Type: application/json; charset=utf-8');

// Определяем действие из GET- или POST-параметров
$action = $_GET['action'] ?? $_POST['action'] ?? '';

switch ($action) {
    case 'pair':
        handlePair();
        break;

    case 'vote':
        handleVote();
        break;

    case 'image':
        handleImage();
        break;

    default:
        jsonResponse(['error' => 'Неизвестное действие (action). Допустимые: pair, vote, image.'], 400);
}

/* ============= ОБРАБОТЧИКИ ============= */

/**
 * Выбирает две случайные картинки из IMAGE_DIR (рекурсивно)
 * и возвращает их относительные пути.
 */
function handlePair(): void
{
    $images = scanImagesRecursive(IMAGE_DIR);

    if (count($images) < 2) {
        jsonResponse(['error' => 'Недостаточно изображений для формирования пары (нужно ≥ 2).'], 500);
        return;
    }

    // Выбираем два различных случайных индекса
    $idx1 = array_rand($images);
    do {
        $idx2 = array_rand($images);
    } while ($idx2 === $idx1);

    jsonResponse([
        'left' => $images[$idx1],
        'right' => $images[$idx2],
    ]);
}

/**
 * Принимает POST-запрос с результатом сравнения и записывает
 * его в лог-файл в формате:
 *   [никнейм] [путь_1] [знак] [путь_2]
 */
function handleVote(): void
{
    // Валидация входных данных
    $nickname = trim($_POST['nickname'] ?? '');
    $left = trim($_POST['left'] ?? '');
    $right = trim($_POST['right'] ?? '');
    $sign = trim($_POST['sign'] ?? '');

    if ($nickname === '' || $left === '' || $right === '' || $sign === '') {
        jsonResponse(['error' => 'Все поля обязательны: nickname, left, right, sign.'], 400);
        return;
    }

    // Знак должен быть строго одним из трёх
    if (!in_array($sign, ['<', '=', '>'], true)) {
        jsonResponse(['error' => 'Недопустимый знак сравнения. Ожидается: <, = или >.'], 400);
        return;
    }

    // Санитизация никнейма (допускаем только безопасные символы)
    if (!preg_match('/^[A-Za-zА-Яа-яёЁ0-9_\-]{1,32}$/u', $nickname)) {
        jsonResponse(['error' => 'Недопустимый никнейм.'], 400);
        return;
    }

    // Формируем строку лога
    $logLine = sprintf(
        "%s %s %s %s\n",
        $nickname,
        $left,
        $sign,
        $right
    );

    // Атомарная запись в файл (с блокировкой)
    $result = file_put_contents(LOG_FILE, $logLine, FILE_APPEND | LOCK_EX);

    if ($result === false) {
        jsonResponse(['error' => 'Не удалось записать результат в лог.'], 500);
        return;
    }

    jsonResponse(['ok' => true]);
}

/**
 * Отдаёт файл изображения по относительному пути.
 * Защищает от выхода за пределы IMAGE_DIR (path traversal).
 */
function handleImage(): void
{
    $relPath = $_GET['path'] ?? '';

    if ($relPath === '') {
        http_response_code(400);
        exit('Missing path parameter');
    }

    // Нормализуем путь и предотвращаем directory traversal
    $fullPath = realpath(IMAGE_DIR . DIRECTORY_SEPARATOR . $relPath);

    if ($fullPath === false || !str_starts_with($fullPath, realpath(IMAGE_DIR))) {
        http_response_code(403);
        exit('Access denied');
    }

    if (!is_file($fullPath) || !is_readable($fullPath)) {
        http_response_code(404);
        exit('File not found');
    }

    // Определяем MIME-тип
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
            'bmp' => 'image/bmp'
        ];
        $mime = $mimeTypes[$ext] ?? 'application/octet-stream';
    }

    // Отправляем заголовки и содержимое
    header('Content-Type: ' . $mime);
    header('Content-Length: ' . filesize($fullPath));
    header('Cache-Control: public, max-age=86400');
    readfile($fullPath);
    exit;
}

/* ============= УТИЛИТЫ ============= */

/**
 * Рекурсивно сканирует директорию и возвращает массив
 * относительных путей к изображениям.
 *
 * @param string $baseDir Абсолютный путь к корневой директории
 * @return string[] Массив относительных путей (например, "./folder1/img001.png")
 */
function scanImagesRecursive(string $baseDir): array
{
    $images = [];

    if (!is_dir($baseDir)) {
        return $images;
    }

    $iterator = new RecursiveIteratorIterator(
        new RecursiveDirectoryIterator(
            $baseDir,
            RecursiveDirectoryIterator::SKIP_DOTS | RecursiveDirectoryIterator::FOLLOW_SYMLINKS
        )
    );

    foreach ($iterator as $file) {
        /** @var SplFileInfo $file */
        if (!$file->isFile()) {
            continue;
        }

        $ext = strtolower($file->getExtension());
        if (!in_array($ext, ALLOWED_EXTENSIONS, true)) {
            continue;
        }

        // Вычисляем относительный путь от IMAGE_DIR
        $relative = './' . ltrim(
            str_replace('\\', '/', substr($file->getPathname(), strlen($baseDir))),
            '/'
        );

        $images[] = $relative;
    }

    return $images;
}

/**
 * Отправляет JSON-ответ и завершает скрипт.
 *
 * @param mixed $data   Данные для сериализации
 * @param int   $status HTTP-код ответа
 */
function jsonResponse(mixed $data, int $status = 200): void
{
    http_response_code($status);
    echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}
