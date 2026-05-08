/**
 * ==========================================================
 *  Клиентская логика SPA для попарного сравнения изображений
 * ==========================================================
 *
 *  Флоу:
 *   1. Логин (никнейм) → создаются сессии для всех 4 критериев
 *   2. Экран сравнения: показывается пара + 4 ряда (по критерию).
 *      По мере выбора в каждом ряду отправляется отдельный vote.
 *      Когда все 4 проголосованы — кнопка «Следующая пара».
 *   3. Граф сравнений (📊) и Рейтинги BT (🏆) — отдельные страницы.
 */

'use strict';

/* ---------- Конфигурация ---------- */

const API_BASE = './api.php';
// История раундов в UI безлимитная — все сравнения текущего пользователя
// видны до выхода из сессии.

/* ---------- DOM ---------- */

const $ = (id) => document.getElementById(id);

const $loginScreen = $('login-screen');
const $comparisonScreen = $('comparison-screen');
const $resultsScreen = $('results-screen');
const $btScreen = $('bt-screen');

const $loginForm = $('login-form');
const $nicknameInput = $('nickname-input');

const $userBadge = $('user-badge');
const $counterBadge = $('counter-badge');
const $logoutBtn = $('logout-btn');
const $resultsBtn = $('results-btn');
const $btBtn = $('bt-btn');

const $imgLeft = $('img-left');
const $imgRight = $('img-right');
const $pathLeft = $('path-left');
const $pathRight = $('path-right');

const $criteriaRows = $('criteria-rows');
const $nextPairBtn = $('next-pair-btn');
const $roundProgress = $('round-progress');
const $allDoneBanner = $('all-done-banner');
const $allDoneDesc = $('all-done-desc');

const $historyList = $('history-list');
const $historyCount = $('history-count');

const $loadingOverlay = $('loading-overlay');
const $toastContainer = $('toast-container');

const $resultsCriterion = $('results-criterion');
const $resultsAssessor = $('results-assessor');
const $resultsRefresh = $('results-refresh');
const $resultsStats = $('results-stats');
const $backFromResults = $('back-from-results');
const $graphSvg = $('graph-svg');
const $graphTooltip = $('graph-tooltip');
const $graphEmpty = $('graph-empty');

const $btCriterion = $('bt-criterion');
const $btRefresh = $('bt-refresh');
const $btSummary = $('bt-summary');
const $btTbody = $('bt-tbody');
const $backFromBt = $('back-from-bt');

const $graphLegend = $('graph-legend');
const $legendToggle = $('legend-toggle');
const $legendClose = $('legend-close');
const $graphFullscreen = $('graph-fullscreen');

const $filterBtn = $('filter-btn');
const $filterModal = $('filter-modal');
const $filterTree = $('filter-tree');
const $filterCount = $('filter-count');
const $filterApply = $('filter-apply');
const $filterSelectAll = $('filter-select-all');
const $filterDeselectAll = $('filter-deselect-all');
const $filterExpandAll = $('filter-expand-all');
const $filterCollapseAll = $('filter-collapse-all');

const $lightbox = $('lightbox');
const $lightboxImg = $('lightbox-img');
const $lightboxClose = $('lightbox-close');
const $lightboxViewport = $('lightbox-viewport');
const $lightboxZoomInfo = $('lightbox-zoom-info');

/* ---------- Состояние ---------- */

const SS = sessionStorage;

let state = {
    nickname: SS.getItem('nickname') || '',
    /** [{criterion_id, criterion_name, description, session_id}, ...] */
    sessions: JSON.parse(SS.getItem('sessions') || 'null') || [],
    /** Map<criterion_id, '<'|'='|'>'> для текущей пары — сохраняется только в памяти. */
    pairVotes: new Map(),
    voteCount: parseInt(SS.getItem('voteCount') || '0', 10),
    currentLeft: '',
    currentRight: '',
    history: [],
    isLoading: false,
    viewingHistory: false,
    graphData: null,
    graphResizeObs: null,
    /** Активен ли фильтр. Если false — все изображения участвуют (дефолт).
     *  Сохраняется в localStorage между сессиями. */
    filterActive: localStorage.getItem('filterActive') === '1',
    /** Set<string> — пути изображений, ВКЛЮЧЁННЫХ пользователем (для активного
     *  фильтра). При filterActive=false список не используется. */
    selectedPaths: new Set(JSON.parse(localStorage.getItem('selectedPaths') || '[]')),
    /** Кэш дерева — чтобы не перезапрашивать при каждом открытии модала. */
    treeCache: null,
};

/* ---------- Инициализация ---------- */

document.addEventListener('DOMContentLoaded', init);

function init() {
    if (state.nickname && state.sessions.length === 4) {
        switchToComparison();
    }

    $loginForm.addEventListener('submit', handleLogin);
    $logoutBtn.addEventListener('click', handleLogout);
    $resultsBtn.addEventListener('click', switchToResults);
    $btBtn.addEventListener('click', switchToBt);
    $backFromResults.addEventListener('click', () => switchToComparison(false));
    $backFromBt.addEventListener('click', () => switchToComparison(false));
    $nextPairBtn.addEventListener('click', () => submitRoundAndLoadPair());

    // Кнопки баннера «все пары пройдены».
    $allDoneBanner.querySelectorAll('[data-banner-action]').forEach((btn) => {
        btn.addEventListener('click', () => {
            const a = btn.dataset.bannerAction;
            if (a === 'filter') openFilterModal();
            else if (a === 'bt') switchToBt();
            else if (a === 'graph') switchToResults();
        });
    });

    $resultsRefresh.addEventListener('click', renderGraph);
    $resultsCriterion.addEventListener('change', renderGraph);
    $resultsAssessor.addEventListener('change', renderGraph);
    $btRefresh.addEventListener('click', () => renderBt(true));
    $btCriterion.addEventListener('change', () => renderBt(false));

    document.addEventListener('keydown', handleKeyboard);

    // Лайтбокс изображений на экране сравнения.
    $imgLeft.addEventListener('click', () => openLightbox($imgLeft.src));
    $imgRight.addEventListener('click', () => openLightbox($imgRight.src));
    $lightboxClose.addEventListener('click', closeLightbox);
    $lightboxViewport.addEventListener('wheel', handleLightboxWheel, { passive: false });
    $lightboxImg.addEventListener('mousedown', handleLightboxDragStart);
    window.addEventListener('mousemove', handleLightboxDragMove);
    window.addEventListener('mouseup', handleLightboxDragEnd);

    // Свернуть/развернуть легенду.
    $legendClose.addEventListener('click', () => setLegendCollapsed(true));
    $legendToggle.addEventListener('click', () => setLegendCollapsed(false));

    // Развернуть/свернуть граф на весь экран.
    $graphFullscreen.addEventListener('click', toggleGraphFullscreen);

    // Фильтр изображений.
    $filterBtn.addEventListener('click', openFilterModal);
    $filterApply.addEventListener('click', applyFilter);
    $filterSelectAll.addEventListener('click', () => bulkSetFilter(false));
    $filterDeselectAll.addEventListener('click', () => bulkSetFilter(true));
    $filterExpandAll.addEventListener('click', () => bulkExpandFilter(true));
    $filterCollapseAll.addEventListener('click', () => bulkExpandFilter(false));
    $filterModal.querySelectorAll('[data-close="filter"]').forEach((el) => {
        el.addEventListener('click', closeFilterModal);
    });

    // Бэкап на закрытие/уход.
    window.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden' && state.sessions.length) {
            const ids = state.sessions.map((s) => s.session_id).join(',');
            const fd = new FormData();
            fd.append('action', 'end_sessions');
            fd.append('session_ids', ids);
            navigator.sendBeacon(API_BASE, fd);
        }
    });
}

