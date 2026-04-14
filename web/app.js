/**
 * ==========================================================
 *  Клиентская логика SPA для попарного сравнения изображений
 * ==========================================================
 *
 *  Функциональность:
 *  - Авторизация по никнейму (сохраняется в sessionStorage)
 *  - Загрузка случайной пары изображений с сервера
 *  - Отправка оценки асинхронно (Fetch API)
 *  - Обновление интерфейса без перезагрузки страницы
 *  - Горячие клавиши 1/2/3 для быстрой оценки
 */

'use strict';

/* ---------- Конфигурация ---------- */

/**
 * Базовый URL PHP-бэкенда.
 * При необходимости изменить на реальный адрес сервера.
 */
const API_BASE = './api.php';

/* ---------- DOM-элементы ---------- */

const $loginScreen = document.getElementById('login-screen');
const $comparisonScreen = document.getElementById('comparison-screen');
const $loginForm = document.getElementById('login-form');
const $nicknameInput = document.getElementById('nickname-input');
const $imgLeft = document.getElementById('img-left');
const $imgRight = document.getElementById('img-right');
const $pathLeft = document.getElementById('path-left');
const $pathRight = document.getElementById('path-right');
const $userBadge = document.getElementById('user-badge');
const $counterBadge = document.getElementById('counter-badge');
const $logoutBtn = document.getElementById('logout-btn');
const $voteLeft = document.getElementById('vote-left');
const $voteEqual = document.getElementById('vote-equal');
const $voteRight = document.getElementById('vote-right');
const $loadingOverlay = document.getElementById('loading-overlay');
const $toastContainer = document.getElementById('toast-container');

/* ---------- Состояние приложения ---------- */

let state = {
    nickname: sessionStorage.getItem('nickname') || '',
    currentLeft: '',   // Относительный путь к левому изображению
    currentRight: '',  // Относительный путь к правому изображению
    voteCount: parseInt(sessionStorage.getItem('voteCount') || '0', 10),
    isLoading: false,
};

/* ---------- Инициализация ---------- */

document.addEventListener('DOMContentLoaded', init);

function init() {
    // Если никнейм уже сохранён, переходим к экрану сравнения
    if (state.nickname) {
        switchToComparison();
    }

    $loginForm.addEventListener('submit', handleLogin);
    $logoutBtn.addEventListener('click', handleLogout);

    // Кнопки голосования
    $voteLeft.addEventListener('click', () => submitVote('<'));
    $voteEqual.addEventListener('click', () => submitVote('='));
    $voteRight.addEventListener('click', () => submitVote('>'));

    // Горячие клавиши
    document.addEventListener('keydown', handleKeyboard);
}

/* ---------- Авторизация ---------- */

/**
 * Обработка формы логина.
 * @param {SubmitEvent} e
 */
function handleLogin(e) {
    e.preventDefault();
    const nick = $nicknameInput.value.trim();
    if (!nick) return;

    state.nickname = nick;
    sessionStorage.setItem('nickname', nick);
    switchToComparison();
}

/**
 * Выход из текущей сессии.
 */
function handleLogout() {
    state.nickname = '';
    state.voteCount = 0;
    sessionStorage.removeItem('nickname');
    sessionStorage.removeItem('voteCount');

    $comparisonScreen.classList.remove('active');
    $loginScreen.classList.add('active');
    $nicknameInput.value = '';
    $nicknameInput.focus();
}

/* ---------- Переключение экранов ---------- */

/**
 * Показать экран сравнения и загрузить первую пару.
 */
function switchToComparison() {
    $loginScreen.classList.remove('active');
    $comparisonScreen.classList.add('active');
    $userBadge.textContent = '\uD83D\uDC64 ' + state.nickname;
    updateCounter();
    loadPair();
}

/* ---------- Загрузка пары изображений ---------- */

/**
 * Запрашивает у сервера случайную пару изображений.
 */
