/**
 * AI Studio — Renderer
 * Handles all UI logic, API calls, and dynamic rendering.
 */

; (function () {
    'use strict';

    // ==================== State ====================
    const state = {
        scriptId: 1,
        scenes: [],
        images: [],
        isGenerating: false,
        pollTimer: null,
        gridSize: 'sm',
        tokenPool: [],
        tokenIndex: 0,
        autoRotate: true,
        retryOnFailure: true,
        generationLog: [],
        prevSceneStatuses: {},
        geminiApiKey: '',
        apStopRequested: false,
        apImages: [],
        apPollTimer: null,
        // Video Render
        vrScannedFiles: [],         // [{name, path, size_kb}]
        vrOutputDir: '',            // resolved output dir from backend
        vrPollTimer: null,
        vrRendering: false,
    };
    const TIMEOUTS_BETWEEN_REQUESTS = 3000;

    // ==================== DOM Refs ====================
    const $ = (sel) => document.querySelector(sel);
    const $$ = (sel) => document.querySelectorAll(sel);

    const els = {
        editor: $('#script-editor'),
        wordCount: $('#word-count'),
        scenesList: $('#scenes-list'),
        galleryGrid: $('#gallery-grid'),
        btnAnalyze: $('#btn-analyze'),
        btnAnalyzeRegex: $('#btn-analyze-regex'),
        btnGenerateAll: $('#btn-generate-all'),
        btnExportZip: $('#btn-export-zip'),
        btnRefreshAll: $('#btn-refresh-all'),
        btnGridSm: $('#btn-grid-sm'),
        btnGridLg: $('#btn-grid-lg'),
        batchStatus: $('#batch-status'),
        progressText: $('#progress-text'),
        btnTokenPool: $('#btn-token-pool'),
        tokenModal: $('#token-pool-modal'),
        errorModal: $('#error-popup-modal'),
        logPanel: $('#log-panel'),
        logEntries: $('#log-entries'),
        geminiKeyInput: $('#gemini-api-key'),

        // Video Render
        vrInputDir: $('#vr-input-dir'),
        vrOutputDir: $('#vr-output-dir'),
        vrDuration: $('#vr-duration'),
        vrWorkers: $('#vr-workers'),
        vrScanInfo: $('#vr-scan-info'),
        vrFileList: $('#vr-file-list'),
        vrFileCount: $('#vr-file-count'),
        vrEmptyMsg: $('#vr-empty-msg'),
        vrResultGrid: $('#vr-result-grid'),
        vrProgressContainer: $('#vr-progress-container'),
        vrProgressText: $('#vr-progress-text'),
        vrProgressPct: $('#vr-progress-pct'),
        vrProgressBar: $('#vr-progress-bar'),
        btnVrScan: $('#btn-vr-scan'),
        btnVrRender: $('#btn-vr-render'),
        btnVrRetryFailed: $('#btn-vr-retry-failed'),
        btnVrBrowseInput: $('#btn-vr-browse-input'),
        btnVrBrowseOutput: $('#btn-vr-browse-output'),

        // Auto Prompter
        apKeyPool: $('#ap-key-pool'),
        apScript: $('#ap-script'),
        apDuration: $('#ap-duration'),
        apPacing: $('#ap-pacing'),
        apStats: $('#ap-stats'),
        apStyle: $('#ap-style'),
        apScenesList: $('#ap-scenes-list'),
        apEmptyMsg: $('#ap-empty-msg'),
        btnApGenerate: $('#btn-ap-generate'),
        btnApClear: $('#btn-ap-clear'),
        apProgressContainer: $('#ap-progress-container'),
        apProgressText: $('#ap-progress-text'),
        apProgressPct: $('#ap-progress-pct'),
        apProgressBar: $('#ap-progress-bar'),
        viewMain: $('#view-main'),
        viewAutoPrompt: $('#view-autoprompt'),
        btnApStop: $('#btn-ap-stop'),
        btnApRetryAll: $('#btn-ap-retry-all'),
        btnApRetryFailed: $('#btn-ap-retry-failed'),
        apGalleryGrid: $('#ap-gallery-grid'),
        btnApGridSm: $('#btn-ap-grid-sm'),
        btnApGridLg: $('#btn-ap-grid-lg'),
    };

    // ==================== Init ====================
    function switchSection(section) {
        $$('.nav-item').forEach((item) => {
            item.classList.toggle('active', item.dataset.section === section);
        });

        if (section === 'autoprompt') {
            if (els.viewMain) els.viewMain.style.display = 'none';
            if (els.viewAutoPrompt) els.viewAutoPrompt.style.display = 'flex';
        } else {
            if (els.viewAutoPrompt) els.viewAutoPrompt.style.display = 'none';
            if (els.viewMain) els.viewMain.style.display = 'flex';
        }
    }

    function init() {
        // Set Auto Prompter as default view logic
        switchSection('autoprompt');

        updateWordCount();
        bindEvents();
        loadTokenPool();
        loadGeminiKey();
        // Try to load existing scenes
        loadExistingScenes();
    }

    function bindEvents() {
        if (els.editor) els.editor.addEventListener('input', updateWordCount);
        if (els.btnAnalyze) els.btnAnalyze.addEventListener('click', analyzeScript);
        if (els.btnAnalyzeRegex) els.btnAnalyzeRegex.addEventListener('click', analyzeScriptRegex);
        if (els.btnGenerateAll) els.btnGenerateAll.addEventListener('click', generateAllImages);
        if (els.btnExportZip) els.btnExportZip.addEventListener('click', exportZip);
        if (els.btnRefreshAll) els.btnRefreshAll.addEventListener('click', refreshAll);
        if (els.btnGridSm) els.btnGridSm.addEventListener('click', () => setGridSize('sm'));
        if (els.btnGridLg) els.btnGridLg.addEventListener('click', () => setGridSize('lg'));

        // Token pool modal
        els.btnTokenPool.addEventListener('click', openTokenModal);
        $('#modal-close-x').addEventListener('click', closeTokenModal);
        $('#modal-close-btn').addEventListener('click', closeTokenModal);
        $('#modal-save-btn').addEventListener('click', saveTokenPool);
        $('#btn-add-token').addEventListener('click', addTokenFromInput);
        $('#token-add-input').addEventListener('keydown', (e) => {
            if (e.key === 'Enter') addTokenFromInput();
        });
        els.tokenModal.addEventListener('click', (e) => {
            if (e.target === els.tokenModal) closeTokenModal();
        });

        // Error popup
        $('#error-popup-close').addEventListener('click', closeErrorPopup);
        $('#error-popup-dismiss').addEventListener('click', closeErrorPopup);
        els.errorModal.addEventListener('click', (e) => {
            if (e.target === els.errorModal) closeErrorPopup();
        });

        // Log panel
        $('#btn-view-log').addEventListener('click', toggleLogPanel);
        $('#btn-close-log').addEventListener('click', () => els.logPanel.classList.remove('active'));
        $('#btn-clear-log').addEventListener('click', clearLog);

        // Nav items
        $$('.nav-item').forEach((item) => {
            item.addEventListener('click', (e) => {
                e.preventDefault();
                switchSection(item.dataset.section);
            });
        });

        // Auto Prompter Calc
        const calcApStats = () => {
            if (!els.apDuration || !els.apPacing || !els.apStats) return;
            const dur = parseFloat(els.apDuration.value) || 0;
            const pacing = parseFloat(els.apPacing.value) || 1;
            const prompts = Math.max(1, Math.ceil(dur / pacing));
            els.apStats.textContent = `Số prompts: ${prompts}`;
        };
        if (els.apDuration) els.apDuration.addEventListener('input', calcApStats);
        if (els.apPacing) els.apPacing.addEventListener('input', calcApStats);

        // Auto Prompter actions
        if (els.btnApClear) els.btnApClear.addEventListener('click', () => {
            if (els.apScenesList) {
                els.apScenesList.innerHTML = '';
                if (els.apEmptyMsg) {
                    els.apScenesList.appendChild(els.apEmptyMsg);
                    els.apEmptyMsg.style.display = '';
                }
            }
        });
        if (els.btnApGenerate) els.btnApGenerate.addEventListener('click', () => apGeneratePrompts());
        if (els.btnApStop) els.btnApStop.addEventListener('click', () => { state.apStopRequested = true; });
        if (els.btnApRetryAll) els.btnApRetryAll.addEventListener('click', () => apGeneratePrompts('all'));
        if (els.btnApRetryFailed) els.btnApRetryFailed.addEventListener('click', () => apGeneratePrompts('failed'));

        // AP Gallery: Retry failed images button
        const btnRetryFailedImages = document.getElementById('btn-ap-retry-failed-images');
        if (btnRetryFailedImages) btnRetryFailedImages.addEventListener('click', apRetryFailedImages);

        // AP Gallery: delegate click for per-image regen buttons
        if (els.apGalleryGrid) {
            els.apGalleryGrid.addEventListener('click', (e) => {
                const btn = e.target.closest('.btn-gallery-regen');
                if (btn) {
                    const sceneId = parseInt(btn.dataset.sceneId, 10);
                    if (sceneId) apRegenSingleImage(sceneId);
                }
            });
        }

        if (els.apScenesList) {
            els.apScenesList.addEventListener('click', (e) => {
                if (e.target.closest('.btn-ap-regenerate')) {
                    const card = e.target.closest('.scene-card');
                    if (card) {
                        const index = parseInt(card.dataset.promptIndex);
                        apGeneratePrompts('single', [index]);
                    }
                }
            });
        }

        // AP Gallery grid size
        if (els.btnApGridSm) els.btnApGridSm.addEventListener('click', () => {
            if (els.apGalleryGrid) els.apGalleryGrid.classList.remove('grid-lg');
            if (els.btnApGridSm) els.btnApGridSm.classList.add('active');
            if (els.btnApGridLg) els.btnApGridLg.classList.remove('active');
        });
        if (els.btnApGridLg) els.btnApGridLg.addEventListener('click', () => {
            if (els.apGalleryGrid) els.apGalleryGrid.classList.add('grid-lg');
            if (els.btnApGridLg) els.btnApGridLg.classList.add('active');
            if (els.btnApGridSm) els.btnApGridSm.classList.remove('active');
        });

        // ==================== Video Render Events ====================
        if (els.btnVrBrowseInput) els.btnVrBrowseInput.addEventListener('click', async () => {
            const folder = await window.api.selectFolder('Chọn thư mục ảnh (Input)');
            if (folder && els.vrInputDir) els.vrInputDir.value = folder;
        });
        if (els.btnVrBrowseOutput) els.btnVrBrowseOutput.addEventListener('click', async () => {
            const folder = await window.api.selectFolder('Chọn thư mục video (Output)');
            if (folder && els.vrOutputDir) els.vrOutputDir.value = folder;
        });

        if (els.btnVrScan) els.btnVrScan.addEventListener('click', vrScanFolder);
        if (els.btnVrRender) els.btnVrRender.addEventListener('click', vrStartRender);
        if (els.btnVrRetryFailed) els.btnVrRetryFailed.addEventListener('click', vrRetryFailed);

        // VR result grid — delegate click for single re-render buttons
        if (els.vrResultGrid) {
            els.vrResultGrid.addEventListener('click', (e) => {
                const btn = e.target.closest('.btn-vr-rerender');
                if (btn) {
                    const imgPath = btn.dataset.imagePath;
                    if (imgPath) vrRenderSingle(imgPath);
                }
            });
        }
    }

    // ==================== Word Count ====================
    function updateWordCount() {
        if (!els.editor || !els.wordCount) return;
        const text = els.editor.value.trim();
        const count = text ? text.split(/\s+/).length : 0;
        els.wordCount.textContent = `Word Count: ${count}`;
    }

    // ==================== Analyze Script ====================
    async function analyzeScript() {
        const text = els.editor.value.trim();
        if (!text) {
            showToast('Please enter a script to analyze.', 'error');
            return;
        }

        // Read and save Gemini API key
        const apiKey = els.geminiKeyInput.value.trim();
        if (!apiKey) {
            showToast('Please enter your Gemini API key.', 'error');
            addLogEntry('error', 'System', 'Gemini API key is missing. Enter your key near the Token Pool button.');
            els.geminiKeyInput.focus();
            return;
        }
        state.geminiApiKey = apiKey;
        saveGeminiKey();

        els.btnAnalyze.disabled = true;
        els.btnAnalyze.innerHTML = `
            <svg class="spin" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
            </svg>
            Analyzing...
        `;

        try {
            const result = await window.api.analyzeScript(text, state.scriptId, state.geminiApiKey);
            state.scenes = result.scenes;
            renderScenes();
            addLogEntry('success', 'System', `Gemini analyzed script: ${result.total_scenes} scenes found.`);
            showToast(`Found ${result.total_scenes} scenes.`, 'success');
        } catch (err) {
            addLogEntry('error', 'System', `Script analysis failed: ${err.message}`);
            showToast(`Analysis failed: ${err.message}`, 'error');
        } finally {
            els.btnAnalyze.disabled = false;
            els.btnAnalyze.innerHTML = `
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>
                </svg>
                Analyze Script
            `;
        }
    }

    async function analyzeScriptRegex() {
        const text = els.editor.value.trim();
        if (!text) {
            showToast('Please enter a script to analyze.', 'error');
            return;
        }

        els.btnAnalyzeRegex.disabled = true;
        els.btnAnalyzeRegex.innerHTML = `
            <svg class="spin" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
            </svg>
            Splitting...
        `;

        try {
            const result = await window.api.analyzeScriptRegex(text, state.scriptId, state.geminiApiKey);
            state.scenes = result.scenes;
            renderScenes();
            addLogEntry('success', 'System', `Regex analyzed script: ${result.total_scenes} scenes found.`);
            showToast(`Found ${result.total_scenes} scenes by regex.`, 'success');
        } catch (err) {
            addLogEntry('error', 'System', `Regex script analysis failed: ${err.message}`);
            showToast(`Regex analysis failed: ${err.message}`, 'error');
        } finally {
            els.btnAnalyzeRegex.disabled = false;
            els.btnAnalyzeRegex.innerHTML = `
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/>
                    <polyline points="7.5 4.21 12 6.81 16.5 4.21"/>
                    <polyline points="7.5 19.79 7.5 14.6 3 12"/>
                    <polyline points="21 12 16.5 14.6 16.5 19.79"/>
                    <line x1="12" y1="22.08" x2="12" y2="16.8"/>
                </svg>
                Script by Regex
            `;
        }
    }

    // ==================== Load Existing ====================
    async function loadExistingScenes() {
        try {
            const data = await window.api.getScenes(state.scriptId);
            if (data.scenes && data.scenes.length > 0) {
                state.scenes = data.scenes;
                renderScenes();
                await refreshStatus();
            }
        } catch (e) {
            // Backend may not be ready yet — silent fail
        }
    }

    // ==================== Render Scenes ====================
    function renderScenes() {
        if (!state.scenes.length) {
            els.scenesList.innerHTML = `
                <div class="scenes-empty">
                    <p>Click <strong>"Analyze Script"</strong> or <strong>"Script by Regex"</strong> to split your script into scenes.</p>
                </div>
            `;
            return;
        }

        els.scenesList.innerHTML = state.scenes.map((scene) => {
            const statusClass = scene.status || 'pending';
            const statusIcon = getStatusIcon(statusClass);
            const errorHint = scene.status === 'error' && scene.error_message
                ? `<div class="scene-error-hint" title="${escapeAttr(scene.error_message)}">
                       <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--status-error)" stroke-width="2">
                           <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
                       </svg>
                       <span>${truncate(scene.error_message, 60)}</span>
                   </div>`
                : '';

            return `
                <div class="scene-card status-${statusClass}" data-scene-id="${scene.id}">
                    <div class="scene-card-header">
                        <div class="scene-label">
                            <span class="scene-number">Scene ${String(scene.scene_number).padStart(2, '0')}</span>
                            <span class="scene-timestamp">${scene.timestamp_start}-${scene.timestamp_end}</span>
                        </div>
                        <div class="scene-card-actions">
                            <div class="scene-status-icon ${statusClass}">${statusIcon}</div>
                            <button class="btn-scene-delete" data-scene-id="${scene.id}" title="Delete scene">
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                    <polyline points="3 6 5 6 21 6"/>
                                    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
                                </svg>
                            </button>
                        </div>
                    </div>
                    ${errorHint}
                    <div class="scene-prompt-label">IMAGE PROMPT</div>
                    <textarea
                        class="scene-prompt-textarea"
                        data-scene-id="${scene.id}"
                        placeholder="Enter image generation prompt..."
                    >${scene.prompt || ''}</textarea>
                    <div class="scene-card-footer">
                        <button class="btn-regenerate" data-scene-id="${scene.id}">
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <path d="M21 2v6h-6M3 12a9 9 0 0 1 15-6.7L21 8M3 22v-6h6M21 12a9 9 0 0 1-15 6.7L3 16"/>
                            </svg>
                            Regenerate
                        </button>
                    </div>
                </div>
            `;
        }).join('');

        // Bind prompt update events
        els.scenesList.querySelectorAll('.scene-prompt-textarea').forEach((ta) => {
            let timeout;
            ta.addEventListener('input', () => {
                clearTimeout(timeout);
                timeout = setTimeout(() => {
                    const sceneId = parseInt(ta.dataset.sceneId);
                    window.api.updatePrompt(sceneId, ta.value).catch(() => { });
                }, 800);
            });
        });

        // Bind regenerate buttons
        els.scenesList.querySelectorAll('.btn-regenerate').forEach((btn) => {
            btn.addEventListener('click', () => {
                const sceneId = parseInt(btn.dataset.sceneId);
                regenerateScene(sceneId);
            });
        });

        // Bind delete buttons
        els.scenesList.querySelectorAll('.btn-scene-delete').forEach((btn) => {
            btn.addEventListener('click', () => {
                const sceneId = parseInt(btn.dataset.sceneId);
                deleteSceneConfirm(sceneId);
            });
        });
    }

    function getStatusIcon(status) {
        switch (status) {
            case 'success':
                return `<svg width="18" height="18" viewBox="0 0 24 24" fill="var(--status-success)">
                    <circle cx="12" cy="12" r="10"/>
                    <path d="M9 12l2 2 4-4" stroke="#fff" stroke-width="2" fill="none"/>
                </svg>`;
            case 'generating':
                return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2">
                    <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
                </svg>`;
            case 'error':
                return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--status-error)" stroke-width="2">
                    <rect x="3" y="3" width="18" height="18" rx="2"/>
                    <line x1="9" y1="9" x2="15" y2="15"/>
                    <line x1="15" y1="9" x2="9" y2="15"/>
                </svg>`;
            default:
                return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--status-pending)" stroke-width="2">
                    <rect x="3" y="3" width="18" height="18" rx="2"/>
                </svg>`;
        }
    }

    // ==================== Gemini API Key ====================
    function loadGeminiKey() {
        try {
            const saved = localStorage.getItem('ai_studio_gemini_key');
            if (saved) {
                state.geminiApiKey = saved;
                if (els.geminiKeyInput) els.geminiKeyInput.value = saved;
                if (els.apKeyPool) els.apKeyPool.value = saved;
            }
        } catch (e) { /* ignore */ }
    }

    function saveGeminiKey() {
        try {
            localStorage.setItem('ai_studio_gemini_key', state.geminiApiKey);
        } catch (e) { /* ignore */ }
    }

    // ==================== Token Pool ====================
    function getNextToken() {
        if (!state.tokenPool.length) return '';
        if (state.autoRotate) {
            const token = state.tokenPool[state.tokenIndex % state.tokenPool.length];
            state.tokenIndex++;
            return token;
        }
        return state.tokenPool[0];
    }

    function maskToken(token) {
        if (token.length <= 10) return '****' + token.slice(-4);
        return '****' + token.slice(-8);
    }

    function loadTokenPool() {
        try {
            const saved = localStorage.getItem('ai_studio_token_pool');
            if (saved) {
                const data = JSON.parse(saved);
                state.tokenPool = data.tokens || [];
                state.autoRotate = data.autoRotate !== false;
                state.retryOnFailure = data.retryOnFailure !== false;
                state.tokenIndex = data.tokenIndex || 0;
            }
        } catch (e) { /* ignore */ }
        updateTokenPoolButton();
    }

    function persistTokenPool() {
        localStorage.setItem('ai_studio_token_pool', JSON.stringify({
            tokens: state.tokenPool,
            autoRotate: state.autoRotate,
            retryOnFailure: state.retryOnFailure,
            tokenIndex: state.tokenIndex,
        }));
        updateTokenPoolButton();
    }

    function updateTokenPoolButton() {
        const count = state.tokenPool.length;
        const label = count > 0 ? `Token Pool (${count})` : 'Access Token Pool';
        els.btnTokenPool.innerHTML = `
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
                <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
            </svg>
            ${label}
        `;
        els.btnTokenPool.classList.toggle('has-tokens', count > 0);
    }

    function openTokenModal() {
        renderTokenList();
        $('#opt-auto-rotate').checked = state.autoRotate;
        $('#opt-retry-failure').checked = state.retryOnFailure;
        els.tokenModal.classList.add('active');
    }

    function closeTokenModal() {
        els.tokenModal.classList.remove('active');
    }

    function saveTokenPool() {
        state.autoRotate = $('#opt-auto-rotate').checked;
        state.retryOnFailure = $('#opt-retry-failure').checked;
        persistTokenPool();
        closeTokenModal();
        showToast(`Token pool saved (${state.tokenPool.length} tokens).`, 'success');
    }

    function addTokenFromInput() {
        const input = $('#token-add-input');
        const raw = input.value.trim();
        if (!raw) return;
        if (state.tokenPool.includes(raw)) {
            showToast('This token already exists in the pool.', 'error');
            return;
        }
        state.tokenPool.push(raw);
        input.value = '';
        persistTokenPool();
        renderTokenList();
    }

    function deleteToken(index) {
        state.tokenPool.splice(index, 1);
        if (state.tokenIndex >= state.tokenPool.length) state.tokenIndex = 0;
        persistTokenPool();
        renderTokenList();
    }

    function copyToken(index) {
        const token = state.tokenPool[index];
        navigator.clipboard.writeText(token).then(() => {
            showToast('Token copied to clipboard.', 'success');
        }).catch(() => {
            showToast('Failed to copy token.', 'error');
        });
    }

    function renderTokenList() {
        const container = $('#token-list-container');
        const emptyMsg = $('#token-list-empty');

        if (!state.tokenPool.length) {
            emptyMsg.style.display = '';
            // Remove all token rows
            container.querySelectorAll('.token-row').forEach(r => r.remove());
            return;
        }

        emptyMsg.style.display = 'none';
        // Remove old rows
        container.querySelectorAll('.token-row').forEach(r => r.remove());

        state.tokenPool.forEach((token, i) => {
            const row = document.createElement('div');
            row.className = 'token-row';
            row.innerHTML = `
                <span class="token-masked">${maskToken(token)}</span>
                <span class="token-status-dot active" title="Active"></span>
                <button class="token-action-btn" data-action="copy" data-index="${i}" title="Copy">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
                        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
                    </svg>
                </button>
                <button class="token-action-btn delete" data-action="delete" data-index="${i}" title="Delete">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <polyline points="3 6 5 6 21 6"/>
                        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
                    </svg>
                </button>
            `;
            container.appendChild(row);
        });

        // Bind action buttons
        container.querySelectorAll('.token-action-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const action = btn.dataset.action;
                const index = parseInt(btn.dataset.index);
                if (action === 'copy') copyToken(index);
                if (action === 'delete') deleteToken(index);
            });
        });
    }

    // ==================== Generate Images ====================
    // AP_SCRIPT_ID=2 is used for Auto Prompter scenes
    const AP_SCRIPT_ID = 2;

    function isApViewActive() {
        return els.viewAutoPrompt && els.viewAutoPrompt.style.display !== 'none';
    }

    async function generateAllImages() {
        if (state.isGenerating) return;

        if (isApViewActive()) {
            // Collect all successful AP prompt card texts
            const cards = Array.from(els.apScenesList.querySelectorAll('.scene-card.status-success'));
            if (cards.length === 0) {
                showToast('Hãy tạo prompts trước rồi mới gen ảnh.', 'error');
                return;
            }

            if (!state.tokenPool.length) {
                showToast('Thêm Access Token vào pool trước.', 'error');
                return;
            }

            state.isGenerating = true;
            els.btnGenerateAll.disabled = true;

            try {
                const pacing = parseFloat(els.apPacing ? els.apPacing.value : 10) || 10;
                const prompts = cards.map(card => {
                    const ta = card.querySelector('.scene-prompt-textarea, textarea');
                    return ta ? ta.value.trim() : (card.querySelector('.ap-prompt-text') ? card.querySelector('.ap-prompt-text').textContent.trim() : '');
                }).filter(p => p);

                await window.api.saveApPrompts(prompts, pacing);
                await window.api.generateImages(AP_SCRIPT_ID, state.tokenPool);
                showToast(`Đã bắt đầu gen ${prompts.length} ảnh! (${state.tokenPool.length} tokens)`, 'success');
                startApPolling();
            } catch (err) {
                showToast(`Generation failed: ${err.message}`, 'error');
                state.isGenerating = false;
                els.btnGenerateAll.disabled = false;
            }
        } else {
            // Original projects flow
            if (!state.scenes.length) {
                showToast('Analyze a script first.', 'error');
                return;
            }

            if (!state.tokenPool.length) {
                showToast('No tokens in pool. Click "Access Token Pool" to add tokens.', 'error');
                return;
            }

            state.isGenerating = true;
            els.btnGenerateAll.disabled = true;

            try {
                await window.api.generateImages(state.scriptId, state.tokenPool);
                showToast(`Image generation started! (${state.tokenPool.length} tokens × 3 workers)`, 'success');
                startPolling();
            } catch (err) {
                showToast(`Generation failed: ${err.message}`, 'error');
                state.isGenerating = false;
                els.btnGenerateAll.disabled = false;
            }
        }
    }

    // ==================== Regenerate Single ====================
    async function regenerateScene(sceneId) {
        if (!state.tokenPool.length) {
            showToast('No tokens in pool. Click "Access Token Pool" to add tokens.', 'error');
            return;
        }

        try {
            await window.api.regenerate(sceneId, state.tokenPool);
            showToast(`Regenerating scene...`, 'success');
            if (!state.isGenerating) {
                state.isGenerating = true;
                startPolling();
            }
        } catch (err) {
            showToast(`Regenerate failed: ${err.message}`, 'error');
        }
    }

    // ==================== Refresh All ====================
    async function refreshAll() {
        if (!state.scenes.length) return;

        if (!state.tokenPool.length) {
            showToast('No tokens in pool. Click "Access Token Pool" to add tokens.', 'error');
            return;
        }

        try {
            await window.api.generateImages(state.scriptId, state.tokenPool);
            showToast(`Re-generating all images... (${state.tokenPool.length} tokens × 3 workers)`, 'success');
            state.isGenerating = true;
            startPolling();
        } catch (err) {
            showToast(`Refresh failed: ${err.message}`, 'error');
        }
    }

    // ==================== Status Polling ====================
    function startPolling() {
        stopPolling();
        state.pollTimer = setInterval(async () => {
            await refreshStatus();
        }, 1500);
    }

    function stopPolling() {
        if (state.pollTimer) {
            clearInterval(state.pollTimer);
            state.pollTimer = null;
        }
    }

    async function refreshStatus() {
        try {
            const status = await window.api.getStatus(state.scriptId);

            // Update scene statuses
            if (status.total > 0) {
                const scenesData = await window.api.getScenes(state.scriptId);
                const newScenes = scenesData.scenes;

                // Detect status changes for logging
                for (const scene of newScenes) {
                    const prevStatus = state.prevSceneStatuses[scene.id];
                    if (prevStatus && prevStatus !== scene.status) {
                        if (scene.status === 'success') {
                            addLogEntry('success', `Scene ${String(scene.scene_number).padStart(2, '0')}`, 'Image generated successfully');
                        } else if (scene.status === 'error') {
                            const errMsg = scene.error_message || 'Unknown error';
                            addLogEntry('error', `Scene ${String(scene.scene_number).padStart(2, '0')}`, errMsg);
                            showErrorPopup(scene.scene_number, errMsg);
                        }
                    }
                    state.prevSceneStatuses[scene.id] = scene.status;
                }

                state.scenes = newScenes;
                renderScenes();
            }

            // Update images
            state.images = status.images || [];
            renderGallery();

            // Update progress bar
            updateProgress(status);

            // Stop polling if done (no pending or generating jobs remain)
            if (status.generating === 0 && status.pending === 0) {
                state.isGenerating = false;
                els.btnGenerateAll.disabled = false;
                stopPolling();

                if (status.errors > 0 && status.completed > 0) {
                    showToast(`Generation finished: ${status.completed} succeeded, ${status.errors} failed. Check error scenes and retry.`, 'error');
                } else if (status.errors > 0 && status.completed === 0) {
                    showToast(`All ${status.errors} image(s) failed to generate. Check errors and retry.`, 'error');
                } else if (status.completed > 0) {
                    showToast(`All images generated! (${status.completed}/${status.total})`, 'success');
                }
            }
        } catch (e) {
            // Silently continue polling
        }
    }

    function updateProgress(status) {
        if (status.total === 0) {
            els.batchStatus.innerHTML = '';
            els.progressText.textContent = '';
            return;
        }

        const isActive = status.generating > 0 || status.pending > 0;
        const doneCount = status.completed + (status.errors || 0);
        const errorSuffix = status.errors > 0 ? ` (${status.errors} failed)` : '';

        if (isActive) {
            const pct = Math.round((doneCount / status.total) * 100);
            els.batchStatus.innerHTML = `
                <span class="batch-label">GENERATING BATCH...</span>
                <div class="batch-progress-bar">
                    <div class="batch-progress-fill" style="width: ${pct}%"></div>
                </div>
            `;
            els.progressText.textContent = `${status.completed} / ${status.total} Images Complete${errorSuffix}`;
        } else {
            els.batchStatus.innerHTML = '';
            els.progressText.textContent = `${status.completed} / ${status.total} Images Complete${errorSuffix}`;
        }
    }

    // ==================== Gallery ====================
    function renderGallery() {
        const generatingScenes = state.scenes.filter(s => s.status === 'generating' || s.status === 'pending');

        let html = state.images.map((img) => {
            const imageSrc = window.api.getImageUrl(img.url || img.file_name);
            return `
                <div class="gallery-item">
                    <img src="${imageSrc}" alt="Scene ${img.scene_number}" loading="lazy">
                    <span class="gallery-scene-tag">Scene ${String(img.scene_number).padStart(2, '0')}</span>
                </div>
            `;
        }).join('');

        generatingScenes.forEach(() => {
            html += `
                <div class="gallery-item gallery-item-loading">
                    <div class="spinner"></div>
                    <span>Generating...</span>
                </div>
            `;
        });

        if (!html) {
            els.galleryGrid.innerHTML = '';
            return;
        }

        els.galleryGrid.innerHTML = html;
    }

    // ==================== Grid Size Toggle ====================
    function setGridSize(size) {
        state.gridSize = size;
        if (els.btnGridSm) els.btnGridSm.classList.toggle('active', size === 'sm');
        if (els.btnGridLg) els.btnGridLg.classList.toggle('active', size === 'lg');
        if (els.galleryGrid) els.galleryGrid.classList.toggle('grid-lg', size === 'lg');
    }

    // ==================== AP Gallery ====================
    function startApPolling() {
        stopApPolling();
        state.apPollTimer = setInterval(async () => {
            try {
                const status = await window.api.getStatus(AP_SCRIPT_ID);
                state.apImages = status.images || [];

                // Also fetch scene details to detect error messages
                let apSceneStatuses = [];
                try {
                    const scenesData = await window.api.getScenes(AP_SCRIPT_ID);
                    apSceneStatuses = scenesData.scenes || [];
                    // Log errors for scenes that just failed
                    for (const scene of apSceneStatuses) {
                        const prevStatus = state.prevSceneStatuses[`ap_${scene.id}`];
                        if (prevStatus && prevStatus !== scene.status) {
                            if (scene.status === 'success') {
                                addLogEntry('success', `Prompt ${String(scene.scene_number).padStart(2, '0')}`, 'Image generated successfully');
                            } else if (scene.status === 'error') {
                                const errMsg = scene.error_message || 'Unknown error';
                                addLogEntry('error', `Prompt ${String(scene.scene_number).padStart(2, '0')}`, errMsg);
                            }
                        }
                        state.prevSceneStatuses[`ap_${scene.id}`] = scene.status;
                    }
                } catch (_) {}

                state._apSceneStatuses = apSceneStatuses;
                renderApGallery();

                // Update progress
                if (status.total > 0) {
                    const done = status.completed + (status.errors || 0);
                    const errorSuffix = status.errors > 0 ? ` (${status.errors} lỗi)` : '';
                    els.progressText.textContent = `${status.completed} / ${status.total} Images Complete${errorSuffix}`;
                }

                if (status.generating === 0 && status.pending === 0) {
                    state.isGenerating = false;
                    if (els.btnGenerateAll) els.btnGenerateAll.disabled = false;
                    stopApPolling();
                    renderApGallery(); // Re-render to remove spinners

                    if (status.total === 0) {
                        showToast('Không tìm thấy scenes. Kiểm tra lại backend.', 'error');
                    } else if (status.errors > 0 && status.completed === 0) {
                        showToast(`Tất cả ${status.errors} ảnh bị lỗi. Kiểm tra log.`, 'error');
                    } else if (status.errors > 0) {
                        showToast(`Gen xong: ${status.completed} OK, ${status.errors} lỗi.`, 'error');
                    } else if (status.completed > 0) {
                        showToast(`Đã gen xong ${status.completed} ảnh!`, 'success');
                    }
                }
            } catch (e) { }
        }, 1500);
    }

    function stopApPolling() {
        if (state.apPollTimer) {
            clearInterval(state.apPollTimer);
            state.apPollTimer = null;
        }
    }

    function renderApGallery() {
        if (!els.apGalleryGrid) return;

        const sceneStatuses = state._apSceneStatuses || [];
        const successImages = state.apImages || [];

        // Build a map: scene_number -> image
        const imageByScene = {};
        for (const img of successImages) {
            imageByScene[img.scene_number] = img;
        }

        let html = '';
        let hasErrors = false;

        if (sceneStatuses.length > 0) {
            for (const scene of sceneStatuses) {
                const img = imageByScene[scene.scene_number];
                const label = `Prompt ${String(scene.scene_number).padStart(2, '0')}`;
                const regenBtn = `<button class="btn-gallery-regen" data-scene-id="${scene.id}" title="Gen lại ảnh này">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <polyline points="23 4 23 10 17 10"/>
                        <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
                    </svg>
                </button>`;

                if (img) {
                    const imageSrc = window.api.getImageUrl(img.url || img.file_name);
                    html += `
                        <div class="gallery-item">
                            <img src="${imageSrc}" alt="${label}" loading="lazy">
                            <span class="gallery-scene-tag">${label}</span>
                            ${regenBtn}
                        </div>
                    `;
                } else if (scene.status === 'error') {
                    hasErrors = true;
                    const errMsg = scene.error_message || 'Generation failed';
                    html += `
                        <div class="gallery-item gallery-item-error">
                            <div style="color:#e74c3c;font-size:28px;">✗</div>
                            <span style="color:#e74c3c;font-size:12px;text-align:center;padding:4px 8px;">
                                ${label} - Lỗi
                            </span>
                            <span style="color:#999;font-size:10px;text-align:center;padding:0 8px;max-height:40px;overflow:hidden;">
                                ${errMsg.substring(0, 80)}
                            </span>
                            ${regenBtn}
                        </div>
                    `;
                } else if (scene.status === 'generating' || scene.status === 'pending') {
                    html += `
                        <div class="gallery-item gallery-item-loading">
                            <div class="spinner"></div>
                            <span>Generating...</span>
                        </div>
                    `;
                }
            }
        } else if (state.isGenerating) {
            const promptCount = els.apScenesList
                ? els.apScenesList.querySelectorAll('.scene-card.status-success').length || 1
                : 1;
            html = Array.from({ length: promptCount }, () => `
                <div class="gallery-item gallery-item-loading">
                    <div class="spinner"></div>
                    <span>Generating...</span>
                </div>
            `).join('');
        }

        // Show/hide "Gen Lỗi" button based on whether there are errors
        const btnRetryFailed = document.getElementById('btn-ap-retry-failed-images');
        if (btnRetryFailed) {
            btnRetryFailed.style.display = hasErrors ? '' : 'none';
        }

        if (!html) {
            els.apGalleryGrid.innerHTML = '<div class="scenes-empty" style="width:100%;padding:32px 0;text-align:center;"><p>Bấm <strong>"Generate All Images"</strong> để tạo ảnh từ các prompts đã gen.</p></div>';
            return;
        }

        els.apGalleryGrid.innerHTML = html;
    }

    // ==================== AP Image Regen ====================
    async function apRegenSingleImage(sceneId) {
        if (!state.tokenPool.length) {
            showToast('Thêm Access Token vào pool trước.', 'error');
            return;
        }
        try {
            await window.api.regenerate(sceneId, state.tokenPool);
            showToast('Regenerating...', 'success');
            if (!state.isGenerating) {
                state.isGenerating = true;
                startApPolling();
            }
        } catch (err) {
            showToast(`Regen failed: ${err.message}`, 'error');
        }
    }

    async function apRetryFailedImages() {
        if (!state.tokenPool.length) {
            showToast('Thêm Access Token vào pool trước.', 'error');
            return;
        }
        if (state.isGenerating) {
            showToast('Đang gen, vui lòng chờ...', 'error');
            return;
        }
        try {
            // /generate-images already queues scenes with status 'error'
            await window.api.generateImages(AP_SCRIPT_ID, state.tokenPool);
            const errorCount = (state._apSceneStatuses || []).filter(s => s.status === 'error').length;
            showToast(`Đang gen lại ${errorCount} ảnh lỗi...`, 'success');
            state.isGenerating = true;
            if (els.btnGenerateAll) els.btnGenerateAll.disabled = true;
            startApPolling();
        } catch (err) {
            showToast(`Retry failed: ${err.message}`, 'error');
        }
    }

    // ==================== Export ZIP ====================
    async function exportZip() {
        const useApScriptId = isApViewActive();
        const imagesExist = useApScriptId ? state.apImages.length > 0 : state.images.length > 0;

        if (!imagesExist) {
            showToast('No images to export.', 'error');
            return;
        }

        els.btnExportZip.disabled = true;

        try {
            const exportScriptId = useApScriptId ? AP_SCRIPT_ID : state.scriptId;
            const blobUrl = await window.api.exportZip(exportScriptId);
            const a = document.createElement('a');
            a.href = blobUrl;
            a.download = `ai_studio_export_${exportScriptId}.zip`;
            a.click();
            URL.revokeObjectURL(blobUrl);
            showToast('Export complete!', 'success');
        } catch (err) {
            showToast(`Export failed: ${err.message}`, 'error');
        } finally {
            els.btnExportZip.disabled = false;
        }
    }

    // ==================== Delete Scene ====================
    async function deleteSceneConfirm(sceneId) {
        const scene = state.scenes.find(s => s.id === sceneId);
        if (!scene) return;

        const label = `Scene ${String(scene.scene_number).padStart(2, '0')}`;
        if (!confirm(`Delete ${label}? This will also remove its generated images.`)) return;

        try {
            await window.api.deleteScene(sceneId);
            state.scenes = state.scenes.filter(s => s.id !== sceneId);
            delete state.prevSceneStatuses[sceneId];
            renderScenes();
            addLogEntry('info', label, 'Scene deleted');
            showToast(`${label} deleted.`, 'success');
            // Refresh gallery
            await refreshStatus();
        } catch (err) {
            showToast(`Failed to delete: ${err.message}`, 'error');
        }
    }

    // ==================== Error Popup ====================
    function showErrorPopup(sceneNumber, message) {
        $('#error-popup-scene').textContent = `Scene ${String(sceneNumber).padStart(2, '0')}`;
        $('#error-popup-message').textContent = message;
        els.errorModal.classList.add('active');
    }

    function closeErrorPopup() {
        els.errorModal.classList.remove('active');
    }

    // ==================== Log Panel ====================
    function addLogEntry(type, scene, message) {
        const now = new Date();
        const time = now.toLocaleTimeString('en-US', { hour12: false });
        state.generationLog.unshift({ type, scene, message, time });
        // Keep max 200 entries
        if (state.generationLog.length > 200) state.generationLog.pop();
        renderLogEntries();
    }

    function renderLogEntries() {
        els.logEntries.innerHTML = state.generationLog.map(entry => {
            const icon = entry.type === 'success'
                ? `<svg width="12" height="12" viewBox="0 0 24 24" fill="var(--status-success)"><circle cx="12" cy="12" r="10"/><path d="M9 12l2 2 4-4" stroke="#fff" stroke-width="2" fill="none"/></svg>`
                : entry.type === 'error'
                    ? `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--status-error)" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>`
                    : `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`;

            return `
                <div class="log-entry log-${entry.type}">
                    <span class="log-icon">${icon}</span>
                    <span class="log-time">${entry.time}</span>
                    <span class="log-scene">${entry.scene}</span>
                    <span class="log-message">${escapeHtml(entry.message)}</span>
                </div>
            `;
        }).join('');
    }

    function clearLog() {
        state.generationLog = [];
        renderLogEntries();
    }

    function toggleLogPanel() {
        els.logPanel.classList.toggle('active');
    }

    // ==================== Helpers ====================
    function escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    function escapeAttr(str) {
        return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;');
    }

    function truncate(str, max) {
        return str.length > max ? str.slice(0, max) + '...' : str;
    }

    // ==================== Toast ====================
    function showToast(message, type = 'info') {
        // Remove existing toast
        const existing = document.querySelector('.toast');
        if (existing) existing.remove();

        const toast = document.createElement('div');
        toast.className = `toast ${type}`;
        toast.textContent = message;
        document.body.appendChild(toast);

        setTimeout(() => toast.remove(), 3500);
    }

    // ==================== Auto Prompter ====================

    /**
     * Render a single scene card into the output panel at the correct sorted position.
     */
    function apRenderSceneCard(index, totalPrompts, pacing, promptText, status = 'success') {
        const startSec = (index - 1) * pacing;
        const endSec = startSec + pacing;
        const tsStart = `${Math.floor(startSec / 60).toString().padStart(2, '0')}:${Math.floor(startSec % 60).toString().padStart(2, '0')}`;
        const tsEnd = `${Math.floor(endSec / 60).toString().padStart(2, '0')}:${Math.floor(endSec % 60).toString().padStart(2, '0')}`;

        const statusIcon = status === 'success'
            ? `<svg width="18" height="18" viewBox="0 0 24 24" fill="var(--status-success)"><circle cx="12" cy="12" r="10"/><path d="M9 12l2 2 4-4" stroke="#fff" stroke-width="2" fill="none"/></svg>`
            : status === 'generating'
                ? `<svg class="spin" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>`
                : `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--status-error)" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="9" y1="9" x2="15" y2="15"/><line x1="15" y1="9" x2="9" y2="15"/></svg>`;

        // Remove existing card for this index (if re-rendering)
        const existingCard = els.apScenesList.querySelector(`[data-prompt-index="${index}"]`);
        if (existingCard) existingCard.remove();

        const card = document.createElement('div');
        card.className = `scene-card status-${status}`;
        card.dataset.promptIndex = index;
        card.innerHTML = `
            <div class="scene-card-header">
                <div class="scene-label">
                    <span class="scene-number">PROMPT ${String(index).padStart(2, '0')}</span>
                    <span class="scene-timestamp">${tsStart}–${tsEnd}</span>
                </div>
                <div class="scene-card-actions">
                    <div class="scene-status-icon ${status}">${statusIcon}</div>
                </div>
            </div>
            <div class="scene-prompt-label">IMAGE PROMPT</div>
            <textarea class="scene-prompt-textarea" data-prompt-index="${index}" ${status === 'generating' ? 'disabled' : ''}>${escapeHtml(promptText)}</textarea>
        `;

        // Insert in sorted order
        const allCards = Array.from(els.apScenesList.querySelectorAll('.scene-card'));
        let inserted = false;
        for (const existing of allCards) {
            const existingIdx = parseInt(existing.dataset.promptIndex);
            if (existingIdx > index) {
                els.apScenesList.insertBefore(card, existing);
                inserted = true;
                break;
            }
        }
        if (!inserted) {
            els.apScenesList.appendChild(card);
        }

        // Add Regenerate Prompt button
        if (status !== 'generating' && status !== 'pending') {
            const footer = document.createElement('div');
            footer.className = 'scene-card-footer';
            footer.innerHTML = `<button class="btn btn-secondary btn-ap-regenerate" style="width: 100%; margin-top: 8px;">Regenerate</button>`;
            card.appendChild(footer);
        }

        // Auto-scroll to latest card
        card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }

    async function apGeneratePrompts(mode = 'all', specificIndices = []) {
        if (state.isGenerating) return;

        const rawKeys = els.apKeyPool ? els.apKeyPool.value.trim() : '';
        const apiKeys = rawKeys.split('\n').map(k => k.trim()).filter(k => k.length > 0);
        if (apiKeys.length === 0) {
            showToast('Vui lòng nhập ít nhất 1 Gemini API key.', 'error');
            return;
        }

        state.geminiApiKey = apiKeys[0];
        if (els.geminiKeyInput) els.geminiKeyInput.value = apiKeys[0];
        saveGeminiKey();

        const scriptText = els.apScript ? els.apScript.value.trim() : '';
        if (!scriptText) {
            showToast('Vui lòng nhập kịch bản.', 'error');
            return;
        }

        const dur = parseFloat(els.apDuration.value) || 0;
        const pacing = parseFloat(els.apPacing.value) || 1;
        const totalPrompts = Math.max(1, Math.ceil(dur / pacing));
        const styleText = els.apStyle ? els.apStyle.value.trim() : '';

        // Determine queue based on mode
        const queue = [];
        if (mode === 'all') {
            for (let i = 1; i <= totalPrompts; i++) queue.push(i);
            if (els.apScenesList) els.apScenesList.innerHTML = '';
        } else if (mode === 'failed') {
            const errorCards = Array.from(els.apScenesList.querySelectorAll('.scene-card.status-error'));
            if (errorCards.length === 0) {
                showToast('Không có prompt nào bị lỗi.', 'info');
                return;
            }
            errorCards.forEach(card => queue.push(parseInt(card.dataset.promptIndex)));
        } else if (mode === 'single') {
            queue.push(...specificIndices);
        }

        state.isGenerating = true;
        state.apStopRequested = false;

        const WORKERS_PER_KEY = 1;
        const totalWorkers = apiKeys.length * WORKERS_PER_KEY;
        els.btnApGenerate.style.display = 'none';

        if (els.btnApStop) {
            els.btnApStop.disabled = false;
        }

        if (els.btnApRetryAll) els.btnApRetryAll.disabled = true;
        if (els.btnApRetryFailed) els.btnApRetryFailed.disabled = true;

        els.apProgressContainer.style.display = 'block';
        els.apProgressBar.style.width = '0%';
        els.apProgressBar.style.backgroundColor = 'var(--status-success)';
        els.apProgressPct.textContent = '0%';

        const queueSize = queue.length;
        els.apProgressText.textContent = `0 / ${queueSize} prompts (${apiKeys.length} key × ${WORKERS_PER_KEY} luồng)`;

        if (els.apEmptyMsg) els.apEmptyMsg.style.display = 'none';

        let completedCount = 0;
        let errorCount = 0;

        // Create placeholders for new gens
        if (mode === 'all') {
            for (let i = 1; i <= totalPrompts; i++) {
                apRenderSceneCard(i, totalPrompts, pacing, 'Đang chờ...', 'pending');
            }
        }

        async function worker(apiKey, workerIdx) {
            while (queue.length > 0) {
                if (state.apStopRequested) break;

                const promptIndex = queue.shift();
                if (promptIndex === undefined) break;

                apRenderSceneCard(promptIndex, totalPrompts, pacing, `Đang tạo (key ${workerIdx + 1})...`, 'generating');

                try {
                    const response = await window.api.generateAudioPrompt(
                        scriptText, promptIndex, totalPrompts, styleText, apiKey
                    );
                    if (state.apStopRequested) break;
                    apRenderSceneCard(promptIndex, totalPrompts, pacing, response.prompt, 'success');
                    completedCount++;
                } catch (err) {
                    if (state.apStopRequested) break;
                    try {
                        await new Promise(r => setTimeout(r, 2000));
                        const response = await window.api.generateAudioPrompt(
                            scriptText, promptIndex, totalPrompts, styleText, apiKey
                        );
                        if (state.apStopRequested) break;
                        apRenderSceneCard(promptIndex, totalPrompts, pacing, response.prompt, 'success');
                        completedCount++;
                    } catch (retryErr) {
                        apRenderSceneCard(promptIndex, totalPrompts, pacing, `Lỗi: ${retryErr.message}`, 'error');
                        errorCount++;
                    }
                }

                if (!state.apStopRequested) {
                    const done = completedCount + errorCount;
                    const pct = Math.round((done / queueSize) * 100);
                    els.apProgressBar.style.width = `${pct}%`;
                    els.apProgressPct.textContent = `${pct}%`;
                    els.apProgressText.textContent = `${done} / ${queueSize} prompts (${apiKeys.length} key × ${WORKERS_PER_KEY} luồng)`;

                    if (queue.length > 0) {
                        await new Promise(r => setTimeout(r, TIMEOUTS_BETWEEN_REQUESTS));
                    }
                }
            }
        }

        try {
            const allWorkers = [];
            let workerIdx = 0;
            for (const key of apiKeys) {
                for (let w = 0; w < WORKERS_PER_KEY; w++) {
                    allWorkers.push(worker(key, workerIdx++));
                }
            }
            await Promise.all(allWorkers);

            if (state.apStopRequested) {
                showToast(`Đã ngừng! Xong ${completedCount}, Lỗi ${errorCount}.`, 'warning');
                els.apProgressText.textContent = 'Đã ngừng bởi người dùng';
            } else if (errorCount === 0) {
                showToast(`Hoàn thành! Đã tạo ${completedCount} prompts.`, 'success');
                els.apProgressText.textContent = 'Hoàn thành!';
            } else {
                showToast(`Xong: ${completedCount} thành công, ${errorCount} lỗi.`, 'error');
                els.apProgressText.textContent = `${completedCount} OK, ${errorCount} lỗi`;
                els.apProgressBar.style.backgroundColor = 'var(--status-error)';
            }
        } catch (err) {
            showToast(`Generating failed: ${err.message}`, 'error');
            els.apProgressText.textContent = 'Lỗi!';
            els.apProgressBar.style.backgroundColor = 'var(--status-error)';
        } finally {
            state.isGenerating = false;
            state.apStopRequested = false;

            // Restore buttons
            if (els.btnApStop) els.btnApStop.disabled = true;
            if (els.btnApGenerate) els.btnApGenerate.style.display = 'flex';
            if (els.btnApRetryAll) els.btnApRetryAll.disabled = false;
            if (els.btnApRetryFailed) els.btnApRetryFailed.disabled = false;
        }
    }

    // ==================== Video Render ====================

    /**
     * Scan the input folder for images and render the file list.
     */
    async function vrScanFolder() {
        const inputDir = els.vrInputDir ? els.vrInputDir.value.trim() : '';
        if (!inputDir) {
            showToast('Nhập đường dẫn thư mục ảnh trước.', 'error');
            return;
        }

        if (els.btnVrScan) {
            els.btnVrScan.disabled = true;
            els.btnVrScan.innerHTML = `
                <svg class="spin" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
                </svg>
                Đang quét...
            `;
        }

        try {
            const data = await window.api.videoScan(inputDir);
            state.vrScannedFiles = data.images || [];

            // Show scan info
            if (els.vrScanInfo) {
                els.vrScanInfo.style.display = 'block';
                els.vrScanInfo.textContent = `Tìm thấy ${data.total} ảnh trong thư mục`;
            }

            // Render file list
            vrRenderFileList();

            // Enable render button
            if (els.btnVrRender) els.btnVrRender.disabled = state.vrScannedFiles.length === 0;

            showToast(`Quét xong: ${data.total} ảnh.`, 'success');
        } catch (err) {
            showToast(`Quét thất bại: ${err.message}`, 'error');
            state.vrScannedFiles = [];
            if (els.vrScanInfo) {
                els.vrScanInfo.style.display = 'block';
                els.vrScanInfo.textContent = `Lỗi: ${err.message}`;
                els.vrScanInfo.style.color = 'var(--status-error)';
            }
        } finally {
            if (els.btnVrScan) {
                els.btnVrScan.disabled = false;
                els.btnVrScan.innerHTML = `
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
                    </svg>
                    Quét Thư Mục
                `;
            }
        }
    }

    /**
     * Render the scanned file list in the right panel.
     */
    function vrRenderFileList() {
        if (!els.vrFileList) return;

        const files = state.vrScannedFiles;

        // Update count
        if (els.vrFileCount) {
            els.vrFileCount.textContent = files.length > 0 ? `${files.length} files` : '';
        }

        if (files.length === 0) {
            els.vrFileList.innerHTML = `
                <div class="scenes-empty" id="vr-empty-msg">
                    <p>Không tìm thấy ảnh nào (jpg, png, webp).</p>
                </div>
            `;
            return;
        }

        els.vrFileList.innerHTML = files.map((f, i) => {
            const ext = f.name.split('.').pop().toUpperCase();
            return `
                <div class="vr-file-item" data-index="${i}" data-path="${escapeAttr(f.path)}">
                    <div class="vr-file-icon">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                            <rect x="3" y="3" width="18" height="18" rx="2"/>
                            <circle cx="8.5" cy="8.5" r="1.5"/>
                            <path d="M21 15l-5-5L5 21"/>
                        </svg>
                    </div>
                    <div class="vr-file-info">
                        <span class="vr-file-name">${escapeHtml(f.name)}</span>
                        <span class="vr-file-meta">${ext} · ${f.size_kb} KB</span>
                    </div>
                    <div class="vr-file-status" id="vr-fstatus-${i}">
                        <span class="vr-file-badge pending">Chờ</span>
                    </div>
                </div>
            `;
        }).join('');
    }

    /**
     * Start batch video rendering.
     */
    async function vrStartRender() {
        if (state.vrRendering) {
            showToast('Đang render, vui lòng chờ...', 'error');
            return;
        }
        if (state.vrScannedFiles.length === 0) {
            showToast('Quét thư mục trước khi render.', 'error');
            return;
        }

        const inputDir = els.vrInputDir ? els.vrInputDir.value.trim() : '';
        const outputDir = els.vrOutputDir ? els.vrOutputDir.value.trim() : '';
        const duration = parseInt(els.vrDuration ? els.vrDuration.value : '8') || 8;
        const maxWorkers = parseInt(els.vrWorkers ? els.vrWorkers.value : '4') || 4;

        if (!inputDir) {
            showToast('Nhập đường dẫn thư mục ảnh.', 'error');
            return;
        }

        // Disable button, show progress
        if (els.btnVrRender) {
            els.btnVrRender.disabled = true;
            els.btnVrRender.innerHTML = `
                <svg class="spin" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
                </svg>
                Đang Render...
            `;
        }
        if (els.btnVrScan) els.btnVrScan.disabled = true;

        if (els.vrProgressContainer) els.vrProgressContainer.style.display = 'block';
        if (els.vrProgressBar) els.vrProgressBar.style.width = '0%';
        if (els.vrProgressPct) els.vrProgressPct.textContent = '0%';
        if (els.vrProgressText) els.vrProgressText.textContent = 'Đang chuẩn bị...';

        try {
            const data = await window.api.videoRender(inputDir, outputDir, duration, maxWorkers);
            state.vrRendering = true;
            state.vrOutputDir = data.output_dir || '';
            showToast(`Bắt đầu render ${data.total} video...`, 'success');
            if (els.vrProgressText) els.vrProgressText.textContent = `0 / ${data.total} videos`;

            // Start polling
            vrStartPolling();
        } catch (err) {
            showToast(`Render thất bại: ${err.message}`, 'error');
            vrResetButtons();
        }
    }

    /**
     * Poll video render status every 1.5s.
     */
    function vrStartPolling() {
        vrStopPolling();
        state.vrPollTimer = setInterval(async () => {
            try {
                const status = await window.api.videoStatus();

                // Update progress bar
                const total = status.total || 0;
                const done = (status.completed || 0) + (status.errors || 0);
                const pct = total > 0 ? Math.round((done / total) * 100) : 0;

                if (els.vrProgressBar) els.vrProgressBar.style.width = `${pct}%`;
                if (els.vrProgressPct) els.vrProgressPct.textContent = `${pct}%`;
                if (els.vrProgressText) {
                    const errSuffix = status.errors > 0 ? ` (${status.errors} lỗi)` : '';
                    els.vrProgressText.textContent = `${status.completed} / ${total} videos${errSuffix}`;
                }

                // Update file list badges with live status
                if (status.results && status.results.length > 0) {
                    vrUpdateFileStatuses(status.results);
                }

                // Check if finished
                if (!status.running) {
                    state.vrRendering = false;
                    vrStopPolling();
                    vrResetButtons();

                    // Render results grid
                    vrRenderResults(status.results || []);

                    // Show retry button if errors
                    if (els.btnVrRetryFailed) {
                        els.btnVrRetryFailed.style.display = (status.errors || 0) > 0 ? '' : 'none';
                    }

                    // Progress bar color
                    if (els.vrProgressBar) {
                        els.vrProgressBar.style.background = status.errors > 0
                            ? 'var(--status-error)' : 'var(--status-success)';
                    }

                    if (status.errors > 0 && status.completed > 0) {
                        showToast(`Xong: ${status.completed} OK, ${status.errors} lỗi.`, 'error');
                        if (els.vrProgressText) els.vrProgressText.textContent = `${status.completed} OK, ${status.errors} lỗi`;
                    } else if (status.errors > 0 && status.completed === 0) {
                        showToast(`Tất cả ${status.errors} video bị lỗi!`, 'error');
                        if (els.vrProgressText) els.vrProgressText.textContent = `Tất cả lỗi!`;
                    } else {
                        showToast(`Hoàn thành! Đã render ${status.completed} video.`, 'success');
                        if (els.vrProgressText) els.vrProgressText.textContent = 'Hoàn thành!';
                    }
                }
            } catch (e) {
                // Silently continue
            }
        }, 1500);
    }

    function vrStopPolling() {
        if (state.vrPollTimer) {
            clearInterval(state.vrPollTimer);
            state.vrPollTimer = null;
        }
    }

    /**
     * Update file list badges based on render results.
     */
    function vrUpdateFileStatuses(results) {
        if (!els.vrFileList) return;
        const resultMap = {};
        for (const r of results) {
            resultMap[r.image_name] = r.status;
        }

        state.vrScannedFiles.forEach((f, i) => {
            const statusEl = document.getElementById(`vr-fstatus-${i}`);
            if (!statusEl) return;

            const st = resultMap[f.name];
            if (st === 'success') {
                statusEl.innerHTML = '<span class="vr-file-badge success">✓ OK</span>';
            } else if (st === 'error') {
                statusEl.innerHTML = '<span class="vr-file-badge error">✗ Lỗi</span>';
            } else if (st === 'rendering') {
                statusEl.innerHTML = '<span class="vr-file-badge rendering">⟳ Render</span>';
            }
        });
    }

    /**
     * Render the results gallery after batch render is done.
     */
    function vrRenderResults(results) {
        if (!els.vrResultGrid) return;

        if (!results || results.length === 0) {
            els.vrResultGrid.innerHTML = `
                <div class="scenes-empty" style="width:100%;padding:32px 0;text-align:center;">
                    <p>Kết quả render sẽ hiển thị ở đây.</p>
                </div>
            `;
            return;
        }

        els.vrResultGrid.innerHTML = results.map((r) => {
            const reRenderBtn = `<button class="btn-vr-rerender" data-image-path="${escapeAttr(r.image_name)}" title="Render lại">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <polyline points="23 4 23 10 17 10"/>
                    <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
                </svg>
            </button>`;

            if (r.status === 'success') {
                return `
                    <div class="gallery-item vr-result-item vr-result-success">
                        <div class="vr-result-icon success">
                            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="var(--status-success)" stroke-width="2">
                                <polygon points="23 7 16 12 23 17 23 7"/>
                                <rect x="1" y="5" width="15" height="14" rx="2" ry="2"/>
                            </svg>
                        </div>
                        <span class="vr-result-name" title="${escapeAttr(r.video_name)}">${escapeHtml(r.video_name)}</span>
                        <span class="vr-result-status success">✓ Thành công</span>
                        ${reRenderBtn}
                    </div>
                `;
            } else {
                return `
                    <div class="gallery-item vr-result-item vr-result-error">
                        <div class="vr-result-icon error">
                            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="var(--status-error)" stroke-width="2">
                                <circle cx="12" cy="12" r="10"/>
                                <line x1="15" y1="9" x2="9" y2="15"/>
                                <line x1="9" y1="9" x2="15" y2="15"/>
                            </svg>
                        </div>
                        <span class="vr-result-name" title="${escapeAttr(r.image_name)}">${escapeHtml(r.image_name)}</span>
                        <span class="vr-result-status error">✗ Lỗi</span>
                        <span class="vr-result-error-msg" title="${escapeAttr(r.error_message || '')}">${escapeHtml((r.error_message || '').substring(0, 60))}</span>
                        ${reRenderBtn}
                    </div>
                `;
            }
        }).join('');
    }

    /**
     * Render a single image to video (re-render).
     */
    async function vrRenderSingle(imageName) {
        const inputDir = els.vrInputDir ? els.vrInputDir.value.trim() : '';
        const outputDir = els.vrOutputDir ? els.vrOutputDir.value.trim() : state.vrOutputDir;
        const duration = parseInt(els.vrDuration ? els.vrDuration.value : '8') || 8;

        // Resolve full image path from scanned files
        const file = state.vrScannedFiles.find(f => f.name === imageName);
        const imagePath = file ? file.path : (inputDir ? inputDir + '\\' + imageName : imageName);

        showToast(`Đang render lại: ${imageName}...`, 'info');

        try {
            const result = await window.api.videoRenderSingle(imagePath, outputDir, duration);

            if (result.status === 'success') {
                showToast(`Render lại thành công: ${result.video_name}`, 'success');
            } else {
                showToast(`Render lại thất bại: ${result.error_message}`, 'error');
            }

            // Refresh status to update the results grid
            try {
                const status = await window.api.videoStatus();
                if (status.results && status.results.length > 0) {
                    // Update the single item in results
                    const idx = status.results.findIndex(r => r.image_name === imageName);
                    if (idx >= 0) {
                        status.results[idx] = {
                            image_name: result.image_name,
                            video_name: result.video_name,
                            status: result.status,
                            error_message: result.error_message || '',
                        };
                    }
                    vrRenderResults(status.results);
                    vrUpdateFileStatuses(status.results);
                }
            } catch (_) {}
        } catch (err) {
            showToast(`Render lỗi: ${err.message}`, 'error');
        }
    }

    /**
     * Retry rendering only the failed videos.
     */
    async function vrRetryFailed() {
        if (state.vrRendering) {
            showToast('Đang render, vui lòng chờ...', 'error');
            return;
        }

        try {
            const status = await window.api.videoStatus();
            const failedResults = (status.results || []).filter(r => r.status === 'error');

            if (failedResults.length === 0) {
                showToast('Không có video lỗi nào.', 'info');
                return;
            }

            showToast(`Đang render lại ${failedResults.length} video lỗi...`, 'info');

            const inputDir = els.vrInputDir ? els.vrInputDir.value.trim() : '';
            const outputDir = els.vrOutputDir ? els.vrOutputDir.value.trim() : state.vrOutputDir;
            const duration = parseInt(els.vrDuration ? els.vrDuration.value : '8') || 8;

            let successCount = 0;
            let errorCount = 0;

            for (const failed of failedResults) {
                const file = state.vrScannedFiles.find(f => f.name === failed.image_name);
                const imagePath = file ? file.path : (inputDir ? inputDir + '\\' + failed.image_name : failed.image_name);

                try {
                    const result = await window.api.videoRenderSingle(imagePath, outputDir, duration);
                    if (result.status === 'success') {
                        successCount++;
                    } else {
                        errorCount++;
                    }
                } catch (e) {
                    errorCount++;
                }
            }

            // Refresh results display
            try {
                const finalStatus = await window.api.videoStatus();
                if (finalStatus.results && finalStatus.results.length > 0) {
                    vrRenderResults(finalStatus.results);
                    vrUpdateFileStatuses(finalStatus.results);
                }
            } catch (_) {}

            if (errorCount === 0) {
                showToast(`Retry thành công! ${successCount} video OK.`, 'success');
            } else {
                showToast(`Retry xong: ${successCount} OK, ${errorCount} vẫn lỗi.`, 'error');
            }

            // Hide retry button if no more errors
            if (els.btnVrRetryFailed) {
                els.btnVrRetryFailed.style.display = errorCount > 0 ? '' : 'none';
            }
        } catch (err) {
            showToast(`Retry thất bại: ${err.message}`, 'error');
        }
    }

    /**
     * Reset VR buttons to idle state.
     */
    function vrResetButtons() {
        if (els.btnVrRender) {
            els.btnVrRender.disabled = state.vrScannedFiles.length === 0;
            els.btnVrRender.innerHTML = `
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <polygon points="23 7 16 12 23 17 23 7"/>
                    <rect x="1" y="5" width="15" height="14" rx="2" ry="2"/>
                </svg>
                Bắt Đầu Render Video
            `;
        }
        if (els.btnVrScan) els.btnVrScan.disabled = false;
    }

    // ==================== Start ====================
    document.addEventListener('DOMContentLoaded', init);
})();