/* ---------- Авторизация ---------- */

async function handleLogin(e) {
    e.preventDefault();
    const nick = $nicknameInput.value.trim();
    if (!nick) return;
    setLoading(true);
    try {
        const fd = new FormData();
        fd.append('action', 'start_all_sessions');
        fd.append('nickname', nick);
        const res = await fetch(API_BASE, { method: 'POST', body: fd });
        const data = await res.json();
        if (data.error) {
            showToast(data.error, 'error');
            return;
        }
        state.nickname = nick;
        state.sessions = data.sessions;
        state.voteCount = 0;
        SS.setItem('nickname', nick);
        SS.setItem('sessions', JSON.stringify(state.sessions));
        SS.setItem('voteCount', '0');
        switchToComparison();
    } catch (err) {
        console.error(err);
        showToast('Не удалось войти.', 'error');
    } finally {
        setLoading(false);
    }
}

function handleLogout() {
    endAllSessions();
    state.nickname = '';
    state.sessions = [];
    state.voteCount = 0;
    state.history = [];
    state.pairVotes.clear();
    SS.clear();
    showScreen($loginScreen);
    $nicknameInput.value = '';
    $nicknameInput.focus();
}

function endAllSessions() {
    if (!state.sessions.length) return;
    const ids = state.sessions.map((s) => s.session_id).join(',');
    const fd = new FormData();
    fd.append('action', 'end_sessions');
    fd.append('session_ids', ids);
    fetch(API_BASE, { method: 'POST', body: fd }).catch(() => { });
}

/* ---------- Переключение экранов ---------- */

function showScreen(screen) {
    [$loginScreen, $comparisonScreen, $resultsScreen, $btScreen].forEach((s) => {
        s.classList.toggle('active', s === screen);
    });
}

function switchToComparison(loadNew = true) {
    showScreen($comparisonScreen);
    $userBadge.textContent = '👤 ' + state.nickname;
    updateCounter();
    renderCriteriaRows();
    if (loadNew && !state.currentLeft) loadPair();
    loadHistory();
}

function renderCriteriaRows() {
    $criteriaRows.innerHTML = '';
    const icons = ['🌟', '🔍', '🌓', '🧹'];
    state.sessions.forEach((s, idx) => {
        const row = document.createElement('div');
        row.className = 'criterion-row';
        row.dataset.criterionId = String(s.criterion_id);
        row.innerHTML = `
            <div class="criterion-info">
                <span class="criterion-row-icon">${icons[idx % icons.length]}</span>
                <div class="criterion-row-text">
                    <div class="criterion-row-name">${escapeHtml(s.criterion_name)}</div>
                    <div class="criterion-row-desc">${escapeHtml(s.description || '')}</div>
                </div>
            </div>
            <div class="criterion-buttons">
                <button class="btn-vote-mini btn-left" data-vote="<">A лучше</button>
                <button class="btn-vote-mini btn-equal" data-vote="=">Равны</button>
                <button class="btn-vote-mini btn-right" data-vote=">">B лучше</button>
            </div>
        `;
        row.querySelectorAll('.btn-vote-mini').forEach((btn) => {
            btn.addEventListener('click', () =>
                selectCriterionVote(s.criterion_id, btn.dataset.vote)
            );
        });
        $criteriaRows.appendChild(row);
    });
    updateRoundProgress();
}

/**
 * Локальный выбор/перевыбор оценки по критерию. Никаких сетевых запросов —
 * фактическая отправка происходит только в submitRoundAndLoadPair.
 */
function selectCriterionVote(criterionId, sign) {
    if (state.viewingHistory) {
        showToast('Просмотр истории — голосование недоступно.', 'error');
        return;
    }
    if (!state.currentLeft || !state.currentRight) return;

    state.pairVotes.set(criterionId, sign);

    const row = document.querySelector(
        `.criterion-row[data-criterion-id="${criterionId}"]`
    );
    if (row) {
        row.classList.add('done');
        row.querySelectorAll('.btn-vote-mini').forEach((b) => {
            b.classList.toggle('active', b.dataset.vote === sign);
        });
    }
    updateRoundProgress();
}

/* ---------- Загрузка пары ---------- */

