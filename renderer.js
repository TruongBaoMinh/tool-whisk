/**
 * AI Studio — Renderer
 * Handles all UI logic, API calls, and dynamic rendering.
 */

;(function () {
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
    };

    // ==================== DOM Refs ====================
    const $ = (sel) => document.querySelector(sel);
    const $$ = (sel) => document.querySelectorAll(sel);

    const els = {
        editor:        $('#script-editor'),
        wordCount:     $('#word-count'),
        scenesList:    $('#scenes-list'),
        galleryGrid:   $('#gallery-grid'),
        btnAnalyze:    $('#btn-analyze'),
        btnGenerateAll:$('#btn-generate-all'),
        btnExportZip:  $('#btn-export-zip'),
        btnRefreshAll: $('#btn-refresh-all'),
        btnGridSm:     $('#btn-grid-sm'),
        btnGridLg:     $('#btn-grid-lg'),
        batchStatus:   $('#batch-status'),
        progressText:  $('#progress-text'),
        btnTokenPool:  $('#btn-token-pool'),
        tokenModal:    $('#token-pool-modal'),
        errorModal:    $('#error-popup-modal'),
        logPanel:      $('#log-panel'),
        logEntries:    $('#log-entries'),
        geminiKeyInput: $('#gemini-api-key'),
    };

    // ==================== Init ====================
    function init() {
        updateWordCount();
        bindEvents();
        loadTokenPool();
        loadGeminiKey();
        // Try to load existing scenes
        loadExistingScenes();
    }

    function bindEvents() {
        els.editor.addEventListener('input', updateWordCount);
        els.btnAnalyze.addEventListener('click', analyzeScript);
        els.btnGenerateAll.addEventListener('click', generateAllImages);
        els.btnExportZip.addEventListener('click', exportZip);
        els.btnRefreshAll.addEventListener('click', refreshAll);
        els.btnGridSm.addEventListener('click', () => setGridSize('sm'));
        els.btnGridLg.addEventListener('click', () => setGridSize('lg'));

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
                $$('.nav-item').forEach((n) => n.classList.remove('active'));
                item.classList.add('active');
            });
        });
    }

    // ==================== Word Count ====================
    function updateWordCount() {
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
                    <p>Click <strong>"Analyze Script"</strong> to split your script into scenes.</p>
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
                    window.api.updatePrompt(sceneId, ta.value).catch(() => {});
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
                els.geminiKeyInput.value = saved;
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
    async function generateAllImages() {
        if (state.isGenerating) return;
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
        if (!state.images.length) {
            els.galleryGrid.innerHTML = '';
            return;
        }

        // Check if any scenes are still generating
        const generatingScenes = state.scenes.filter(s => s.status === 'generating' || s.status === 'pending');

        let html = state.images.map((img) => `
            <div class="gallery-item">
                <img src="${window.api.getImageUrl(img.file_name)}" alt="Scene ${img.scene_number}" loading="lazy">
                <span class="gallery-scene-tag">Scene ${String(img.scene_number).padStart(2, '0')}</span>
            </div>
        `).join('');

        // Add loading placeholders for generating scenes
        generatingScenes.forEach((scene) => {
            html += `
                <div class="gallery-item gallery-item-loading">
                    <div class="spinner"></div>
                    <span>Generating...</span>
                </div>
            `;
        });

        els.galleryGrid.innerHTML = html;
    }

    // ==================== Grid Size Toggle ====================
    function setGridSize(size) {
        state.gridSize = size;
        els.btnGridSm.classList.toggle('active', size === 'sm');
        els.btnGridLg.classList.toggle('active', size === 'lg');
        els.galleryGrid.classList.toggle('grid-lg', size === 'lg');
    }

    // ==================== Export ZIP ====================
    async function exportZip() {
        if (!state.images.length) {
            showToast('No images to export.', 'error');
            return;
        }

        els.btnExportZip.disabled = true;

        try {
            const blobUrl = await window.api.exportZip(state.scriptId);
            const a = document.createElement('a');
            a.href = blobUrl;
            a.download = `ai_studio_export_${state.scriptId}.zip`;
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

    // ==================== Start ====================
    document.addEventListener('DOMContentLoaded', init);
})();