async function loadPair() {
    setLoading(true);

    try {
        const response = await fetch(API_BASE + '?action=pair');
        if (!response.ok) throw new Error('HTTP ' + response.status);

        const data = await response.json();

        if (data.error) {
            showToast(data.error, 'error');
            return;
        }

        // Сохраняем относительные пути
        state.currentLeft = data.left;
        state.currentRight = data.right;

        // Анимация смены изображений
        $imgLeft.classList.add('img-swap');
        $imgRight.classList.add('img-swap');

        // Обновляем src (путь относительно директории изображений)
        $imgLeft.src = API_BASE + '?action=image&path=' + encodeURIComponent(data.left);
        $imgRight.src = API_BASE + '?action=image&path=' + encodeURIComponent(data.right);

        // Показываем относительные пути
        $pathLeft.textContent = data.left;
        $pathRight.textContent = data.right;

        // Убираем класс анимации после завершения
        setTimeout(function () {
            $imgLeft.classList.remove('img-swap');
            $imgRight.classList.remove('img-swap');
        }, 520);

    } catch (err) {
        console.error('Error loading pair:', err);
        showToast('Failed to load images. Check the server.', 'error');
    } finally {
        setLoading(false);
    }
}

/* ---------- Отправка оценки ---------- */

/**
 * Отправляет результат сравнения на сервер.
 * @param {'<' | '=' | '>'} sign
 */
async function submitVote(sign) {
    if (state.isLoading) return;
    if (!state.currentLeft || !state.currentRight) return;

    setLoading(true);
    disableVoteButtons(true);

    try {
        const body = new URLSearchParams({
            action: 'vote',
            nickname: state.nickname,
            left: state.currentLeft,
            right: state.currentRight,
            sign: sign,
        });

        const response = await fetch(API_BASE, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: body.toString(),
        });

        if (!response.ok) throw new Error('HTTP ' + response.status);

        const result = await response.json();

        if (result.error) {
            showToast(result.error, 'error');
            return;
        }

        // Инкремент счётчика
        state.voteCount++;
        sessionStorage.setItem('voteCount', String(state.voteCount));
        updateCounter();

        showToast('Saved!', 'success');

        // Загрузить следующую пару
        await loadPair();

    } catch (err) {
        console.error('Error submitting vote:', err);
        showToast('Failed to submit vote.', 'error');
    } finally {
        setLoading(false);
        disableVoteButtons(false);
    }
}

/* ---------- Горячие клавиши ---------- */

/**
 * Обработка горячих клавиш (1, 2, 3).
 * @param {KeyboardEvent} e
 */
function handleKeyboard(e) {
    // Игнорируем, если фокус на поле ввода или мы на экране логина
    if (document.activeElement.tagName === 'INPUT') return;
    if (!$comparisonScreen.classList.contains('active')) return;

    switch (e.key) {
        case '1': submitVote('<'); break;
        case '2': submitVote('='); break;
        case '3': submitVote('>'); break;
    }
}

/* ---------- Утилиты UI ---------- */

/**
 * Показать / скрыть оверлей загрузки.
 * @param {boolean} show
 */
function setLoading(show) {
    state.isLoading = show;
    $loadingOverlay.classList.toggle('hidden', !show);
}

/**
 * Обновить текст бейджа-счётчика.
 */
function updateCounter() {
    $counterBadge.textContent = state.voteCount + ' ' + pluralize(state.voteCount);
}

/**
 * Примитивная плюрализация для слова «оценка».
 * @param {number} n
 * @returns {string}
 */
function pluralize(n) {
    var mod10 = n % 10;
    var mod100 = n % 100;
    if (mod100 >= 11 && mod100 <= 14) return 'votes';
    if (mod10 === 1) return 'vote';
    return 'votes';
}

/**
 * Заблокировать / разблокировать кнопки голосования.
 * @param {boolean} disabled
 */
function disableVoteButtons(disabled) {
    [$voteLeft, $voteEqual, $voteRight].forEach(function (btn) {
        btn.disabled = disabled;
    });
}

/**
 * Показать уведомление (toast).
 * @param {string} message
 * @param {'success'|'error'} type
 */
function showToast(message, type) {
    type = type || 'success';
    var toast = document.createElement('div');
    toast.className = 'toast toast-' + type;
    toast.textContent = message;
    $toastContainer.appendChild(toast);

    // Автоматическое удаление через 3 секунды
    setTimeout(function () {
        toast.style.opacity = '0';
        toast.style.transform = 'translateX(40px)';
        toast.style.transition = 'all 0.3s ease';
        setTimeout(function () { toast.remove(); }, 320);
    }, 3000);
}