async function loadPair() {
    setLoading(true);
    state.viewingHistory = false;
    state.pairVotes.clear();
    try {
        // Если фильтр активен — отправляем POST со списком включённых путей.
        // Иначе — обычный GET (все изображения участвуют).
        let res;
        if (state.filterActive && state.selectedPaths.size > 0) {
            const fd = new URLSearchParams({
                action: 'pair',
                included: Array.from(state.selectedPaths).join('|'),
            });
            res = await fetch(API_BASE, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: fd.toString(),
            });
        } else {
            res = await fetch(API_BASE + '?action=pair');
        }
        const data = await res.json();
        if (data.error) {
            showToast(data.error, 'error');
            return;
        }
        // Сервер сообщает, что в текущем фильтре все уникальные пары пройдены.
        if (data.all_done) {
            showAllDoneBanner(data);
            return;
        }
        hideAllDoneBanner();
        showPair(data.left, data.right);
        resetCriteriaRows();
        $nextPairBtn.disabled = true;
    } catch (err) {
        console.error(err);
        showToast('Не удалось загрузить изображения.', 'error');
    } finally {
        setLoading(false);
    }
}

function showAllDoneBanner(data) {
    const k = data.total_unique ?? 0;
    const n = data.images ?? 0;
    const scope = data.scope === 'filter'
        ? 'По текущему фильтру'
        : 'По всему набору';
    $allDoneDesc.textContent =
        `${scope} (${n} изображений → ${k} уникальных пар) все сравнения уже сделаны. ` +
        `Чтобы продолжить — расширьте фильтр или завершите сессию.`;
    $allDoneBanner.classList.remove('hidden');

    // Прячем зону голосования и кнопку «Следующая пара».
    $criteriaRows.classList.add('hidden');
    document.querySelector('.round-controls')?.classList.add('hidden');
    document.querySelector('.images-row')?.classList.add('hidden');
    document.querySelector('.instruction')?.classList.add('hidden');

    showToast('Все пары по фильтру пройдены', 'success');
}

function hideAllDoneBanner() {
    if ($allDoneBanner.classList.contains('hidden')) return;
    $allDoneBanner.classList.add('hidden');
    $criteriaRows.classList.remove('hidden');
    document.querySelector('.round-controls')?.classList.remove('hidden');
    document.querySelector('.images-row')?.classList.remove('hidden');
    document.querySelector('.instruction')?.classList.remove('hidden');
}

function showPair(left, right, readonly = false) {
    state.currentLeft = left;
    state.currentRight = right;
    state.viewingHistory = readonly;

    $imgLeft.classList.add('img-swap');
    $imgRight.classList.add('img-swap');
    $imgLeft.src = API_BASE + '?action=image&path=' + encodeURIComponent(left);
    $imgRight.src = API_BASE + '?action=image&path=' + encodeURIComponent(right);
    $pathLeft.textContent = left;
    $pathRight.textContent = right;

    setTimeout(() => {
        $imgLeft.classList.remove('img-swap');
        $imgRight.classList.remove('img-swap');
    }, 520);

    $criteriaRows.classList.toggle('readonly', readonly);
}

function resetCriteriaRows() {
    document.querySelectorAll('.criterion-row').forEach((row) => {
        row.classList.remove('done');
        row.querySelectorAll('.btn-vote-mini').forEach((b) => b.classList.remove('active'));
    });
    updateRoundProgress();
}

function updateRoundProgress() {
    const total = state.sessions.length;
    const done = state.pairVotes.size;
    $roundProgress.textContent = done + ' / ' + total + ' критериев оценено';
    $nextPairBtn.disabled = !(done === total && total > 0 && !state.viewingHistory);
}

/* ---------- Голосование ---------- */

/**
 * Сначала отправляет раунд (батч голосов по критериям), затем загружает
 * следующую пару. Если все критерии не оценены — отказывает.
 */
async function submitRoundAndLoadPair() {
    if (state.isLoading) return;
    if (state.viewingHistory) {
        showToast('Просмотр истории. Используйте навигацию для возврата.', 'error');
        return;
    }
    if (!state.currentLeft || !state.currentRight) return;
    if (state.pairVotes.size !== state.sessions.length) {
        showToast('Оцените все критерии перед переходом к следующей паре.', 'error');
        return;
    }

    setLoading(true);
    $nextPairBtn.disabled = true;

    try {
        const votes = state.sessions.map((s) => ({
            session_id: s.session_id,
            sign: state.pairVotes.get(s.criterion_id),
        }));
        const body = new URLSearchParams({
            action: 'submit_round',
            nickname: state.nickname,
            left: state.currentLeft,
            right: state.currentRight,
            votes: JSON.stringify(votes),
        });
        const res = await fetch(API_BASE, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: body.toString(),
        });
        const result = await res.json();
        if (result.error) {
            showToast(result.error, 'error');
            return;
        }

        state.voteCount += votes.length;
        SS.setItem('voteCount', String(state.voteCount));
        updateCounter();

        // Добавляем раунд в локальную историю в начало.
        state.history.unshift({
            id: result.round_id,
            number: result.number,
            image_left: state.currentLeft,
            image_right: state.currentRight,
            is_undone: 0,
            votes: state.sessions.map((s) => ({
                criterion_id: s.criterion_id,
                criterion_name: s.criterion_name,
                sign: state.pairVotes.get(s.criterion_id),
            })),
        });
        renderHistory();

        if (result.auto_backup) showToast('Автобэкап создан', 'success');

        await loadPair();
    } catch (err) {
        console.error(err);
        showToast('Не удалось отправить раунд.', 'error');
    } finally {
        setLoading(false);
        // Если в новой паре уже есть голоса (после loadPair их нет), кнопка
        // обновится через updateRoundProgress.
        updateRoundProgress();
    }
}

/* ---------- История ---------- */

async function loadHistory() {
    if (!state.nickname) return;
    try {
        const res = await fetch(
            API_BASE + '?action=history&nickname=' + encodeURIComponent(state.nickname)
        );
        const data = await res.json();
        if (data.error) return;
        // Новый формат: data.rounds. Каждый элемент — раунд с массивом votes.
        state.history = data.rounds || [];
        if (typeof data.total === 'number') {
            state.voteCount = data.total;
            SS.setItem('voteCount', String(state.voteCount));
            updateCounter();
        }
        renderHistory();
    } catch (err) {
        console.error(err);
    }
}

/**
 * Рендерит историю раундов. Каждый раунд — одна запись, в которой компактно
 * отображаются результаты всех критериев. Отмена раунда = отмена всех его
 * параметров.
 */
