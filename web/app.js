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
const HISTORY_LIMIT = 20;

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

const $historyList = $('history-list');

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
    $nextPairBtn.addEventListener('click', () => loadPair());

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
                submitCriterionVote(s.criterion_id, btn.dataset.vote)
            );
        });
        $criteriaRows.appendChild(row);
    });
    updateRoundProgress();
}

/* ---------- Загрузка пары ---------- */

async function loadPair() {
    setLoading(true);
    state.viewingHistory = false;
    state.pairVotes.clear();
    try {
        const res = await fetch(API_BASE + '?action=pair');
        const data = await res.json();
        if (data.error) {
            showToast(data.error, 'error');
            return;
        }
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

async function submitCriterionVote(criterionId, sign) {
    if (state.viewingHistory) {
        showToast('Просмотр истории — голосование недоступно.', 'error');
        return;
    }
    if (!state.currentLeft || !state.currentRight) return;
    const session = state.sessions.find((s) => s.criterion_id === criterionId);
    if (!session) return;

    if (state.pairVotes.has(criterionId)) {
        showToast('Этот критерий уже оценён в текущей паре. Перейдите к следующей.', 'error');
        return;
    }

    const row = document.querySelector(`.criterion-row[data-criterion-id="${criterionId}"]`);
    row?.querySelectorAll('.btn-vote-mini').forEach((b) => {
        b.disabled = true;
    });

    try {
        const body = new URLSearchParams({
            action: 'vote',
            session_id: String(session.session_id),
            left: state.currentLeft,
            right: state.currentRight,
            sign,
        });
        const res = await fetch(API_BASE, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: body.toString(),
        });
        const result = await res.json();
        if (result.error) {
            showToast(result.error, 'error');
            row?.querySelectorAll('.btn-vote-mini').forEach((b) => { b.disabled = false; });
            return;
        }

        state.pairVotes.set(criterionId, sign);
        state.voteCount++;
        SS.setItem('voteCount', String(state.voteCount));
        updateCounter();

        if (row) {
            row.classList.add('done');
            row.querySelectorAll('.btn-vote-mini').forEach((b) => {
                b.classList.toggle('active', b.dataset.vote === sign);
                b.disabled = false;
            });
        }

        // Добавляем запись в начало истории.
        state.history.unshift({
            id: result.comparison_id,
            number: result.number,
            criterion_id: criterionId,
            criterion_name: session.criterion_name,
            image_left: state.currentLeft,
            image_right: state.currentRight,
            result: sign,
            is_undone: 0,
        });
        if (state.history.length > HISTORY_LIMIT) state.history.pop();
        renderHistory();

        if (result.auto_backup) showToast('Автобэкап создан', 'success');

        updateRoundProgress();
    } catch (err) {
        console.error(err);
        showToast('Не удалось отправить оценку.', 'error');
        row?.querySelectorAll('.btn-vote-mini').forEach((b) => { b.disabled = false; });
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
        state.history = data.history || [];
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

function renderHistory() {
    $historyList.innerHTML = '';
    if (!state.history.length) {
        const empty = document.createElement('li');
        empty.className = 'history-empty';
        empty.textContent = 'Сравнений пока нет';
        $historyList.appendChild(empty);
        return;
    }
    state.history.forEach((h) => {
        const li = document.createElement('li');
        li.className = 'history-item' + (h.is_undone ? ' undone' : '');
        const numberLabel = h.number ? '#' + h.number : '✕';
        const sign = h.result;
        li.innerHTML = `
            <button class="history-show" title="Показать пару">
                <span class="history-number">${numberLabel}</span>
                <span class="history-pair">
                    <span class="history-criterion">${escapeHtml(h.criterion_name || '')}</span>
                    <span class="history-route">
                        <span class="history-path">${escapeHtml(shortPath(h.image_left))}</span>
                        <span class="history-sign sign-${signClass(sign)}">${sign}</span>
                        <span class="history-path">${escapeHtml(shortPath(h.image_right))}</span>
                    </span>
                </span>
            </button>
            ${h.is_undone
                ? '<span class="history-undone-tag">отменено</span>'
                : `<button class="history-undo" title="Отменить">↩</button>`
            }
        `;
        const showBtn = li.querySelector('.history-show');
        showBtn.addEventListener('click', () => {
            showPair(h.image_left, h.image_right, true);
            highlightHistoryItem(li);
            showToast('Просмотр сравнения #' + (h.number || '—'), 'success');
        });
        const undoBtn = li.querySelector('.history-undo');
        if (undoBtn) {
            undoBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                undoComparison(h.id);
            });
        }
        $historyList.appendChild(li);
    });
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

async function undoComparison(comparisonId) {
    setLoading(true);
    try {
        const fd = new URLSearchParams({
            action: 'undo',
            comparison_id: String(comparisonId),
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
        showToast('Сравнение отменено', 'success');
        const item = state.history.find((h) => h.id === comparisonId);
        if (item) {
            item.is_undone = 1;
            item.number = null;
        }
        if (state.voteCount > 0) state.voteCount--;
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
    // Esc закрывает лайтбокс независимо от экрана.
    if (e.key === 'Escape' && !$lightbox.classList.contains('hidden')) {
        e.preventDefault();
        closeLightbox();
        return;
    }

    if (document.activeElement && document.activeElement.tagName === 'INPUT') return;
    if (!$comparisonScreen.classList.contains('active')) return;

    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        const last = state.history.find((h) => !h.is_undone);
        if (last) {
            e.preventDefault();
            undoComparison(last.id);
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
