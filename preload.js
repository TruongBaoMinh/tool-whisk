/**
 * AI Studio — Preload Script
 * Exposes a safe API bridge from main process to renderer.
 */

const { contextBridge } = require('electron');

const API_BASE = 'http://127.0.0.1:8001';

/**
 * Generic fetch wrapper with error handling.
 */
async function apiFetch(endpoint, options = {}) {
    const url = `${API_BASE}${endpoint}`;
    try {
        const response = await fetch(url, {
            headers: { 'Content-Type': 'application/json', ...options.headers },
            ...options,
        });
        if (!response.ok) {
            const err = await response.json().catch(() => ({ detail: response.statusText }));
            const detail = Array.isArray(err.detail)
                ? err.detail.map(e => e.msg || JSON.stringify(e)).join('; ')
                : err.detail || `HTTP ${response.status}`;
            throw new Error(detail);
        }
        return response;
    } catch (err) {
        console.error(`[API] ${endpoint} failed:`, err);
        throw err;
    }
}

contextBridge.exposeInMainWorld('api', {
    /**
     * Analyze script text → returns scenes JSON
     * @param {string} scriptText
     * @param {number} scriptId
     * @param {string} geminiApiKey - Gemini API key for AI analysis
     */
    analyzeScript: async (scriptText, scriptId = 1, geminiApiKey = '') => {
        const res = await apiFetch('/analyze-script', {
            method: 'POST',
            body: JSON.stringify({
                script_text: scriptText,
                script_id: scriptId,
                gemini_api_key: geminiApiKey,
            }),
        });
        return res.json();
    },

    /**
     * Generate a single image prompt for an audio-synced sequence
     */
    generateAudioPrompt: async (scriptText, promptIndex, totalPrompts, visualStyle, geminiApiKey) => {
        const res = await apiFetch('/generate-audio-prompt', {
            method: 'POST',
            body: JSON.stringify({
                script_text: scriptText,
                prompt_index: promptIndex,
                total_prompts: totalPrompts,
                visual_style: visualStyle,
                gemini_api_key: geminiApiKey,
            }),
        });
        return res.json();
    },

    /**
     * Analyze script text with deterministic regex splitting.
     * @param {string} scriptText
     * @param {number} scriptId
     * @param {string} geminiApiKey - kept for payload compatibility, ignored by backend regex flow
     */
    analyzeScriptRegex: async (scriptText, scriptId = 1, geminiApiKey = '') => {
        const res = await apiFetch('/analyze-script-regex', {
            method: 'POST',
            body: JSON.stringify({
                script_text: scriptText,
                script_id: scriptId,
                gemini_api_key: geminiApiKey,
            }),
        });
        return res.json();
    },

    /**
     * Get scenes for a script
     */
    getScenes: async (scriptId = 1) => {
        const res = await apiFetch(`/scenes/${scriptId}`);
        return res.json();
    },

    /**
     * Update a scene prompt
     */
    updatePrompt: async (sceneId, prompt) => {
        const res = await apiFetch('/update-prompt', {
            method: 'POST',
            body: JSON.stringify({ scene_id: sceneId, prompt }),
        });
        return res.json();
    },

    /**
     * Generate all images for a script
     * @param {number} scriptId
     * @param {string[]} accessTokens - list of Google access tokens
     */
    generateImages: async (scriptId = 1, accessTokens = []) => {
        const res = await apiFetch('/generate-images', {
            method: 'POST',
            body: JSON.stringify({ script_id: scriptId, access_token: accessTokens }),
        });
        return res.json();
    },

    /**
     * Regenerate image for a single scene
     * @param {number} sceneId
     * @param {string[]} accessTokens - list of Google access tokens
     */
    regenerate: async (sceneId, accessTokens = []) => {
        const res = await apiFetch('/regenerate', {
            method: 'POST',
            body: JSON.stringify({ scene_id: sceneId, access_token: accessTokens }),
        });
        return res.json();
    },

    /**
     * Get generation status + image list
     */
    getStatus: async (scriptId = 1) => {
        const res = await apiFetch(`/status/${scriptId}`);
        return res.json();
    },

    /**
     * Delete a scene and its generated images
     */
    deleteScene: async (sceneId) => {
        const res = await apiFetch(`/scenes/${sceneId}`, { method: 'DELETE' });
        return res.json();
    },

    /**
     * Export images as ZIP — returns blob URL for download
     */
    exportZip: async (scriptId = 1) => {
        const res = await apiFetch(`/export-zip?script_id=${scriptId}`);
        const blob = await res.blob();
        return URL.createObjectURL(blob);
    },

    /**
     * Get static image URL
     */
    getImageUrl: (fileName) => `${API_BASE}/static/${fileName}`,

    /**
     * List projects
     */
    getProjects: async () => {
        const res = await apiFetch('/projects');
        return res.json();
    },
});