function renderHistory() {
    $historyList.innerHTML = '';
    // Счётчик в шапке: «всего: N (отменено: M)».
    const totalRounds = state.history.length;
    const undoneRounds = state.history.filter((h) => h.is_undone).length;
    if ($historyCount) {
        $historyCount.textContent = undoneRounds > 0
            ? `всего: ${totalRounds} (отменено: ${undoneRounds})`
            : `всего: ${totalRounds}`;
    }
    if (!state.history.length) {
        const empty = document.createElement('li');
        empty.className = 'history-empty';
        empty.textContent = 'Сравнений пока нет';
        $historyList.appendChild(empty);
        return;
    }
    state.history.forEach((round) => {
        const li = document.createElement('li');
        li.className = 'history-item history-round' + (round.is_undone ? ' undone' : '');
        const numberLabel = round.number ? '#' + round.number : '✕';

        // Краткая сводка голосов по критериям.
        const votesHtml = (round.votes || []).map((v) => `
            <span class="round-vote sign-${signClass(v.sign)}"
                  title="${escapeHtml(v.criterion_name)}: ${v.sign}">
                <span class="round-vote-name">${escapeHtml(shortCriterion(v.criterion_name))}</span>
                <span class="round-vote-sign">${v.sign}</span>
            </span>
        `).join('');

        li.innerHTML = `
            <button class="history-show" title="Показать пару">
                <span class="history-number">${numberLabel}</span>
                <span class="history-pair">
                    <span class="history-route">
                        <span class="history-path">${escapeHtml(shortPath(round.image_left))}</span>
                        <span class="history-vs">vs</span>
                        <span class="history-path">${escapeHtml(shortPath(round.image_right))}</span>
                    </span>
                    <span class="round-votes">${votesHtml}</span>
                </span>
            </button>
            ${round.is_undone
                ? '<span class="history-undone-tag">отменено</span>'
                : `<button class="history-undo" title="Отменить раунд">↩</button>`
            }
        `;
        const showBtn = li.querySelector('.history-show');
        showBtn.addEventListener('click', () => {
            showPair(round.image_left, round.image_right, true);
            highlightHistoryItem(li);
            showToast('Просмотр раунда #' + (round.number || '—'), 'success');
        });
        const undoBtn = li.querySelector('.history-undo');
        if (undoBtn) {
            undoBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                undoRound(round.id);
            });
        }
        $historyList.appendChild(li);
    });
}

/**
 * Сокращает имя критерия для компактного отображения в истории.
 * «Общее качество» → «Общ.», «Резкость» → «Рез.», и т.д.
 */
function shortCriterion(name) {
    if (!name) return '';
    const map = {
        'Общее качество': 'Общ.',
        'Резкость': 'Рез.',
        'Контрастность': 'Конт.',
        'Артефакты': 'Арт.',
    };
    return map[name] || name.slice(0, 4) + '.';
}

function highlightHistoryItem(el) {
    document.querySelectorAll('.history-item.active').forEach((n) => n.classList.remove('active'));
    el.classList.add('active');
}

function shortPath(p) {
    const parts = String(p).split('/').filter(Boolean);
    if (parts.length <= 2) return p;
    return '…/' + parts.slice(-2).join('/');
}

function signClass(s) {
    if (s === '<') return 'left';
    if (s === '>') return 'right';
    return 'equal';
}

async function undoRound(roundId) {
    setLoading(true);
    try {
        const fd = new URLSearchParams({
            action: 'undo_round',
            round_id: String(roundId),
            nickname: state.nickname,
        });
        const res = await fetch(API_BASE, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: fd.toString(),
        });
        const data = await res.json();
        if (data.error) {
            showToast(data.error, 'error');
            return;
        }
        showToast('Раунд отменён', 'success');
        const item = state.history.find((h) => h.id === roundId);
        if (item) {
            item.is_undone = 1;
            item.number = null;
            // Все голоса в раунде также считаются отменёнными.
            state.voteCount = Math.max(0, state.voteCount - (item.votes?.length || 0));
        }
        SS.setItem('voteCount', String(state.voteCount));
        updateCounter();
        renderHistory();
    } catch (err) {
        console.error(err);
        showToast('Не удалось отменить.', 'error');
    } finally {
        setLoading(false);
    }
}

/* ---------- Граф ---------- */

async function switchToResults() {
    showScreen($resultsScreen);
    setLoading(true);
    try {
        const [critRes, assRes] = await Promise.all([
            fetch(API_BASE + '?action=criteria').then((r) => r.json()),
            fetch(API_BASE + '?action=assessors').then((r) => r.json()),
        ]);
        $resultsCriterion.innerHTML = '';
        (critRes.criteria || []).forEach((c) => {
            const opt = document.createElement('option');
            opt.value = c.id;
            opt.textContent = c.name;
            $resultsCriterion.appendChild(opt);
        });
        $resultsAssessor.innerHTML = '';
        const allOpt = document.createElement('option');
        allOpt.value = '';
        allOpt.textContent = '— все (общий) —';
        $resultsAssessor.appendChild(allOpt);
        (assRes.assessors || []).forEach((a) => {
            const opt = document.createElement('option');
            opt.value = a.nickname;
            opt.textContent = a.nickname;
            if (a.nickname === state.nickname) opt.selected = true;
            $resultsAssessor.appendChild(opt);
        });
        await renderGraph();
    } catch (err) {
        console.error(err);
        showToast('Не удалось загрузить результаты.', 'error');
    } finally {
        setLoading(false);
    }
}

async function renderGraph() {
    const criterionId = parseInt($resultsCriterion.value, 10);
    if (!criterionId) return;
    const nickname = $resultsAssessor.value;

    setLoading(true);
    try {
        let graph;
        if (nickname) {
            const res = await fetch(
                API_BASE + '?action=graph&nickname=' + encodeURIComponent(nickname) +
                '&criterion_id=' + criterionId
            );
            graph = await res.json();
        } else {
            graph = await fetchAllGraph(criterionId);
        }
        if (graph.error) {
            showToast(graph.error, 'error');
            return;
        }
        state.graphData = graph;
        drawGraph(graph);
        renderStats(graph);
        ensureGraphResizeObserver();
    } catch (err) {
        console.error(err);
        showToast('Не удалось построить граф.', 'error');
    } finally {
        setLoading(false);
    }
}

async function fetchAllGraph(criterionId) {
    const [ratingsRes, assRes] = await Promise.all([
        fetch(API_BASE + '?action=ratings&criterion_id=' + criterionId + '&recompute=1').then((r) => r.json()),
        fetch(API_BASE + '?action=assessors').then((r) => r.json()),
    ]);
    const ratings = ratingsRes.ratings || [];
    const assessors = assRes.assessors || [];

    const graphs = await Promise.all(
        assessors.map((a) =>
            fetch(
                API_BASE + '?action=graph&nickname=' + encodeURIComponent(a.nickname) +
                '&criterion_id=' + criterionId
            ).then((r) => r.json()).catch(() => ({ nodes: [], links: [] }))
        )
    );
    const nodeMap = new Map();
    ratings.forEach((r) => {
        nodeMap.set(r.image_path, {
            id: r.image_path,
            rating: parseFloat(r.bt_score),
            count: parseInt(r.comparison_count, 10),
        });
    });
    const links = [];
    graphs.forEach((g, i) => {
        const nick = assessors[i].nickname;
        (g.links || []).forEach((l) => {
            links.push({ ...l, assessor: nick });
            if (!nodeMap.has(l.source)) nodeMap.set(l.source, { id: l.source, rating: 1, count: 0 });
            if (!nodeMap.has(l.target)) nodeMap.set(l.target, { id: l.target, rating: 1, count: 0 });
        });
    });
    return { nodes: Array.from(nodeMap.values()), links };
}

function renderStats(graph) {
    const nodes = graph.nodes || [];
    const links = graph.links || [];
    const top = [...nodes].sort((a, b) => (b.rating || 0) - (a.rating || 0)).slice(0, 3);
    const topHtml = top.length
        ? top.map((n, i) => `<li><b>${i + 1}.</b> ${escapeHtml(shortPath(n.id))}
            <span class="muted">${(n.rating || 0).toFixed(3)}</span></li>`).join('')
        : '<li class="muted">нет данных</li>';
    $resultsStats.innerHTML = `
        <div class="stat-card glass">
            <div class="stat-label">Изображений</div>
            <div class="stat-value">${nodes.length}</div>
        </div>
        <div class="stat-card glass">
            <div class="stat-label">Сравнений</div>
            <div class="stat-value">${links.length}</div>
        </div>
        <div class="stat-card glass stat-top">
            <div class="stat-label">Топ-3 по рейтингу</div>
            <ol class="stat-top-list">${topHtml}</ol>
        </div>
    `;
}

function ensureGraphResizeObserver() {
    if (state.graphResizeObs) return;
    const container = $graphSvg.parentElement;
    state.graphResizeObs = new ResizeObserver(() => {
        if (state.graphData && $resultsScreen.classList.contains('active')) {
            drawGraph(state.graphData);
        }
    });
    state.graphResizeObs.observe(container);
}

function drawGraph(graph) {
    const svg = d3.select($graphSvg);
    svg.selectAll('*').remove();
    $graphEmpty.classList.toggle('hidden', !!graph.nodes?.length);
    if (!graph.nodes?.length) return;

    const rect = $graphSvg.getBoundingClientRect();
    const width = Math.max(rect.width, 320);
    const height = Math.max(rect.height, 320);

    svg.attr('viewBox', `0 0 ${width} ${height}`)
       .attr('preserveAspectRatio', 'xMidYMid meet');

    const g = svg.append('g');

    const zoom = d3.zoom().scaleExtent([0.2, 4])
        .on('zoom', (e) => g.attr('transform', e.transform));
    svg.call(zoom);

    const ratings = graph.nodes.map((n) => n.rating || 1);
    const rMin = Math.min(...ratings);
    const rMax = Math.max(...ratings);
    const sizeScale = d3.scaleLinear()
        .domain([rMin, rMax === rMin ? rMin + 1 : rMax])
        .range([6, 22]);

    const links = (graph.links || []).map((l) => ({ ...l }));
    const nodes = (graph.nodes || []).map((n) => ({ ...n }));

    const sim = d3.forceSimulation(nodes)
        .force('link', d3.forceLink(links).id((d) => d.id).distance(100))
        .force('charge', d3.forceManyBody().strength(-220))
        .force('center', d3.forceCenter(width / 2, height / 2))
        .force('collide', d3.forceCollide().radius((d) => sizeScale(d.rating || 1) + 4));

    const linkSel = g.append('g')
        .attr('class', 'graph-links')
        .selectAll('line')
        .data(links)
        .enter().append('line')
        .attr('stroke', (d) => {
            const r = d.result;
            return r === '<' ? '#00c9a7' : r === '>' ? '#ff6b6b' : '#ffc107';
        })
        .attr('stroke-opacity', 0.6)
        .attr('stroke-width', 2);

    linkSel.on('mouseenter', (e, d) => {
        const winner = d.result === '<' ? 'A (' + shortPath(d.source.id || d.source) + ')'
            : d.result === '>' ? 'B (' + shortPath(d.target.id || d.target) + ')'
                : 'ничья';
        showTooltip(e,
            `<b>Сравнение</b><br>` +
            `A: ${escapeHtml(shortPath(d.source.id || d.source))}<br>` +
            `B: ${escapeHtml(shortPath(d.target.id || d.target))}<br>` +
            `Результат: ${d.result} (${winner})` +
            (d.assessor ? `<br>Оценщик: ${escapeHtml(d.assessor)}` : '')
        );
    }).on('mousemove', moveTooltip).on('mouseleave', hideTooltip);

    const nodeSel = g.append('g')
        .attr('class', 'graph-nodes')
        .selectAll('circle')
        .data(nodes)
        .enter().append('circle')
        .attr('r', (d) => sizeScale(d.rating || 1))
        .attr('fill', '#6c63ff')
        .attr('fill-opacity', 0.85)
        .attr('stroke', '#fff')
        .attr('stroke-opacity', 0.4)
        .call(d3.drag()
            .on('start', (e, d) => { if (!e.active) sim.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y; })
            .on('drag', (e, d) => { d.fx = e.x; d.fy = e.y; })
            .on('end', (e, d) => { if (!e.active) sim.alphaTarget(0); d.fx = null; d.fy = null; })
        );

    nodeSel.on('mouseenter', (e, d) => {
        showTooltip(e,
            `<b>${escapeHtml(shortPath(d.id))}</b><br>` +
            `Рейтинг: ${(d.rating || 0).toFixed(3)}<br>` +
            `Сравнений: ${d.count || 0}`
        );
    }).on('mousemove', moveTooltip).on('mouseleave', hideTooltip);

    sim.on('tick', () => {
        linkSel
            .attr('x1', (d) => d.source.x)
            .attr('y1', (d) => d.source.y)
            .attr('x2', (d) => d.target.x)
            .attr('y2', (d) => d.target.y);
        nodeSel
            .attr('cx', (d) => d.x)
            .attr('cy', (d) => d.y);
    });
}

function showTooltip(event, html) {
    $graphTooltip.innerHTML = html;
    $graphTooltip.classList.remove('hidden');
    moveTooltip(event);
}

function moveTooltip(event) {
    $graphTooltip.style.left = (event.pageX + 14) + 'px';
    $graphTooltip.style.top = (event.pageY + 14) + 'px';
}

function hideTooltip() {
    $graphTooltip.classList.add('hidden');
}

/* ---------- Страница рейтингов BT ---------- */

async function switchToBt() {
    showScreen($btScreen);
    setLoading(true);
    try {
        const critRes = await fetch(API_BASE + '?action=criteria').then((r) => r.json());
        $btCriterion.innerHTML = '';
        (critRes.criteria || []).forEach((c) => {
            const opt = document.createElement('option');
            opt.value = c.id;
            opt.textContent = c.name;
            $btCriterion.appendChild(opt);
        });
        await renderBt(true);
    } catch (err) {
        console.error(err);
        showToast('Не удалось загрузить рейтинги.', 'error');
    } finally {
        setLoading(false);
    }
}

async function renderBt(recompute) {
    const criterionId = parseInt($btCriterion.value, 10);
    if (!criterionId) return;
    setLoading(true);
    try {
        const url = API_BASE + '?action=bt_results&criterion_id=' + criterionId
            + (recompute ? '&_t=' + Date.now() : '');
        const res = await fetch(url);
        const data = await res.json();
        if (data.error) {
            showToast(data.error, 'error');
            return;
        }
        renderBtSummary(data);
        renderBtTable(data.ratings || []);
    } catch (err) {
        console.error(err);
        showToast('Не удалось загрузить отчёт.', 'error');
    } finally {
        setLoading(false);
    }
}

function renderBtSummary(d) {
    const a = d.algorithm || {};
    const s = d.stats || {};
    const r = s.by_result || {};
    $btSummary.innerHTML = `
        <div class="bt-summary-card glass">
            <div class="bt-summary-label">Изображений</div>
            <div class="bt-summary-value">${s.images ?? 0}</div>
        </div>
        <div class="bt-summary-card glass">
            <div class="bt-summary-label">Сравнений</div>
            <div class="bt-summary-value">${s.comparisons ?? 0}</div>
        </div>
        <div class="bt-summary-card glass">
            <div class="bt-summary-label">Результаты</div>
            <div class="bt-summary-breakdown">
                <span class="sign-left">A &gt; B: ${r['<'] ?? 0}</span>
                <span class="sign-equal">=: ${r['='] ?? 0}</span>
                <span class="sign-right">B &gt; A: ${r['>'] ?? 0}</span>
            </div>
        </div>
        <div class="bt-summary-card glass bt-summary-algo">
            <div class="bt-summary-label">Параметры</div>
            <div class="bt-summary-algo-list">
                <span>λ = ${a.lambda}</span>
                <span>ε = ${a.epsilon}</span>
                <span>max_iter = ${a.max_iterations}</span>
                <span class="muted">${escapeHtml(a.normalization || '')}</span>
            </div>
        </div>
    `;
}

function renderBtTable(ratings) {
    if (!ratings.length) {
        $btTbody.innerHTML = '<tr><td colspan="6" class="bt-empty">Нет данных. Сначала проведите сравнения.</td></tr>';
        return;
    }
    const maxRating = Math.max(...ratings.map((r) => parseFloat(r.bt_score) || 0)) || 1;
    $btTbody.innerHTML = ratings.map((r, i) => {
        const score = parseFloat(r.bt_score) || 0;
        const pct = (score / maxRating) * 100;
        const url = API_BASE + '?action=image&path=' + encodeURIComponent(r.image_path);
        return `
            <tr>
                <td class="td-rank">${i + 1}</td>
                <td class="td-preview"><img src="${url}" alt="" loading="lazy"></td>
                <td class="td-path"><span title="${escapeHtml(r.image_path)}">${escapeHtml(r.image_path)}</span></td>
                <td class="td-bt">${score.toFixed(4)}</td>
                <td class="td-bar">
                    <div class="bt-bar-track">
                        <div class="bt-bar-fill" style="width:${pct.toFixed(1)}%"></div>
                    </div>
                </td>
                <td class="td-count">${r.comparison_count}</td>
            </tr>
        `;
    }).join('');
}

/* ---------- Легенда графа ---------- */

function setLegendCollapsed(collapsed) {
    $graphLegend.classList.toggle('collapsed', collapsed);
    $legendToggle.classList.toggle('visible', collapsed);
}

/* ---------- Полноэкранный граф ---------- */

function toggleGraphFullscreen() {
    const isMax = $resultsScreen.classList.toggle('graph-maximized');
    $graphFullscreen.title = isMax ? 'Свернуть' : 'Развернуть на весь экран';
    $graphFullscreen.setAttribute(
        'aria-label',
        isMax ? 'Свернуть граф' : 'Развернуть граф'
    );
    // Перерисовка через ResizeObserver сработает автоматически, но дёрнем вручную
    // для гарантированного обновления центрирования force-симуляции.
    requestAnimationFrame(() => {
        if (state.graphData) drawGraph(state.graphData);
    });
}

/* ---------- Фильтр изображений ---------- */

/**
 * Открытие модала. Если у пользователя ещё нет применённого фильтра —
 * чекбоксы открываются ПУСТЫМИ (хотя по факту все изображения участвуют —
 * это просто стартовый «холст» для выбора). Если фильтр уже применён —
 * показываем сохранённый набор.
 */
async function openFilterModal() {
    $filterModal.classList.remove('hidden');
    if (!state.treeCache) {
        $filterTree.innerHTML = '<div class="filter-loading">Загрузка…</div>';
        try {
            const res = await fetch(API_BASE + '?action=tree');
            const data = await res.json();
            if (data.error) {
                showToast(data.error, 'error');
                closeFilterModal();
                return;
            }
            state.treeCache = data;
        } catch (err) {
            console.error(err);
            showToast('Не удалось загрузить дерево.', 'error');
            closeFilterModal();
            return;
        }
    }
    // Локальный (модальный) рабочий набор — отделён от state.selectedPaths,
    // чтобы можно было «Отмена» без побочных эффектов.
    if (state.filterActive) {
        state.workingSelected = new Set(state.selectedPaths);
    } else {
        // Дефолт: ничего не выбрано.
        state.workingSelected = new Set();
    }
    renderFilterTree();
}

function closeFilterModal() {
    $filterModal.classList.add('hidden');
}

/**
 * Рендерит дерево: <details>/<summary> для папок (свёрнуты по умолчанию),
 * чекбоксы на каждом узле. Папка автоматически отображает indeterminate-
 * состояние, когда часть её потомков выключена.
 */
function renderFilterTree() {
    $filterTree.innerHTML = '';
    const root = buildFilterNode(state.treeCache, '');
    $filterTree.appendChild(root);
    updateAllFolderStates();
    updateFilterCount();
}

/**
 * Рекурсивно строит DOM-узел.
 */
function buildFilterNode(node, parentPath) {
    if (node.type === 'file') {
        const li = document.createElement('div');
        li.className = 'filter-item filter-file';
        li.dataset.path = node.path;
        // Файл «включён», если он в рабочем наборе. По дефолту (фильтр не
        // применялся) набор пуст — все чекбоксы пустые.
        const checked = state.workingSelected.has(node.path);
        li.innerHTML = `
            <label class="filter-row">
                <input type="checkbox" class="filter-cb" ${checked ? 'checked' : ''}>
                <span class="filter-icon">🖼</span>
                <span class="filter-label" title="${escapeHtml(node.path)}">${escapeHtml(node.name)}</span>
            </label>
        `;
        const cb = li.querySelector('input');
        cb.addEventListener('change', (e) => {
            handleFileToggle(node.path, e.target.checked);
            updateAllFolderStates();
            updateFilterCount();
        });
        return li;
    }

    // Папка. Используем обычный <div> со своим data-expanded, чтобы
    // раскрытие управлялось ТОЛЬКО кнопкой-треугольником, а клик по имени
    // папки не вызывал её раскрытия (поведение, как в проводнике).
    const folder = document.createElement('div');
    folder.className = 'filter-item filter-folder';
    folder.dataset.folder = parentPath ? parentPath + '/' + node.name : node.name;
    folder.dataset.expanded = 'false';

    const row = document.createElement('div');
    row.className = 'filter-row filter-folder-row';
    row.innerHTML = `
        <button type="button" class="filter-expand-btn"
                aria-expanded="false" aria-label="Раскрыть">▶</button>
        <input type="checkbox" class="filter-cb folder-cb">
        <span class="filter-icon">📁</span>
        <span class="filter-label">${escapeHtml(node.name)}</span>
        <span class="filter-folder-meta"></span>
    `;
    folder.appendChild(row);

    const childrenWrap = document.createElement('div');
    childrenWrap.className = 'filter-children';
    childrenWrap.hidden = true;
    (node.children || []).forEach((child) => {
        childrenWrap.appendChild(buildFilterNode(child, folder.dataset.folder));
    });
    folder.appendChild(childrenWrap);

    // Кнопка-треугольник — единственный триггер раскрытия.
    const expandBtn = row.querySelector('.filter-expand-btn');
    expandBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleFolderOpen(folder, !isFolderOpen(folder));
    });

    // Чекбокс папки переключает все вложенные файлы.
    const folderCb = row.querySelector('input');
    folderCb.addEventListener('click', (e) => e.stopPropagation());
    folderCb.addEventListener('change', (e) => {
        const enabled = e.target.checked;
        folder.querySelectorAll('.filter-file').forEach((fileEl) => {
            const cb = fileEl.querySelector('input');
            cb.checked = enabled;
            handleFileToggle(fileEl.dataset.path, enabled);
        });
        updateAllFolderStates();
        updateFilterCount();
    });

    return folder;
}

function isFolderOpen(folder) {
    return folder.dataset.expanded === 'true';
}

function toggleFolderOpen(folder, open) {
    folder.dataset.expanded = open ? 'true' : 'false';
    const childrenWrap = folder.querySelector(':scope > .filter-children');
    if (childrenWrap) childrenWrap.hidden = !open;
    const btn = folder.querySelector(':scope > .filter-row > .filter-expand-btn');
    if (btn) {
        btn.textContent = open ? '▼' : '▶';
        btn.setAttribute('aria-expanded', open ? 'true' : 'false');
        btn.setAttribute('aria-label', open ? 'Свернуть' : 'Раскрыть');
    }
}

function handleFileToggle(path, enabled) {
    // Изменения копятся в рабочем наборе модала; в state.selectedPaths
    // они переносятся только по «Применить».
    if (enabled) state.workingSelected.add(path);
    else state.workingSelected.delete(path);
}

/**
 * Пересчитывает состояния (checked / indeterminate) у всех папок исходя из
 * состояния файлов внутри.
 */
function updateAllFolderStates() {
    $filterTree.querySelectorAll('.filter-folder').forEach((folder) => {
        const fileCbs = folder.querySelectorAll('.filter-file input');
        let on = 0, off = 0;
        fileCbs.forEach((cb) => cb.checked ? on++ : off++);
        const folderCb = folder.querySelector(':scope > summary .folder-cb');
        const meta = folder.querySelector(':scope > summary .filter-folder-meta');
        if (on === 0) {
            folderCb.checked = false;
            folderCb.indeterminate = false;
        } else if (off === 0) {
            folderCb.checked = true;
            folderCb.indeterminate = false;
        } else {
            folderCb.checked = false;
            folderCb.indeterminate = true;
        }
        if (meta) meta.textContent = `${on} / ${on + off}`;
    });
}

function updateFilterCount() {
    const allFiles = $filterTree.querySelectorAll('.filter-file');
    const enabled = Array.from(allFiles).filter(
        (el) => el.querySelector('input').checked
    ).length;
    $filterCount.textContent = `Включено: ${enabled} / ${allFiles.length}`;
}

function bulkSetFilter(exclude) {
    $filterTree.querySelectorAll('.filter-file').forEach((fileEl) => {
        const cb = fileEl.querySelector('input');
        cb.checked = !exclude;
        handleFileToggle(fileEl.dataset.path, !exclude);
    });
    updateAllFolderStates();
    updateFilterCount();
}

function bulkExpandFilter(open) {
    $filterTree.querySelectorAll('.filter-folder').forEach((f) => {
        toggleFolderOpen(f, open);
    });
}

async function applyFilter() {
    // Если ничего не выбрано — фильтр снимается (дефолтное состояние:
    // все изображения участвуют).
    if (state.workingSelected.size === 0) {
        state.filterActive = false;
        state.selectedPaths = new Set();
        localStorage.setItem('filterActive', '0');
        localStorage.setItem('selectedPaths', '[]');
        closeFilterModal();
        showToast('Фильтр снят: участвуют все изображения', 'success');
    } else {
        state.filterActive = true;
        state.selectedPaths = new Set(state.workingSelected);
        localStorage.setItem('filterActive', '1');
        localStorage.setItem(
            'selectedPaths',
            JSON.stringify(Array.from(state.selectedPaths))
        );
        closeFilterModal();
        showToast(
            `Фильтр применён: участвуют ${state.selectedPaths.size} изображений`,
            'success'
        );
    }
    if ($comparisonScreen.classList.contains('active')) {
        await loadPair();
    }
}

/* ---------- Лайтбокс изображений ---------- */

const lb = {
    scale: 1,
    tx: 0,
    ty: 0,
    dragging: false,
    dragStartX: 0,
    dragStartY: 0,
    minScale: 1,
    maxScale: 8,
    zoomStep: 1.18,
};

function applyLightboxTransform() {
    $lightboxImg.style.transform =
        `translate(calc(-50% + ${lb.tx}px), calc(-50% + ${lb.ty}px)) scale(${lb.scale})`;
    $lightboxImg.classList.toggle('zoomed', lb.scale > 1.001);
    $lightboxZoomInfo.textContent = Math.round(lb.scale * 100) + '%';
}

function resetLightbox() {
    lb.scale = 1;
    lb.tx = 0;
    lb.ty = 0;
    lb.dragging = false;
    $lightboxImg.classList.remove('dragging');
    applyLightboxTransform();
}

function openLightbox(src) {
    if (!src) return;
    $lightboxImg.src = src;
    $lightbox.classList.remove('hidden');
    resetLightbox();
}

function closeLightbox() {
    $lightbox.classList.add('hidden');
    resetLightbox();
}

function handleLightboxWheel(e) {
    e.preventDefault();
    const delta = e.deltaY < 0 ? lb.zoomStep : 1 / lb.zoomStep;
    const newScale = Math.max(lb.minScale, Math.min(lb.maxScale, lb.scale * delta));
    if (newScale === lb.scale) return;

    // Якорь масштабирования у позиции курсора (cx, cy относительно центра вьюпорта).
    const rect = $lightboxViewport.getBoundingClientRect();
    const cx = e.clientX - (rect.left + rect.width / 2);
    const cy = e.clientY - (rect.top + rect.height / 2);
    const r = newScale / lb.scale;
    lb.tx = cx * (1 - r) + lb.tx * r;
    lb.ty = cy * (1 - r) + lb.ty * r;
    lb.scale = newScale;

    if (lb.scale <= 1.001) {
        lb.scale = 1;
        lb.tx = 0;
        lb.ty = 0;
    }
    applyLightboxTransform();
}

function handleLightboxDragStart(e) {
    if (e.button !== 0) return;
    if (lb.scale <= 1.001) return;
    e.preventDefault();
    lb.dragging = true;
    lb.dragStartX = e.clientX - lb.tx;
    lb.dragStartY = e.clientY - lb.ty;
    $lightboxImg.classList.add('dragging');
}

function handleLightboxDragMove(e) {
    if (!lb.dragging) return;
    lb.tx = e.clientX - lb.dragStartX;
    lb.ty = e.clientY - lb.dragStartY;
    applyLightboxTransform();
}

function handleLightboxDragEnd() {
    if (!lb.dragging) return;
    lb.dragging = false;
    $lightboxImg.classList.remove('dragging');
}

/* ---------- Горячие клавиши ---------- */

function handleKeyboard(e) {
    // Esc закрывает лайтбокс / модал фильтра независимо от экрана.
    if (e.key === 'Escape' && !$lightbox.classList.contains('hidden')) {
        e.preventDefault();
        closeLightbox();
        return;
    }
    if (e.key === 'Escape' && !$filterModal.classList.contains('hidden')) {
        e.preventDefault();
        closeFilterModal();
        return;
    }

    if (document.activeElement && document.activeElement.tagName === 'INPUT') return;
    if (!$comparisonScreen.classList.contains('active')) return;

    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        const last = state.history.find((h) => !h.is_undone);
        if (last) {
            e.preventDefault();
            undoRound(last.id);
        }
    }
}

/* ---------- Утилиты UI ---------- */

function setLoading(show) {
    state.isLoading = show;
    $loadingOverlay.classList.toggle('hidden', !show);
}

function updateCounter() {
    $counterBadge.textContent = state.voteCount + ' ' + pluralize(state.voteCount);
}

function pluralize(n) {
    const m10 = n % 10, m100 = n % 100;
    if (m100 >= 11 && m100 <= 14) return 'оценок';
    if (m10 === 1) return 'оценка';
    if (m10 >= 2 && m10 <= 4) return 'оценки';
    return 'оценок';
}

function showToast(message, type) {
    type = type || 'success';
    const toast = document.createElement('div');
    toast.className = 'toast toast-' + type;
    toast.textContent = message;
    $toastContainer.appendChild(toast);
    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateX(40px)';
        toast.style.transition = 'all 0.3s ease';
        setTimeout(() => toast.remove(), 320);
    }, 3000);
}

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
}
