/**
 * NARRATIVA ENGINE 2.4 - BULLETPROOF
 * Fixed: Interactivity crashes, Nil-references, and Event Conflicts.
 */
import { initNetwork, addNetworkNode, setMode } from './views/network.js';

class NarrativaStore {
    constructor(initial) {
        this.state = initial;
        this.listeners = [];
    }
    getState() { return this.state || {}; }
    setState(update) {
        this.state = { ...this.state, ...update };
        this.persist();
        if (!isApplyingRemoteState) {
            lastLocalMutationAt = Date.now();
            hasLocalUnsyncedChanges = true;
        }
        if (!isApplyingRemoteState && typeof window !== 'undefined' && typeof window.__scheduleServerSave === 'function') {
            window.__scheduleServerSave();
        }
        if (!isApplyingRemoteState) {
            scheduleLocalBackup();
        }
        this.notify();
    }
    persist() {
        // Persistencia principal en servidor: no guardamos estado de trabajo en localStorage.
    }
    createLightweightState(state) {
        const dropLargeDataUrl = (value, path) => {
            if (typeof value !== 'string') return value;
            if (!value.startsWith('data:image/')) return value;
            const allowMerchImage = Array.isArray(path) && path.includes('merch');
            const maxLen = allowMerchImage ? 700000 : 120000;
            // Keep small images; drop large inline payloads to avoid quota failures.
            return value.length > maxLen ? null : value;
        };
        const walk = (node, path = []) => {
            if (Array.isArray(node)) return node.map((n, i) => walk(n, [...path, String(i)]));
            if (!node || typeof node !== 'object') return dropLargeDataUrl(node, path);
            const out = {};
            Object.keys(node).forEach(k => {
                // EXCLUDE global data from per-user state persistence
                if (k === 'merch' && path.length === 0) return;

                if (k === 'image') out[k] = dropLargeDataUrl(node[k], [...path, k]);
                else out[k] = walk(node[k], [...path, k]);
            });
            return out;
        };
        return walk(state);
    }
    subscribe(fn) { this.listeners.push(fn); return () => this.listeners = this.listeners.filter(l => l !== fn); }
    notify() { this.listeners.forEach(l => { try { l(this.state); } catch (e) { console.error('[SUBSCRIBE] Listener failed:', e); } }); }

    addItem(key, item) {
        const list = this.state[key] || [];
        this.setState({ [key]: [...list, { ...item, id: Date.now() }] });
    }
    removeItem(key, id) {
        const list = this.state[key] || [];
        this.setState({ [key]: list.filter(i => i.id != id) });
    }
    updateItem(key, id, data) {
        const list = this.state[key] || [];
        this.setState({ [key]: list.map(i => i.id == id ? { ...i, ...data } : i) });
    }
}

const DEFAULT_STATE = {
    currentView: 'proyectos',
    searchQuery: '',
    units: [],
    proyectos: [],
    timeline: [],
    timelineBoards: [],
    network: [],
    storyboard: [],
    Colecciones: [],
    mapas: [],
    genealogy: [],
    tiers: [],
    folders: [],
    folderFilters: {},
    trivia: [
        { id: 1, question: 'Cual es el nombre del protagonista en "El Despertar de Lua"?', options: ['Lua', 'Kael', 'Aris', 'Zorath'], correct: 'Opcion A) Lua' }
    ],
    merch: [
        { id: 1, name: 'Camiseta de Narrativa', price: '19.99', desc: 'Edicion limitada de algodon 100%.', image: 'images/iconos/MERCH2.png' }
    ],
    publicaciones: [
        { id: 1, name: 'El Despertar de Lua', author: 'Narrativa Team', desc: 'Una historia corta sobre el inicio de todo.', image: 'images/HISTORIAS.jpeg' }
    ],
    isSubscribed: false,
    subscriptionPlan: 'free',
    isSuperadmin: false,
    networkPositions: {},
    mapTool: {
        type: 'cursor',
        color: '#00d2ff',
        size: 26,
        label: '',
        icon: 'FILE',
        image: null,
        arrowDir: 'right'
    },
    manualOpen: false,
    _adminTick: 0
};

const cloneDefaultState = () => JSON.parse(JSON.stringify(DEFAULT_STATE));

export const store = new NarrativaStore(cloneDefaultState());

let serverSyncEnabled = false;
let serverSyncTimer = null;
let localBackupTimer = null;
let csrfTokenCache = '';
let lastServerUpdatedAt = '';
let lastLocalMutationAt = 0;
let isApplyingRemoteState = false;
let hasLocalUnsyncedChanges = false;
let currentSessionUsername = '';
let paypalConfigCache = null;
let paypalSdkPromise = null;
let paypalButtonsRendered = false;
let paypalCheckoutErrorMessage = '';
let currentSessionRole = '';

const adminCache = {
    users: [],
    selectedUserId: null,
    selectedUser: null,
    state: null,
    stateUpdatedAt: '',
    stateJsonDraft: '',
    loadingUsers: false,
    loadingState: false,
    savingState: false,
    error: ''
};

const readJsonSafe = async (response) => {
    const raw = await response.text();
    if (!raw) return {};
    try {
        return JSON.parse(raw);
    } catch (e) {
        return { success: false, message: 'Respuesta invalida del servidor.', raw };
    }
};

const escapeHtml = (value) => {
    const str = String(value ?? '');
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
};

const isSuperadminRole = (role) => {
    const normalized = String(role || '').toLowerCase().trim();
    return normalized === 'superadmin' || normalized === 'main' || normalized === 'admin';
};

const adminTriggerRender = () => {
    store.setState({ _adminTick: Date.now() });
};

const updateUserMeta = () => {
    const el = document.getElementById('user-display');
    if (!el) return;
    const roleLabel = currentSessionRole ? currentSessionRole.toUpperCase() : 'USER';
    if (currentSessionUsername) {
        el.textContent = `${currentSessionUsername} • ${roleLabel}`;
    } else {
        el.textContent = roleLabel;
    }
};

const updateAdminVisibility = () => {
    const allow = isSuperadminRole(currentSessionRole);
    document.querySelectorAll('.admin-only').forEach((el) => {
        el.style.display = allow ? '' : 'none';
    });
};

const getLocalBackupKey = () => {
    const s = store.getState();
    const uid = s?._myUserId || currentSessionUsername || '';
    return `narrativa_state_backup_${uid || 'guest'}`;
};

const saveStateToLocalBackup = (state) => {
    try {
        const key = getLocalBackupKey();
        const payload = { state, updatedAt: new Date().toISOString() };
        localStorage.setItem(key, JSON.stringify(payload));
    } catch (e) {
        console.warn('[SYNC] No se pudo guardar backup local.', e);
    }
};

const loadStateFromLocalBackup = () => {
    try {
        const key = getLocalBackupKey();
        const raw = localStorage.getItem(key);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || !parsed.state) return null;
        return parsed.state;
    } catch (e) {
        console.warn('[SYNC] No se pudo leer backup local.', e);
        return null;
    }
};

const hasMeaningfulWorkspaceData = (state) => {
    if (!state || typeof state !== 'object') return false;
    const listKeys = ['units', 'proyectos', 'timeline', 'timelineBoards', 'network', 'storyboard', 'Colecciones', 'mapas', 'genealogy', 'tiers', 'folders'];
    return listKeys.some((k) => Array.isArray(state[k]) && state[k].length > 0);
};

const scheduleLocalBackup = () => {
    try {
        clearTimeout(localBackupTimer);
        localBackupTimer = setTimeout(() => {
            const payload = store.createLightweightState(store.getState());
            saveStateToLocalBackup(payload);
        }, 400);
    } catch (e) {
        // Non-fatal
    }
};

const getCsrfToken = async () => {
    if (csrfTokenCache) return csrfTokenCache;
    const response = await fetch('php/csrf.php', { credentials: 'same-origin' });
    const result = await response.json();
    if (!result.success || !result.token) {
        throw new Error('No se pudo obtener token CSRF');
    }
    csrfTokenCache = result.token;
    return csrfTokenCache;
};

const isLoggedInSession = async () => {
    try {
        const res = await fetch('php/session.php', { credentials: 'same-origin', cache: 'no-store' });
        const data = await res.json();
        return !!data.loggedIn;
    } catch (e) {
        console.warn('[SYNC] No se pudo verificar sesion.', e);
        return false;
    }
};

const loadSessionUser = async () => {
    try {
        const res = await fetch('php/session.php', { credentials: 'same-origin', cache: 'no-store' });
        const data = await res.json();
        currentSessionUsername = data && data.loggedIn && data.username ? String(data.username) : '';
        currentSessionRole = data && data.loggedIn && data.role ? String(data.role) : '';
        if (data && data.userId) {
            store.setState({
                _myUserId: data.userId,
                _myUsername: currentSessionUsername,
                _myRole: currentSessionRole,
                isSuperadmin: isSuperadminRole(currentSessionRole)
            });
        }
        updateUserMeta();
        updateAdminVisibility();
    } catch (e) {
        currentSessionUsername = '';
        currentSessionRole = '';
        updateUserMeta();
        updateAdminVisibility();
    }
};

const loadSubscriptionStatus = async () => {
    try {
        const res = await fetch('php/subscription.php?action=status', { credentials: 'same-origin' });
        const data = await readJsonSafe(res);
        if (!res.ok || !data.success) return;
        const isSubscribed = !!data.isSubscribed;
        const plan = isSubscribed ? 'pro' : 'free';
        const current = store.getState();
        if (current.isSubscribed !== isSubscribed || current.subscriptionPlan !== plan) {
            store.setState({ isSubscribed, subscriptionPlan: plan });
        }
    } catch (e) {
        console.warn('[SUBSCRIPTION] No se pudo cargar estado de suscripcion.', e);
    }
};

const adminEnsureUsersLoaded = async () => {
    if (adminCache.loadingUsers) return;
    adminCache.loadingUsers = true;
    adminCache.error = '';
    adminTriggerRender();
    try {
        const res = await fetch('php/admin.php?action=list_users', { credentials: 'same-origin', cache: 'no-store' });
        const data = await readJsonSafe(res);
        if (!res.ok || !data.success) {
            adminCache.error = data.message || 'No se pudo cargar usuarios.';
        } else {
            adminCache.users = Array.isArray(data.users) ? data.users : [];
        }
    } catch (e) {
        adminCache.error = 'No se pudo cargar usuarios.';
    } finally {
        adminCache.loadingUsers = false;
        adminTriggerRender();
    }
};

const adminLoadUserState = async (userId) => {
    if (!userId) return;
    adminCache.loadingState = true;
    adminCache.error = '';
    adminTriggerRender();
    try {
        const res = await fetch(`php/admin.php?action=get_user_state&userId=${encodeURIComponent(userId)}`, {
            credentials: 'same-origin',
            cache: 'no-store'
        });
        const data = await readJsonSafe(res);
        if (!res.ok || !data.success) {
            adminCache.error = data.message || 'No se pudo cargar estado.';
        } else {
            adminCache.state = data.state && typeof data.state === 'object' ? data.state : null;
            adminCache.stateUpdatedAt = data.updatedAt || '';
            adminCache.stateJsonDraft = JSON.stringify(adminCache.state || {}, null, 2);
        }
    } catch (e) {
        adminCache.error = 'No se pudo cargar estado.';
    } finally {
        adminCache.loadingState = false;
        adminTriggerRender();
    }
};

const adminSaveUserState = async (userId, state) => {
    if (!userId || !state || typeof state !== 'object') return;
    adminCache.savingState = true;
    adminCache.error = '';
    adminTriggerRender();
    try {
        const token = await getCsrfToken();
        const res = await fetch('php/admin.php?action=save_user_state', {
            method: 'POST',
            credentials: 'same-origin',
            headers: {
                'Content-Type': 'application/json',
                'X-CSRF-Token': token
            },
            body: JSON.stringify({ userId, state })
        });
        const data = await readJsonSafe(res);
        if (!res.ok || !data.success) {
            adminCache.error = data.message || 'No se pudo guardar estado.';
        } else {
            adminCache.stateUpdatedAt = data.updatedAt || adminCache.stateUpdatedAt;
            const myId = store.getState()._myUserId;
            if (myId && String(myId) === String(userId)) {
                store.setState(state);
            }
        }
    } catch (e) {
        adminCache.error = 'No se pudo guardar estado.';
    } finally {
        adminCache.savingState = false;
        adminTriggerRender();
    }
};

const adminSetRole = async (userId, role) => {
    if (!userId || !role) return;
    adminCache.error = '';
    adminTriggerRender();
    try {
        const token = await getCsrfToken();
        const res = await fetch('php/admin.php?action=set_role', {
            method: 'POST',
            credentials: 'same-origin',
            headers: {
                'Content-Type': 'application/json',
                'X-CSRF-Token': token
            },
            body: JSON.stringify({ userId, role })
        });
        const data = await readJsonSafe(res);
        if (!res.ok || !data.success) {
            adminCache.error = data.message || 'No se pudo actualizar rol.';
        } else {
            const u = adminCache.users.find((x) => String(x.id) === String(userId));
            if (u) u.role = data.role || role;
        }
    } catch (e) {
        adminCache.error = 'No se pudo actualizar rol.';
    } finally {
        adminTriggerRender();
    }
};

const saveStateToServer = async () => {
    if (!serverSyncEnabled) return;
    if (!hasLocalUnsyncedChanges) return;
    try {
        const payload = store.createLightweightState(store.getState());
        const res = await fetch('php/user_state.php?action=save', {
            method: 'POST',
            credentials: 'same-origin',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ action: 'save', state: payload, knownUpdatedAt: lastServerUpdatedAt || '' })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.success) {
            console.warn('[SYNC] Save rejected by server.', { status: res.status, data });
            if (res.status === 409) {
                // Conflict: keep local changes, update knownUpdatedAt, and retry once.
                const serverUpdatedAt = (data && (data.serverUpdatedAt || data.updatedAt)) ? String(data.serverUpdatedAt || data.updatedAt) : '';
                if (serverUpdatedAt) lastServerUpdatedAt = serverUpdatedAt;
                const retryPayload = store.createLightweightState(store.getState());
                const retryRes = await fetch('php/user_state.php?action=save', {
                    method: 'POST',
                    credentials: 'same-origin',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ action: 'save', state: retryPayload, knownUpdatedAt: lastServerUpdatedAt || '' })
                });
                const retryData = await retryRes.json().catch(() => ({}));
                if (retryRes.ok && retryData.success) {
                    if (typeof retryData.updatedAt === 'string' && retryData.updatedAt) {
                        lastServerUpdatedAt = retryData.updatedAt;
                    }
                    hasLocalUnsyncedChanges = false;
                    saveStateToLocalBackup(retryPayload);
                    console.log('[SYNC] Estado guardado en servidor (retry).');
                }
            }
        } else {
            if (typeof data.updatedAt === 'string' && data.updatedAt) {
                lastServerUpdatedAt = data.updatedAt;
            }
            hasLocalUnsyncedChanges = false;
            saveStateToLocalBackup(payload);
            console.log('[SYNC] Estado guardado en servidor.');
        }
    } catch (e) {
        console.warn('[SYNC] No se pudo guardar estado en servidor.', e);
        try {
            const payload = store.createLightweightState(store.getState());
            saveStateToLocalBackup(payload);
        } catch (err) {
            console.warn('[SYNC] Backup local fallo.', err);
        }
    }
};

const loadGlobalMerch = async () => {
    try {
        const res = await fetch('php/merch.php?action=list');
        const data = await res.json();
        if (data && data.success) {
            // No longer silent so UI updates after save/upload
            store.setState({ merch: data.merch || [] });
        }
    } catch (e) {
        console.warn('[MERCH] Error loading global merch:', e);
    }
};

const scheduleServerSave = () => {
    if (!serverSyncEnabled) return;
    clearTimeout(serverSyncTimer);
    serverSyncTimer = setTimeout(() => {
        saveStateToServer();
    }, 700);
};

if (typeof window !== 'undefined') {
    window.__scheduleServerSave = scheduleServerSave;
    window.__forceServerSave = saveStateToServer;
}

const loadStateFromServer = async (opts = {}) => {
    const silent = !!opts.silent;
    try {
        const logged = await isLoggedInSession();
        if (!logged) return;

        const res = await fetch('php/user_state.php?action=load', {
            method: 'GET',
            credentials: 'same-origin',
            cache: 'no-store'
        });
        const data = await res.json();
        if (!res.ok || !data.success) {
            if (!silent) console.warn('[SYNC] Load rejected by server.', { status: res.status, data });
            const fallback = loadStateFromLocalBackup();
            if (fallback && typeof fallback === 'object') {
                isApplyingRemoteState = true;
                store.setState(fallback);
                isApplyingRemoteState = false;
                store.setState({ isSubscribed: false, subscriptionPlan: 'free' });
                hasLocalUnsyncedChanges = true;
                if (!silent) console.log('[SYNC] Estado restaurado desde backup local.');
            }
            return;
        }
        if (!data.state || typeof data.state !== 'object') {
            if (!silent) console.log('[SYNC] Servidor sin estado previo para este usuario.');
            const fallback = loadStateFromLocalBackup();
            if (fallback && typeof fallback === 'object') {
                isApplyingRemoteState = true;
                store.setState(fallback);
                isApplyingRemoteState = false;
                store.setState({ isSubscribed: false, subscriptionPlan: 'free' });
                hasLocalUnsyncedChanges = true;
                if (!silent) console.log('[SYNC] Estado restaurado desde backup local.');
            }
            return;
        }

        const incomingUpdatedAt = (data.updatedAt || '').toString();
        if (incomingUpdatedAt && incomingUpdatedAt === lastServerUpdatedAt) {
            return;
        }
        // Do not overwrite very recent local edits.
        if (Date.now() - lastLocalMutationAt < 3000) {
            return;
        }

        const serverHasData = hasMeaningfulWorkspaceData(data.state);
        if (!serverHasData) {
            if (!silent) console.log('[SYNC] Servidor sin datos significativos. Se mantiene estado base.');
            const fallback = loadStateFromLocalBackup();
            if (fallback && typeof fallback === 'object') {
                isApplyingRemoteState = true;
                store.setState(fallback);
                isApplyingRemoteState = false;
                store.setState({ isSubscribed: false, subscriptionPlan: 'free' });
                hasLocalUnsyncedChanges = true;
                if (!silent) console.log('[SYNC] Estado restaurado desde backup local.');
            }
            return;
        }

        isApplyingRemoteState = true;
        const nextRemoteState = { ...data.state };
        // NEVER overwrite global merch with old user-state data
        delete nextRemoteState.merch;
        store.setState(nextRemoteState);
        isApplyingRemoteState = false;
        // Never trust premium flags from saved workspace state.
        // Subscription status must come from php/subscription.php?action=status.
        store.setState({ isSubscribed: false, subscriptionPlan: 'free' });
        lastServerUpdatedAt = incomingUpdatedAt;
        hasLocalUnsyncedChanges = false;
        saveStateToLocalBackup(store.createLightweightState(store.getState()));
        if (!silent) console.log('[SYNC] Estado cargado desde servidor.');

        // After loading state, load global merch
        await loadGlobalMerch();
    } catch (e) {
        if (!silent) console.warn('[SYNC] No se pudo cargar estado desde servidor.', e);
        const fallback = loadStateFromLocalBackup();
        if (fallback && typeof fallback === 'object') {
            isApplyingRemoteState = true;
            const nextFallback = { ...fallback };
            delete nextFallback.merch;
            store.setState(nextFallback);
            isApplyingRemoteState = false;
            store.setState({ isSubscribed: false, subscriptionPlan: 'free' });
            hasLocalUnsyncedChanges = true;
            if (!silent) console.log('[SYNC] Estado restaurado desde backup local.');
        }
        await loadGlobalMerch();
    }
};

const retryInitialServerLoad = async () => {
    const maxAttempts = 3;
    for (let i = 0; i < maxAttempts; i++) {
        const current = store.getState();
        if (hasMeaningfulWorkspaceData(current)) return;
        await new Promise((resolve) => setTimeout(resolve, 900));
        await loadStateFromServer({ silent: true });
    }
};

// Expose for inline handlers
window.store = store;

const TRIVIA_STATIC_MS = 1800;
const TRIVIA_RESULT_MS = 900;
const TRIVIA_SPLASH_VIDEO = 'images/videos/TRIVIA SPLASH.mp4';
const TRIVIA_SPLASH_MODAL_ID = 'trivia-splash-modal';
const triviaSession = {
    index: 0,
    playStatic: false
};

const closeTriviaSplash = () => {
    const modal = document.getElementById(TRIVIA_SPLASH_MODAL_ID);
    if (!modal) return;
    const video = modal.querySelector('video');
    if (video) {
        try {
            video.pause();
            video.currentTime = 0;
        } catch (_) { }
    }
    modal.remove();
};

const openTriviaSplash = () => {
    if (typeof document === 'undefined') return;
    if (document.getElementById(TRIVIA_SPLASH_MODAL_ID)) return;

    const modal = document.createElement('div');
    modal.id = TRIVIA_SPLASH_MODAL_ID;
    modal.style.cssText = 'position:fixed; inset:0; background:rgba(4,6,14,0.82); display:flex; align-items:center; justify-content:center; z-index:10000; padding:20px;';
    modal.innerHTML = `
        <div style="position:relative; width:min(920px, 100%); border-radius:16px; overflow:hidden; border:1px solid rgba(255,255,255,0.18); box-shadow:0 20px 60px rgba(0,0,0,0.55); background:#000;">
            <button type="button" onclick="closeTriviaSplash()" aria-label="Cerrar" style="position:absolute; top:10px; right:10px; z-index:2; border:none; border-radius:10px; padding:6px 10px; font-weight:700; cursor:pointer; background:rgba(0,0,0,0.7); color:#fff;">X</button>
            <video autoplay controls playsinline style="width:100%; display:block; max-height:80vh;">
                <source src="${TRIVIA_SPLASH_VIDEO}" type="video/mp4">
            </video>
        </div>
    `;

    modal.addEventListener('click', (ev) => {
        if (ev.target === modal) closeTriviaSplash();
    });

    document.body.appendChild(modal);
};

window.closeTriviaSplash = closeTriviaSplash;

const getTriviaList = () => store.getState().trivia || [];

const parseTriviaLetter = (value) => {
    const text = (value || '').toString().toUpperCase();
    const match = text.match(/\b([A-D])\b/);
    return match ? match[1] : '';
};

const RESTRICTED_VIEWS = ['mapas', 'map_detail', 'storyboard', 'crear_storyboard'];
const FREE_PLAN_LIMITS = {
    characters: 40,
    objects: 40,
    places: 16,
    timelines: 8,
    networks: 8,
    trees: 6,
    tiers: 8,
    icebergs: 8,
    collections: 6
};

const LIMIT_LABELS = {
    characters: 'Personajes',
    objects: 'Objetos',
    places: 'Lugares',
    timelines: 'Lineas de tiempo',
    networks: 'Redes',
    trees: 'Arboles',
    tiers: 'Tier Lists',
    icebergs: 'Icebergs',
    collections: 'Colecciones'
};

const getUsageByPlanKey = (s = store.getState()) => {
    const tiers = s.tiers || [];
    return {
        characters: (s.units || []).filter(u => u.type === 'Personaje').length,
        objects: (s.units || []).filter(u => u.type === 'Objeto').length,
        places: (s.units || []).filter(u => u.type === 'Lugar').length,
        timelines: (s.timelineBoards || []).length,
        networks: (s.networkNodes || []).length,
        trees: (s.genealogy || []).length,
        tiers: tiers.filter(t => (t.viewMode || 'tier') !== 'iceberg').length,
        icebergs: tiers.filter(t => (t.viewMode || 'tier') === 'iceberg').length,
        collections: (s.Colecciones || []).length
    };
};

const canCreateForPlan = (key) => {
    const s = store.getState();
    if (s.isSubscribed) return true;
    const limit = FREE_PLAN_LIMITS[key];
    if (!Number.isFinite(limit)) return true;
    const usage = getUsageByPlanKey(s)[key] || 0;
    if (usage < limit) return true;
    const label = LIMIT_LABELS[key] || 'elementos';
    CustomDialog.confirm(`Plan gratuito: llegaste al limite de ${limit} ${label}. Cambia a plan Pro para uso ilimitado o elige donar en Planes.`);
    return false;
};

const buildDefaultTierRows = () => ([
    { id: 's', label: 'S', color: 'tier-s', items: [] },
    { id: 'a', label: 'A', color: 'tier-a', items: [] },
    { id: 'b', label: 'B', color: 'tier-b', items: [] },
    { id: 'c', label: 'C', color: 'tier-c', items: [] },
    { id: 'd', label: 'D', color: 'tier-d', items: [] }
]);

// --- CUSTOM DIALOG SYSTEM ---
const CustomDialog = {
    modal: null,
    title: null,
    message: null,
    inputContainer: null,
    input: null,
    selectContainer: null,
    select: null,
    fileContainer: null,
    fileInput: null,
    btnConfirm: null,
    btnCancel: null,
    resolver: null,

    init() {
        this.modal = document.getElementById('dialog-modal');
        this.title = document.getElementById('dialog-title');
        this.message = document.getElementById('dialog-message');
        this.inputContainer = document.getElementById('dialog-input-container');
        this.input = document.getElementById('dialog-input');
        this.selectContainer = document.getElementById('dialog-select-container');
        this.select = document.getElementById('dialog-select');
        this.fileContainer = document.getElementById('dialog-file-container');
        this.fileInput = document.getElementById('dialog-file');
        this.btnConfirm = document.getElementById('btn-dialog-confirm');
        this.btnCancel = document.getElementById('btn-dialog-cancel');

        this.btnConfirm.onclick = () => {
            const useInput = this.inputContainer.style.display === 'block';
            const useSelect = this.selectContainer && this.selectContainer.style.display === 'block';
            const useFile = this.fileContainer && this.fileContainer.style.display === 'block';
            if (useFile) {
                const payload = {
                    value: useInput ? this.input.value : '',
                    file: this.fileInput?.files?.[0] || null
                };
                this.close(payload);
            } else if (useSelect) {
                const val = this.select ? this.select.value : '';
                this.close(val);
            } else {
                const val = useInput ? this.input.value : true;
                this.close(val);
            }
        };
        this.btnCancel.onclick = () => this.close(false);

        // Handle Enter key in input
        this.input.onkeydown = (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                this.btnConfirm.click();
            }
        };
    },

    show(opts) {
        if (!this.modal) this.init();
        this.title.textContent = opts.title || 'Confirmar';
        this.message.textContent = opts.message || '';
        if (this.input) this.input.value = opts.value || '';
        this.inputContainer.style.display = opts.showInput ? 'block' : 'none';
        if (this.selectContainer) this.selectContainer.style.display = opts.showSelect ? 'block' : 'none';
        if (opts.showSelect && this.select) {
            const options = (opts.selectOptions || []).map(o => `<option value="${o.value}">${o.label}</option>`).join('');
            this.select.innerHTML = options;
            if (opts.value !== undefined) this.select.value = opts.value;
        }
        if (this.fileContainer) {
            this.fileContainer.style.display = opts.showFile ? 'block' : 'none';
            if (this.fileInput) this.fileInput.value = '';
        }
        this.modal.style.display = 'flex';
        if (opts.showInput) setTimeout(() => this.input.focus(), 50);

        return new Promise(resolve => {
            this.resolver = resolve;
        });
    },

    close(value) {
        this.modal.style.display = 'none';
        if (this.resolver) this.resolver(value);
    },

    async confirm(msg) {
        return await this.show({ message: msg, showInput: false });
    },

    async prompt(msg, defaultValue = '') {
        const result = await this.show({ message: msg, value: defaultValue, showInput: true, title: 'Datos requeridos' });
        if (result === false) return false;
        return (typeof result === 'string') ? result : '';
    }
    ,
    async promptWithFile(msg, defaultValue = '') {
        const result = await this.show({ message: msg, value: defaultValue, showInput: true, showFile: true, title: 'Datos requeridos' });
        if (result === false) return false;
        return result;
    },
    async selectPrompt(msg, options = [], defaultValue = '') {
        const result = await this.show({ message: msg, showSelect: true, selectOptions: options, value: defaultValue, title: 'Seleccionar' });
        if (result === false) return false;
        return (typeof result === 'string') ? result : '';
    }
};

const readFileAsDataURL = (file) => {
    return new Promise((resolve, reject) => {
        if (!file) {
            resolve(null);
            return;
        }
        if (file && file.type && file.type.startsWith('image/')) {
            const img = new Image();
            const objectUrl = URL.createObjectURL(file);
            img.onload = () => {
                try {
                    const maxSide = 1280;
                    const scale = Math.min(1, maxSide / Math.max(img.width || 1, img.height || 1));
                    const w = Math.max(1, Math.round((img.width || 1) * scale));
                    const h = Math.max(1, Math.round((img.height || 1) * scale));
                    const canvas = document.createElement('canvas');
                    canvas.width = w;
                    canvas.height = h;
                    const ctx = canvas.getContext('2d');
                    if (!ctx) {
                        URL.revokeObjectURL(objectUrl);
                        resolve(null);
                        return;
                    }
                    ctx.drawImage(img, 0, 0, w, h);
                    // JPEG with quality keeps payload small enough for localStorage.
                    const compressed = canvas.toDataURL('image/jpeg', 0.72);
                    URL.revokeObjectURL(objectUrl);
                    resolve(compressed);
                } catch (err) {
                    URL.revokeObjectURL(objectUrl);
                    reject(err);
                }
            };
            img.onerror = (err) => {
                URL.revokeObjectURL(objectUrl);
                reject(err);
            };
            img.src = objectUrl;
            return;
        }
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(file);
    });
};

const normalizeText = (val) => (val || '')
    .toString()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();

const clipText = (val, max = 90) => {
    const clean = (val || '').toString().trim();
    if (!clean) return '';
    return clean.length > max ? `${clean.slice(0, max)}...` : clean;
};

const formatTimelineDate = (value) => {
    if (!value) return 'Sin fecha';
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return value;
    return d.toLocaleDateString('es-MX', { day: 'numeric', month: 'long', year: 'numeric' });
};

const matchesSearch = (item, query, extra = []) => {
    if (!query) return true;
    const hay = [
        item?.name,
        item?.desc,
        item?.type,
        ...(item?.fields || []).map(f => `${f.label} ${f.value}`),
        ...extra
    ].join(' ');
    return normalizeText(hay).includes(normalizeText(query));
};

const buildSearchCard = (title, meta, actionLabel, action) => `
    <div class="glass" style="padding:1rem; border-radius:16px; display:flex; gap:12px; align-items:center; justify-content:space-between;">
        <div style="min-width:0;">
            <div style="font-weight:700; font-size:0.95rem; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${title}</div>
            ${meta ? `<div style="opacity:0.65; font-size:0.75rem; margin-top:4px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${meta}</div>` : ''}
        </div>
        <button class="f-button glass" style="padding:8px 12px; font-size:0.7rem; white-space:nowrap;" onclick="${action}">${actionLabel}</button>
    </div>
`;

const buildSearchSection = (title, itemsHtml, count) => {
    if (!count) return '';
    return `
        <div class="glass" style="padding:1.6rem; border-radius:22px; margin-bottom:16px;">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px;">
                <h3 style="margin:0; font-size:1.1rem;">${title}</h3>
                <span style="opacity:0.6; font-size:0.75rem;">${count} resultado${count === 1 ? '' : 's'}</span>
            </div>
            <div class="card-grid" style="grid-template-columns:repeat(auto-fill, minmax(220px, 1fr));">
                ${itemsHtml}
            </div>
        </div>
    `;
};

const renderGlobalSearchResults = (s) => {
    const query = (s.searchQuery || '').trim();
    if (!query) {
        return `
            <div class="glass" style="padding:3rem; border-radius:30px; text-align:center; max-width:800px; margin:30px auto;">
                <h2 style="margin-bottom:0.8rem;">Busca en todo tu workspace</h2>
                <p style="opacity:0.7; margin:0;">Escribe en el buscador para ver resultados combinados de todas las herramientas.</p>
            </div>
        `;
    }

    const projects = (s.proyectos || []).filter(p => matchesSearch(p, query));
    const units = (s.units || []).filter(u => matchesSearch(u, query));
    const maps = (s.mapas || []).filter(m => matchesSearch(m, query));
    const genealogy = (s.genealogy || []).filter(g => matchesSearch(g, query, (g.members || []).map(m => `${m.name} ${m.role || ''}`)));
    const timelineBoards = (s.timelineBoards || []).filter(b => matchesSearch(b, query, (b.events || []).map(ev => `${ev.name || ''} ${ev.desc || ''}`)));
    const timelineEvents = (s.timeline || []).filter(t => matchesSearch(t, query, [t.unitName, t.unitType, t.date]));
    const collections = (s.Colecciones || []).filter(c => matchesSearch(c, query, (c.items || []).map(i => i.name)));
    const tiers = (s.tiers || []).filter(t => matchesSearch(t, query, t.items || []));
    const storyboards = (s.storyboard || []).filter(st => matchesSearch(st, query, (st.items || []).map(it => it.name)));
    const networks = (s.network || []).filter(n => matchesSearch(n, query, [n.p1, n.p2]));
    const pubs = (s._communityPubs || []).filter(o => matchesSearch(o, query, [o.title, o.author, o.genre, o.description]));

    const sections = [];

    sections.push(buildSearchSection(
        'Proyectos / Historias',
        projects.map(p => buildSearchCard(
            p.name || 'Sin titulo',
            p.universo ? `Universo: ${p.universo}` : (p.desc ? clipText(p.desc, 60) : ''),
            'EDITAR',
            `store.setState({ currentView: 'proyectos', searchQuery: '' }); openModal('Proyecto', '${p.id}')`
        )).join(''),
        projects.length
    ));

    sections.push(buildSearchSection(
        'Personajes / Lugares / Objetos',
        units.map(u => buildSearchCard(
            u.name || 'Sin nombre',
            `${u.type || 'Unidad'}${u.desc ? ` · ${clipText(u.desc, 60)}` : ''}`,
            'ABRIR',
            `store.setState({ currentView: 'detalle_unit', activeId: '${u.id}', searchQuery: '' })`
        )).join(''),
        units.length
    ));

    sections.push(buildSearchSection(
        'Cronologias',
        timelineBoards.map(b => buildSearchCard(
            b.name || 'Timeline',
            b.desc ? clipText(b.desc, 60) : 'Linea de tiempo',
            'ABRIR',
            `store.setState({ currentView: 'timeline_board_detail', activeId: '${b.id}', activeTimelineBoardId: null, searchQuery: '' })`
        )).join(''),
        timelineBoards.length
    ));

    sections.push(buildSearchSection(
        'Eventos',
        timelineEvents.map(t => buildSearchCard(
            t.name || t.unitName || 'Evento',
            `${t.unitType || 'Evento'} · ${formatTimelineDate(t.date)}`,
            'VER',
            `store.setState({ currentView: 'timeline', searchQuery: '' })`
        )).join(''),
        timelineEvents.length
    ));

    sections.push(buildSearchSection(
        'Mapas',
        maps.map(m => buildSearchCard(
            m.name || 'Mapa',
            m.desc ? clipText(m.desc, 60) : 'Mapa cartografico',
            'ABRIR',
            `store.setState({ currentView: 'map_detail', activeId: '${m.id}', searchQuery: '' })`
        )).join(''),
        maps.length
    ));

    sections.push(buildSearchSection(
        'Storyboards',
        storyboards.map(st => buildSearchCard(
            st.name || 'Storyboard',
            st.desc ? clipText(st.desc, 60) : 'Secuencias visuales',
            'ABRIR',
            `store.setState({ currentView: 'storyboard', searchQuery: '' })`
        )).join(''),
        storyboards.length
    ));

    sections.push(buildSearchSection(
        'Colecciones',
        collections.map(c => buildSearchCard(
            c.name || 'Coleccion',
            c.desc ? clipText(c.desc, 60) : `${(c.items || []).length} item(s)`,
            'ABRIR',
            `store.setState({ currentView: 'Colecciones', searchQuery: '' })`
        )).join(''),
        collections.length
    ));

    sections.push(buildSearchSection(
        'Icebergs / Tiers',
        tiers.map(t => buildSearchCard(
            t.name || 'Tier',
            (t.viewMode || 'tier').toUpperCase(),
            'ABRIR',
            `store.setState({ currentView: 'tier_detail', activeId: '${t.id}', searchQuery: '' })`
        )).join(''),
        tiers.length
    ));

    sections.push(buildSearchSection(
        'Arboles',
        genealogy.map(g => buildSearchCard(
            g.name || 'Arbol',
            g.desc ? clipText(g.desc, 60) : `${(g.members || []).length} miembro(s)`,
            'ABRIR',
            `store.setState({ currentView: 'genealogy', searchQuery: '' })`
        )).join(''),
        genealogy.length
    ));

    sections.push(buildSearchSection(
        'Redes',
        networks.map(n => buildSearchCard(
            n.name || 'Conexion',
            `${n.p1 || ''} ${n.p2 ? `â†” ${n.p2}` : ''}`.trim(),
            'ABRIR',
            `store.setState({ currentView: 'network', searchQuery: '' })`
        )).join(''),
        networks.length
    ));

    sections.push(buildSearchSection(
        'Publicaciones',
        pubs.map(o => buildSearchCard(
            o.title || 'Obra',
            `${o.author || 'Anonimo'}${o.genre ? ` · ${o.genre}` : ''}`,
            'LEER',
            `store.setState({ searchQuery: '' }); openObraDetalle(${o.id})`
        )).join(''),
        pubs.length
    ));

    const total = projects.length + units.length + maps.length + genealogy.length + timelineBoards.length + timelineEvents.length + collections.length + tiers.length + storyboards.length + networks.length + pubs.length;
    const body = sections.filter(Boolean).join('');

    return `
        <div style="margin-bottom:1.2rem; display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:12px;">
            <div>
                <h2 style="margin:0 0 4px 0;">Resultados globales</h2>
                <p style="margin:0; opacity:0.6; font-size:0.85rem;">"${query}" · ${total} resultado${total === 1 ? '' : 's'}</p>
            </div>
            <button class="f-button glass" onclick="store.setState({ searchQuery: '', currentView: '${s._searchPrevView || 'proyectos'}' })">Cerrar busqueda</button>
        </div>
        ${body || '<div class="glass" style="padding:3rem; border-radius:30px; text-align:center; opacity:0.7;">Sin resultados en tu workspace.</div>'}
    `;
};

const collectFieldsFromForm = (form) => {
    if (!form) return [];
    const rows = Array.from(form.querySelectorAll('.field-row'));
    return rows.map(row => {
        const label = row.querySelector('.field-label')?.value?.trim();
        const value = row.querySelector('.field-value')?.value?.trim();
        if (!label && !value) return null;
        return { label: label || 'Dato', value: value || '' };
    }).filter(Boolean);
};

const appendFieldRow = (container, preset = null) => {
    if (!container) return;
    const row = document.createElement('div');
    row.className = 'field-row';
    row.innerHTML = `
        <input type="text" class="f-input field-label" placeholder="Campo (ej. Edad)" value="${preset?.label || ''}">
        <input type="text" class="f-input field-value" placeholder="Valor" value="${preset?.value || ''}">
        <button type="button" class="f-button glass field-remove" onclick="this.closest('.field-row').remove()">X</button>
    `;
    container.appendChild(row);
};

window.addFieldRow = (btn, preset = null) => {
    const container = btn?.closest('.field-block')?.querySelector('.field-rows');
    appendFieldRow(container, preset);
};

const listToItems = (text) => {
    return (text || '')
        .split('\n')
        .map(l => l.replace(/^[-*]\s?/, '').trim())
        .filter(Boolean);
};

const getFolderFilter = (viewKey) => {
    const s = store.getState();
    return s.folderFilters?.[viewKey] || '';
};

const setFolderFilter = (viewKey, folderId) => {
    const s = store.getState();
    store.setState({ folderFilters: { ...(s.folderFilters || {}), [viewKey]: folderId || '' } });
};

const getFolderByName = (name) => {
    const s = store.getState();
    const clean = (name || '').trim();
    if (!clean) return null;
    return (s.folders || []).find(f => f.name.toLowerCase() === clean.toLowerCase()) || null;
};

const ensureFolder = (name) => {
    const s = store.getState();
    const clean = (name || '').trim();
    if (!clean) return null;
    const existing = getFolderByName(clean);
    if (existing) return existing;
    const folder = { id: Date.now(), name: clean };
    store.setState({ folders: [...(s.folders || []), folder] });
    return folder;
};

const renderFolderBar = (viewKey) => {
    const s = store.getState();
    const current = getFolderFilter(viewKey);
    const options = [`<option value="">Todas las carpetas</option>`]
        .concat((s.folders || []).map(f => `<option value="${f.id}" ${String(f.id) === String(current) ? 'selected' : ''}>${f.name}</option>`))
        .join('');

    return `
        <div class="view-header-actions" style="gap:12px; flex-wrap:wrap;">
            <select class="f-input" style="max-width:260px;" onchange="setFolderFilter('${viewKey}', this.value)">
                ${options}
            </select>
            <button class="f-button glass" onclick="promptCreateFolder()">+ CARPETA</button>
            <button class="f-button glass" onclick="promptDeleteFolder()">BORRAR CARPETA</button>
        </div>
    `;
};

const getItemsForView = (s, viewKey) => {
    if (viewKey === 'proyectos') return s.proyectos || [];
    if (viewKey === 'mapas') return s.mapas || [];
    if (viewKey === 'storyboard') return s.storyboard || [];
    if (viewKey === 'personajes') return (s.units || []).filter(u => u.type === 'Personaje');
    if (viewKey === 'lugares') return (s.units || []).filter(u => u.type === 'Lugar');
    if (viewKey === 'inventario') return (s.units || []).filter(u => u.type === 'Objeto');
    if (viewKey === 'Colecciones') return s.Colecciones || [];
    if (viewKey === 'genealogy') return s.genealogy || [];
    if (viewKey === 'timeline') return s.timelineBoards || [];
    if (viewKey === 'tiers') return s.tiers || [];
    if (viewKey === 'network') return s.networkNodes || [];
    return [];
};

const renderFolderGallery = (viewKey) => {
    const s = store.getState();
    const folders = s.folders || [];
    if (!folders.length) return '';
    const current = getFolderFilter(viewKey);
    const allItems = getItemsForView(s, viewKey);
    const renderThumb = (item) => {
        const bg = item?.image ? `url(${item.image}) center/cover` : 'rgba(255,255,255,0.06)';
        const label = item?.image ? '' : (item?.name ? item.name[0] : '*');
        return `<div style="height:58px; border-radius:10px; background:${bg}; display:flex; align-items:center; justify-content:center; font-weight:800; color:white; font-size:0.8rem;">${label}</div>`;
    };
    const renderFolderCard = (f) => {
        const items = allItems.filter(i => String(i.folderId || '') === String(f.id));
        const thumbs = items.slice(0, 4).map(renderThumb).join('');
        return `
            <button class="glass" onclick="setFolderFilter('${viewKey}', '${f.id}')" style="text-align:left; padding:16px; border-radius:18px; border:1px solid var(--border-glass); cursor:pointer; background:rgba(255,255,255,0.02);">
                <div style="display:flex; align-items:center; gap:10px; margin-bottom:12px;">
                    <div style="width:34px; height:26px; border-radius:6px; background:linear-gradient(135deg, #2b2f5a, #121529); border:1px solid rgba(255,255,255,0.08); position:relative;">
                        <div style="position:absolute; top:-6px; left:6px; width:18px; height:10px; border-radius:6px 6px 2px 2px; background:#2b2f5a; border:1px solid rgba(255,255,255,0.08);"></div>
                    </div>
                    <div>
                        <div style="font-weight:800; letter-spacing:0.5px;">${f.name}</div>
                        <div style="font-size:0.7rem; opacity:0.7;">${items.length} elementos</div>
                    </div>
                </div>
                <div style="display:grid; grid-template-columns:1fr 1fr; gap:8px;">
                    ${thumbs || `<div style="grid-column:1/-1; font-size:0.8rem; opacity:0.6; padding:10px 0;">Sin elementos</div>`}
                </div>
            </button>
        `;
    };
    const allCount = allItems.length;
    const allActive = current ? '' : 'border:1px solid var(--accent-primary);';
    return `
        <div style="margin:1rem 0 2rem 0;">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:1rem;">
                <h3 style="font-size:1.1rem; opacity:0.85;">Carpetas</h3>
                <button class="f-button glass" onclick="setFolderFilter('${viewKey}', '')">VER TODO</button>
            </div>
            <div style="display:grid; grid-template-columns:repeat(auto-fill, minmax(220px, 1fr)); gap:16px;">
                <button class="glass" onclick="setFolderFilter('${viewKey}', '')" style="text-align:left; padding:16px; border-radius:18px; border:1px solid var(--border-glass); cursor:pointer; background:rgba(255,255,255,0.02); ${allActive}">
                    <div style="font-weight:800; margin-bottom:8px;">Todas</div>
                    <div style="font-size:0.8rem; opacity:0.7;">${allCount} elementos</div>
                </button>
                ${folders.map(renderFolderCard).join('')}
            </div>
        </div>
    `;
};

const filterByFolder = (items, viewKey) => {
    const folderId = getFolderFilter(viewKey);
    if (!folderId) return items;
    return (items || []).filter(i => String(i.folderId || '') === String(folderId));
};

// --- RENDER HELPERS ---
const universalAdd = (key, label) => `
    <div class="view-header-actions" style="margin-bottom: 2.5rem;">
        <button class="f-button" onclick="changeView('crear_${key}')">
            + ANADIR ${label.toUpperCase()}
        </button>
    </div>
`;

const renderActions = (key, id) => `
    <div class="card-actions-mini" style="position: absolute; top: 15px; right: 15px; display: flex; gap: 8px; z-index: 10;">
        <button class="btn-edit-universal" data-key="${key}" data-id="${id}" onclick="handleEditClick(event, '${key}', '${id}')" title="Editar" style="background: rgba(138, 79, 255, 0.4); border: 1px solid var(--accent-primary); color: white; border-radius: 6px; width: 30px; height: 30px; cursor: pointer; display: flex; align-items: center; justify-content: center; font-size: 0.8rem;"><img src="images/EDITAR.png" alt="Editar" class="action-btn-icon"></button>
        <button class="btn-folder-universal" data-key="${key}" data-id="${id}" onclick="handleFolderAssign(event, '${key}', '${id}')" title="Carpeta" style="background: rgba(255, 255, 255, 0.08); border: 1px solid rgba(255,255,255,0.2); color: white; border-radius: 6px; width: 30px; height: 30px; cursor: pointer; display: flex; align-items: center; justify-content: center; font-size: 0.7rem;"><img src="images/CARPETA..png" alt="Carpeta" class="action-btn-icon"></button>
        <button class="btn-delete-universal" data-key="${key}" data-id="${id}" onclick="handleDeleteClick(event, '${key}', '${id}')" style="background: rgba(239, 68, 68, 0.4); border: 1px solid #ef4444; color: white; border-radius: 6px; width: 30px; height: 30px; cursor: pointer; display: flex; align-items: center; justify-content: center; font-size: 0.8rem;">X</button>
    </div>
`;

const renderActionsNoFolder = (key, id) => `
    <div class="card-actions-mini" style="position: absolute; top: 15px; right: 15px; display: flex; gap: 8px; z-index: 10;">
        <button class="btn-edit-universal" data-key="${key}" data-id="${id}" onclick="handleEditClick(event, '${key}', '${id}')" title="Editar" style="background: rgba(138, 79, 255, 0.4); border: 1px solid var(--accent-primary); color: white; border-radius: 6px; width: 30px; height: 30px; cursor: pointer; display: flex; align-items: center; justify-content: center; font-size: 0.8rem;"><img src="images/EDITAR.png" alt="Editar" class="action-btn-icon"></button>
        <button class="btn-delete-universal" data-key="${key}" data-id="${id}" onclick="handleDeleteClick(event, '${key}', '${id}')" style="background: rgba(239, 68, 68, 0.4); border: 1px solid #ef4444; color: white; border-radius: 6px; width: 30px; height: 30px; cursor: pointer; display: flex; align-items: center; justify-content: center; font-size: 0.8rem;">X</button>
    </div>
`;

const renderTimelineBoardEventActions = (boardId, eventId) => `
    <div class="card-actions-mini" style="position: absolute; top: 15px; right: 15px; display: flex; gap: 8px; z-index: 10;">
        <button onclick="handleTimelineBoardEventEdit(event, '${boardId}', '${eventId}')" title="Editar" style="background: rgba(138, 79, 255, 0.4); border: 1px solid var(--accent-primary); color: white; border-radius: 6px; width: 30px; height: 30px; cursor: pointer; display: flex; align-items: center; justify-content: center; font-size: 0.8rem;"><img src="images/EDITAR.png" alt="Editar" class="action-btn-icon"></button>
        <button onclick="handleTimelineBoardEventDelete(event, '${boardId}', '${eventId}')" title="Eliminar" style="background: rgba(239, 68, 68, 0.4); border: 1px solid #ef4444; color: white; border-radius: 6px; width: 30px; height: 30px; cursor: pointer; display: flex; align-items: center; justify-content: center; font-size: 0.8rem;">X</button>
    </div>
`;

const renderTimelineShowcase = (events, units, opts = {}) => {
    const boardId = opts.boardId ? String(opts.boardId) : '';
    const actionRenderer = boardId
        ? (eventId) => renderTimelineBoardEventActions(boardId, eventId)
        : (eventId) => renderActions('timeline', eventId);
    return `
        <div class="timeline-showcase-wrap">
            <div class="timeline-showcase-title">HORIZONTAL TIMELINE</div>
            <div class="timeline-showcase-scroll">
                <div class="timeline-showcase-track">
                    <div class="timeline-showcase-axis"></div>
                    ${events.map((e, idx) => {
        const tone = (idx % 6) + 1;
        const unit = (units || []).find(u => String(u.id) === String(e.unitId));
        const mediaSource = e.image || unit?.image || '';
        const avatar = mediaSource
            ? `<div class="timeline-showcase-media" style="background-image:url(${mediaSource});"></div>`
            : `<div class="timeline-showcase-avatar timeline-showcase-avatar-fallback">${(e.unitName || e.name || '?').charAt(0).toUpperCase()}</div>`;
        return `
                            <div class="timeline-showcase-stage">
                                <div class="timeline-showcase-card tl-tone-${tone}">
                                    <h3 contenteditable="true" spellcheck="false" onfocus="handleTimelineFieldFocus(event, 'name')" onblur="handleTimelineInlineCommit(event, '${e.id}', 'name', '${boardId}')" style="cursor:text;">${e.name || 'Evento'}</h3>
                                    <div class="timeline-showcase-date" data-raw-date="${e.date || ''}" onclick="handleTimelineDatePicker(event, '${e.id}', '${boardId}')" style="cursor:pointer;">${formatTimelineDate(e.date)}</div>
                                    <p contenteditable="true" spellcheck="false" onfocus="handleTimelineFieldFocus(event, 'desc')" onblur="handleTimelineInlineCommit(event, '${e.id}', 'desc', '${boardId}')" style="cursor:text;">${clipText(e.desc || 'Sin descripcion', 80)}</p>
                                    ${e.unitName ? `<div class="timeline-showcase-tag">${e.unitType || 'Unidad'}: ${e.unitName}</div>` : ''}
                                    ${actionRenderer(e.id)}
                                </div>
                                <div class="timeline-showcase-pointer tl-tone-${tone}"></div>
                                <div class="timeline-showcase-node"></div>
                                <div class="timeline-showcase-stem"></div>
                                ${avatar}
                            </div>
                        `;
    }).join('')}
                </div>
            </div>
        </div>
    `;
};

const unitSummary = (u) => {
    if (u?.desc) return clipText(u.desc, 80);
    if (u?.fields?.length) {
        const f = u.fields[0];
        return clipText(`${f.label}: ${f.value}`, 80);
    }
    return 'Sin resumen';
};

const renderLockedView = () => `
    <div class="glass" style="padding: 5rem; border-radius: 40px; text-align: center; max-width: 800px; margin: 40px auto; animation: modalScale 0.4s ease-out;">
        <div style="font-size: 5rem; margin-bottom: 2rem;">LOCK</div>
        <h2 style="font-size: 2.5rem; margin-bottom: 1.5rem; background: linear-gradient(135deg, #fff 0%, var(--accent-primary) 100%); -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent;">Herramienta Premium</h2>
        <p style="font-size: 1.1rem; color: var(--text-secondary); margin-bottom: 3rem; line-height: 1.6;">Esta seccin est reservada para usuarios con suscripcin activa. Desbloquea Mapas, Storyboards, Colecciones y ms!</p>
        <div style="display: flex; gap: 20px; justify-content: center;">
            <button class="f-button" onclick="subscribeMock()" style="padding: 20px 40px; font-size: 1rem;">SUSCRIBIRME AHORA</button>
            <button class="f-button glass" onclick="changeView('proyectos')" style="background: transparent;">VOLVER AL INICIO</button>
        </div>
    </div>
`;

window.donateMock = () => {
    const donationUrl = 'https://paypal.me/Mindtrain';
    try {
        window.open(donationUrl, '_blank', 'noopener,noreferrer');
    } catch (e) {
        console.warn('[DONATE] No se pudo abrir enlace de donacion.', e);
    }
    CustomDialog.confirm('Gracias por apoyar el proyecto. Si quieres cambiar de plan, usa el boton de Planes.');
};

const fetchPaypalConfig = async () => {
    if (paypalConfigCache) return paypalConfigCache;
    const res = await fetch('php/subscription.php?action=config', { credentials: 'same-origin' });
    const data = await readJsonSafe(res);
    if (!res.ok || !data.success) {
        throw new Error(data.message || 'No se pudo obtener configuracion de PayPal.');
    }
    paypalConfigCache = data;
    return paypalConfigCache;
};

const loadPaypalSdk = async (clientId, currency = 'USD') => {
    if (window.paypal && typeof window.paypal.Buttons === 'function') return;
    if (paypalSdkPromise) return paypalSdkPromise;
    paypalSdkPromise = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = `https://www.paypal.com/sdk/js?client-id=${encodeURIComponent(clientId)}&currency=${encodeURIComponent(currency)}&intent=capture`;
        script.async = true;
        script.onload = () => resolve();
        script.onerror = () => reject(new Error('No se pudo cargar PayPal SDK.'));
        document.head.appendChild(script);
    });
    return paypalSdkPromise;
};

const renderPaypalProButton = async () => {
    const wrap = document.getElementById('paypal-pro-wrap');
    const container = document.getElementById('paypal-pro-button');
    if (!wrap || !container) return;

    const cfg = await fetchPaypalConfig();
    if (!cfg.configured || !cfg.clientId || cfg.clientId === 'REPLACE_WITH_PAYPAL_CLIENT_ID') {
        throw new Error('PayPal no configurado. Falta Client ID y Client Secret en servidor.');
    }

    await loadPaypalSdk(cfg.clientId, cfg.currency || 'USD');
    wrap.style.display = 'block';

    if (paypalButtonsRendered) return;
    if (!window.paypal || typeof window.paypal.Buttons !== 'function') {
        throw new Error('PayPal SDK no disponible.');
    }

    paypalCheckoutErrorMessage = '';

    window.paypal.Buttons({
        style: {
            layout: 'vertical',
            color: 'gold',
            shape: 'pill',
            label: 'paypal'
        },
        createOrder: async () => {
            try {
                const modal = document.getElementById('plan-modal');
                const billingCycle = modal?.dataset?.billing === 'yearly' ? 'yearly' : 'monthly';
                const token = await getCsrfToken();
                const res = await fetch('php/subscription.php?action=create_order', {
                    method: 'POST',
                    credentials: 'same-origin',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-CSRF-Token': token
                    },
                    body: JSON.stringify({ plan: 'pro', billingCycle })
                });
                const data = await res.json().catch(() => ({}));
                if (!res.ok || !data.success || !data.orderID) {
                    paypalCheckoutErrorMessage = data.message || 'No se pudo crear la orden PayPal.';
                    throw new Error(paypalCheckoutErrorMessage);
                }
                return data.orderID;
            } catch (e) {
                if (!paypalCheckoutErrorMessage) {
                    paypalCheckoutErrorMessage = e?.message || 'No se pudo crear la orden PayPal.';
                }
                throw e;
            }
        },
        onApprove: async (data) => {
            const token = await getCsrfToken();
            const res = await fetch('php/subscription.php?action=capture_order', {
                method: 'POST',
                credentials: 'same-origin',
                headers: {
                    'Content-Type': 'application/json',
                    'X-CSRF-Token': token
                },
                body: JSON.stringify({ orderID: data.orderID })
            });
            const body = await res.json().catch(() => ({}));
            if (!res.ok || !body.success) {
                CustomDialog.confirm(body.message || 'No se pudo confirmar el pago.');
                return;
            }
            store.setState({ isSubscribed: true, subscriptionPlan: 'pro' });
            window.closePlanCenter();
            CustomDialog.confirm('Pago confirmado. Plan Pro activado.');
        },
        onError: (err) => {
            const sdkMessage = (typeof err?.message === 'string' && err.message.trim() !== '')
                ? err.message.trim()
                : '';
            const message = paypalCheckoutErrorMessage || sdkMessage || 'PayPal reporto un error. Intenta de nuevo.';
            console.error('[PAYPAL] Error en checkout:', err, 'detalle:', paypalCheckoutErrorMessage);
            CustomDialog.confirm(message);
        },
        onCancel: () => {
            CustomDialog.confirm('Pago cancelado.');
        }
    }).render('#paypal-pro-button');

    paypalButtonsRendered = true;
};

window.setPlanBilling = (mode = 'monthly') => {
    const safeMode = mode === 'yearly' ? 'yearly' : 'monthly';
    const modal = document.getElementById('plan-modal');
    if (!modal) return;
    modal.dataset.billing = safeMode;
    const monthlyBtn = document.getElementById('plan-billing-monthly');
    const yearlyBtn = document.getElementById('plan-billing-yearly');
    if (monthlyBtn) monthlyBtn.classList.toggle('is-active', safeMode === 'monthly');
    if (yearlyBtn) yearlyBtn.classList.toggle('is-active', safeMode === 'yearly');
};

window.closePlanCenter = () => {
    const modal = document.getElementById('plan-modal');
    if (!modal) return;
    modal.style.display = 'none';
};

window.openPlanCenter = () => {
    const modal = document.getElementById('plan-modal');
    if (!modal) {
        CustomDialog.confirm('No se encontro el modal de planes en esta vista.');
        return;
    }
    modal.style.display = 'flex';
    window.setPlanBilling('monthly');
};

window.startProCheckout = async () => {
    try {
        await renderPaypalProButton();
    } catch (e) {
        console.warn('[PAYPAL] Checkout unavailable:', e);
        CustomDialog.confirm(e.message || 'No se pudo iniciar PayPal.');
    }
};

window.choosePlan = (plan) => {
    if (plan === 'pro') {
        window.startProCheckout();
        return;
    }
    (async () => {
        try {
            const token = await getCsrfToken();
            const res = await fetch('php/subscription.php?action=set_free', {
                method: 'POST',
                credentials: 'same-origin',
                headers: {
                    'Content-Type': 'application/json',
                    'X-CSRF-Token': token
                },
                body: JSON.stringify({ plan: 'free' })
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok || !data.success) {
                CustomDialog.confirm(data.message || 'No se pudo activar plan gratuito.');
                return;
            }
            store.setState({ isSubscribed: false, subscriptionPlan: 'free' });
            window.closePlanCenter();
            CustomDialog.confirm('Plan gratuito activado con limites por categoria.');
        } catch (e) {
            CustomDialog.confirm('Error cambiando a plan gratuito.');
        }
    })();
};

window.subscribeMock = () => {
    window.openPlanCenter();
};

window.unsubscribeMock = () => {
    store.setState({ isSubscribed: false, subscriptionPlan: 'free' });
    CustomDialog.confirm('Plan gratuito activado.');
};

window.resetApp = () => {
    (async () => {
        try {
            store.state = cloneDefaultState();
            hasLocalUnsyncedChanges = true;
            lastLocalMutationAt = Date.now();
            store.notify();
            await saveStateToServer();
        } finally {
            location.reload();
        }
    })();
};

// Global Safe Navigation
window.closeMobileSidebar = () => {
    if (typeof document === 'undefined') return;
    document.body.classList.remove('sidebar-open');
};
window.toggleMobileSidebar = () => {
    if (typeof document === 'undefined') return;
    document.body.classList.toggle('sidebar-open');
};
window.changeView = (v) => {
    const prevView = store.getState()?.currentView;
    window.closeMobileSidebar();
    store.setState({ currentView: v });
    if (v === 'trivia' && prevView !== 'trivia') {
        setTimeout(openTriviaSplash, 20);
    } else if (prevView === 'trivia' && v !== 'trivia') {
        closeTriviaSplash();
    }
};
window.viewDetails = (id) => {
    window.closeMobileSidebar();
    store.setState({ currentView: 'detalle_unit', activeId: id });
};
window.setFolderFilter = setFolderFilter;

const getPublicationProgressStorageKey = () => {
    const s = store.getState() || {};
    const uid = s._myUserId || currentSessionUsername || 'guest';
    return `narrativa_pub_read_progress_${uid}`;
};

const getPublicationProgressMap = () => {
    try {
        const raw = localStorage.getItem(getPublicationProgressStorageKey());
        if (!raw) return {};
        const parsed = JSON.parse(raw);
        return (parsed && typeof parsed === 'object') ? parsed : {};
    } catch (err) {
        return {};
    }
};

const getPublicationProgress = (pubId) => {
    const id = String(pubId || '');
    if (!id) return 0;
    const entry = getPublicationProgressMap()[id];
    const n = Number(entry && entry.percent);
    if (!Number.isFinite(n)) return 0;
    return Math.max(0, Math.min(100, Math.round(n)));
};

const savePublicationProgress = (pubId, payload) => {
    const id = String(pubId || '');
    if (!id) return;
    try {
        const map = getPublicationProgressMap();
        map[id] = {
            ...(map[id] || {}),
            ...(payload || {}),
            percent: Math.max(0, Math.min(100, Math.round(Number(payload?.percent || 0)))),
            updated_at: new Date().toISOString()
        };
        localStorage.setItem(getPublicationProgressStorageKey(), JSON.stringify(map));
    } catch (err) {
        console.warn('[Reader] Could not persist reading progress:', err);
    }
};

// --- ROUTER VIEWS ---
const routes = {
    resultados: (s) => `
        ${renderGlobalSearchResults(s)}
    `,
    proyectos: (s) => `
        ${renderFolderGallery('proyectos')}
        ${renderFolderBar('proyectos')}
        <div class="view-header-actions">
            <button class="f-button" onclick="openModal('Proyecto')">NUEVA HISTORIA</button>
        </div>
        <div class="card-grid">
            ${filterByFolder((s.proyectos || []).filter(p => matchesSearch(p, s.searchQuery)), 'proyectos').map(p => `
                <div class="f-card glass" style="position:relative; padding:0; overflow:hidden; display:flex; flex-direction:column;">
                    <div style="height:150px; background:${p.image ? `url(${p.image}) center/cover` : 'rgba(255,255,255,0.05)'}; border-bottom:1px solid rgba(255,255,255,0.1); display:flex; align-items:center; justify-content:center; font-size:3rem; opacity:0.8;">
                        ${p.image ? '' : 'FILE'}
                    </div>
                    <div style="padding:2rem;">
                        <h3 style="color:var(--accent-secondary); margin-bottom:10px;">${p.name || 'Sin Ttulo'}</h3>
                        <div style="font-size:0.8rem; opacity:0.7; margin-bottom:15px;">
                            <p><strong>Universo:</strong> ${p.universo || '---'}</p>
                        </div>
                        <p style="font-size:0.8rem; line-height:1.4; height:3.2em; overflow:hidden; opacity:0.8;">${p.desc || ''}</p>
                        ${renderActions('proyectos', p.id)}
                    </div>
                </div>
            `).join('')}
        </div>
    `,
    detalle_unit: (s, id) => {
        const item = (s.units || []).find(u => u.id == id);
        if (!item) return `<div class="glass" style="padding:4rem; text-align:center;"><h2>No se encontr el elemento.</h2><button class="f-button" onclick="changeView('proyectos')">VOLVER</button></div>`;
        const backView = { 'Personaje': 'personajes', 'Lugar': 'lugares', 'Objeto': 'inventario' }[item.type];

        return `
            <div class="glass" style="padding:4rem; border-radius:40px; max-width:900px; margin:0 auto; display:flex; gap:40px; animation: modalScale 0.4s ease-out; position:relative;">
                <div style="flex:1;">
                    <button class="f-button glass" onclick="changeView('${backView}')" style="margin-bottom:2rem;">VOLVER</button>
                    <div style="width:100%; height:450px; background:${item.image ? `url(${item.image}) center/cover` : 'rgba(255,255,255,0.05)'}; border-radius:24px; border:1px solid var(--border-glass); display:flex; align-items:center; justify-content:center; font-size:5rem; overflow:hidden;">
                        ${item.image ? '' : (item.type === 'Personaje' ? 'P' : item.type === 'Lugar' ? 'L' : 'O')}
                    </div>
                </div>
                <div style="flex:1; padding-top:2rem; display:flex; flex-direction:column;">
                    <div style="margin-bottom:20px;">
                        <span class="tool-tag" style="background:rgba(138, 79, 255, 0.2);">${item.type.toUpperCase()}</span>
                    </div>
                    <h2 style="font-size:3rem; margin-bottom:1.5rem; color:var(--accent-secondary); line-height:1.1;">${item.name}</h2>
                    <div style="flex:1; overflow-y:auto; max-height:300px; padding-right:10px;">
                        <p style="font-size:1.1rem; line-height:1.8; color:var(--text-secondary); white-space:pre-wrap; opacity:0.9; margin-bottom:20px;">${item.desc || 'Sin descripcin disponible.'}</p>
                        
                        ${(item.fields && item.fields.length > 0) ? `
                            <div style="margin-top:20px; border-top:1px solid rgba(255,255,255,0.1); padding-top:15px;">
                                <h4 style="font-size:0.75rem; letter-spacing:2px; opacity:0.5; margin-bottom:15px;">DATOS EXTRA</h4>
                                <div style="display:grid; gap:10px;">
                                    ${item.fields.map(f => `
                                        <div class="f-card glass" style="padding:12px 20px; display:flex; justify-content:space-between; align-items:center;">
                                            <span style="font-weight:800; font-size:0.7rem; color:var(--accent-primary); text-transform:uppercase;">${f.label}</span>
                                            <span style="font-size:0.9rem; font-weight:600;">${f.value}</span>
                                        </div>
                                    `).join('')}
                                </div>
                            </div>
                        ` : ''}
                    </div>
                    <div style="margin-top:3rem; display:flex; gap:15px; border-top:1px solid rgba(255,255,255,0.1); padding-top:2rem;">
                        <button class="f-button" onclick="store.setState({ currentView: 'editar_unit', activeId: '${item.id}', activeType: '${item.type}' })">EDITAR</button>
                        <button class="f-button glass" style="border-color:#ef4444; color:#ef4444;" onclick="CustomDialog.confirm('Eliminar?').then(ok => ok && store.removeItem('units', '${item.id}'))">ELIMINAR</button>
                    </div>
                </div>
            </div>
        `;
    },
    personajes: (s) => `
        ${renderFolderGallery('personajes')}
        ${renderFolderBar('personajes')}
        ${universalAdd('personaje', 'Personaje')}
        ${(() => {
            const chars = (s.units || [])
                .filter(u => u.type === 'Personaje')
                .filter(u => matchesSearch(u, s.searchQuery))
                .filter(u => filterByFolder([u], 'personajes').length);
            const totalSlots = Math.max(16, chars.length + 1);
            return `<div class="card-grid" style="grid-template-columns:repeat(4, minmax(0, 1fr));">
                ${Array.from({ length: totalSlots }).map((_, i) => {
                const p = chars[i];
                if (!p) {
                    return `
                            <div class="unit-card glass empty-slot" onclick="changeView('crear_personaje')" style="cursor:pointer; min-height:300px; display:flex; align-items:center; justify-content:center; border:1px dashed rgba(138, 79, 255, 0.45);">
                                <span style="font-size:2.2rem; color:var(--accent-primary); font-weight:800;">+</span>
                            </div>
                        `;
                }
                return `
                        <div class="unit-card" onclick="viewDetails('${p.id}')" style="cursor:pointer;">
                            <div class="card-avatar" style="${p.image ? `background:url(${p.image}) center center/cover;` : ''}">
                                ${p.image ? '' : (p.name ? p.name[0] : '?')}
                            </div>
                            <div class="card-info">
                                <h3>${p.name || 'Incognito'}</h3>
                                <p class="card-summary">${unitSummary(p)}</p>
                                <button class="f-button btn-view-ficha glass" style="margin-top:10px; font-size:0.7rem;">VER DETALLES</button>
                            </div>
                            ${renderActions('units', p.id)}
                        </div>
                    `;
            }).join('')}
            </div>`;
        })()}
    `,
    inventario: (s) => `
        ${renderFolderGallery('inventario')}
        ${renderFolderBar('inventario')}
        ${universalAdd('objeto', 'Objeto')}
        ${(() => {
            const objects = (s.units || [])
                .filter(u => u.type === 'Objeto')
                .filter(u => matchesSearch(u, s.searchQuery))
                .filter(u => filterByFolder([u], 'inventario').length);
            const totalSlots = Math.max(25, objects.length + 1);
            return `<div class="zelda-inventory-grid">
            ${Array.from({ length: totalSlots }).map((_, i) => {
                const item = objects[i];
                const summary = item ? unitSummary(item) : '';
                return `
                    <div class="inventory-slot glass ${item ? 'occupied' : 'empty-slot'}" 
                         data-id="${item ? item.id : ''}" 
                         style="position:relative; cursor:pointer;"
                         onclick="${item ? `viewDetails('${item.id}')` : 'changeView(\'crear_objeto\')'}"
                         title="${item ? `${item.name || 'Objeto'} - ${summary}` : 'Click para anadir objeto'}">
                        ${item && item.image ? `<div class="item-icon" style="background:url(${item.image}) center center/cover; width:80%; height:80%; border-radius:8px;"></div>` : (item ? 'OBJ' : '')}
                        ${item ? renderActions('units', item.id) : ''}
                        <div class="slot-glow"></div>
                    </div>
                `;
            }).join('')}
        </div>`;
        })()}
    `,
    crear_personaje: () => `
        <div class="glass" style="padding:4rem; border-radius:40px; max-width:800px; margin:0 auto;">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:3rem;">
                <h2>ANADIR NUEVO PERSONAJE</h2>
                <button class="f-button glass" onclick="changeView('personajes')">VOLVER</button>
            </div>
            <form id="dedicated-create-form" onsubmit="handleDedicatedSubmit(event, 'Personaje')">
                <input type="text" id="dc-name" required placeholder="Nombre..." class="f-input" style="margin-bottom:20px;">
                <div style="margin-bottom:20px;">
                    <label style="display:block; font-size:0.7rem; opacity:0.6; margin-bottom:10px;">IMAGEN DEL PERSONAJE:</label>
                    <input type="file" id="dc-image" accept="image/*" class="f-input" style="padding:10px;">
                </div>
                <textarea id="dc-desc" class="f-input" placeholder="Biografia..." style="height:120px; margin-bottom:20px;"></textarea>
                <div class="field-block">
                    <label style="display:block; font-size:0.7rem; opacity:0.6; margin-bottom:10px;">DATOS EXTRA:</label>
                    <div class="field-rows">
                        <div class="field-row">
                            <input type="text" class="f-input field-label" placeholder="Campo (ej. Edad)">
                            <input type="text" class="f-input field-value" placeholder="Valor">
                            <button type="button" class="f-button glass field-remove" onclick="this.closest('.field-row').remove()">X</button>
                        </div>
                    </div>
                    <button type="button" class="f-button glass" onclick="addFieldRow(this)">+ CAMPO</button>
                </div>
                <button type="submit" class="f-button" style="width:100%;">FORJAR PERSONAJE</button>
            </form>
        </div>
    `,

    crear_objeto: () => `
        <div class="glass" style="padding:4rem; border-radius:40px; max-width:800px; margin:0 auto;">
            <button class="f-button glass" onclick="changeView('inventario')" style="margin-bottom:2rem;">VOLVER</button>
            <form onsubmit="handleDedicatedSubmit(event, 'Objeto')">
                <input type="text" id="dc-name" required placeholder="Nombre del tem..." class="f-input" style="margin-bottom:20px;">
                <div style="margin-bottom:20px;">
                    <label style="display:block; font-size:0.7rem; opacity:0.6; margin-bottom:10px;">IMAGEN DEL OBJETO:</label>
                    <input type="file" id="dc-image" accept="image/*" class="f-input" style="padding:10px;">
                </div>
                <textarea id="dc-desc" class="f-input" placeholder="Propiedades..." style="height:120px; margin-bottom:20px;"></textarea>
                <div class="field-block">
                    <label style="display:block; font-size:0.7rem; opacity:0.6; margin-bottom:10px;">DATOS EXTRA:</label>
                    <div class="field-rows">
                        <div class="field-row">
                            <input type="text" class="f-input field-label" placeholder="Campo (ej. Edad)">
                            <input type="text" class="f-input field-value" placeholder="Valor">
                            <button type="button" class="f-button glass field-remove" onclick="this.closest('.field-row').remove()">X</button>
                        </div>
                    </div>
                    <button type="button" class="f-button glass" onclick="addFieldRow(this)">+ CAMPO</button>
                </div>                <button type="submit" class="f-button" style="width:100%; background:#f59e0b;">RECOGER OBJETO</button>
            </form>
        </div>
    `,
    crear_lugar: () => `
        <div class="glass" style="padding:4rem; border-radius:40px; max-width:800px; margin:0 auto;">
            <button class="f-button glass" onclick="changeView('lugares')" style="margin-bottom:2rem;">VOLVER</button>
            <form onsubmit="handleDedicatedSubmit(event, 'Lugar')">
                <input type="text" id="dc-name" required placeholder="Nombre de la locacin..." class="f-input" style="margin-bottom:20px;">
                <div style="margin-bottom:20px;">
                    <label style="display:block; font-size:0.7rem; opacity:0.6; margin-bottom:10px;">IMAGEN DEL LUGAR:</label>
                    <input type="file" id="dc-image" accept="image/*" class="f-input" style="padding:10px;">
                </div>
                <textarea id="dc-desc" class="f-input" placeholder="Ambiente..." style="height:120px; margin-bottom:20px;"></textarea>
                <div class="field-block">
                    <label style="display:block; font-size:0.7rem; opacity:0.6; margin-bottom:10px;">DATOS EXTRA:</label>
                    <div class="field-rows">
                        <div class="field-row">
                            <input type="text" class="f-input field-label" placeholder="Campo (ej. Edad)">
                            <input type="text" class="f-input field-value" placeholder="Valor">
                            <button type="button" class="f-button glass field-remove" onclick="this.closest('.field-row').remove()">X</button>
                        </div>
                    </div>
                    <button type="button" class="f-button glass" onclick="addFieldRow(this)">+ CAMPO</button>
                </div>                <button type="submit" class="f-button" style="width:100%; background:#10b981;">ESTABLECER LUGAR</button>
            </form>
        </div>
    `,
    lugares: (s) => `
        ${renderFolderGallery('lugares')}
        ${renderFolderBar('lugares')}
        ${universalAdd('lugar', 'Lugar')}
        ${(() => {
            const places = (s.units || [])
                .filter(u => u.type === 'Lugar')
                .filter(u => matchesSearch(u, s.searchQuery))
                .filter(u => filterByFolder([u], 'lugares').length);
            const totalSlots = Math.max(16, places.length + 1);
            return `<div class="card-grid" style="grid-template-columns:repeat(4, minmax(0, 1fr));">
                ${Array.from({ length: totalSlots }).map((_, i) => {
                const l = places[i];
                if (!l) {
                    return `
                            <div class="unit-card glass empty-slot" onclick="changeView('crear_lugar')" style="cursor:pointer; min-height:300px; display:flex; align-items:center; justify-content:center; border:1px dashed rgba(138, 79, 255, 0.45);">
                                <span style="font-size:2.2rem; color:var(--accent-primary); font-weight:800;">+</span>
                            </div>
                        `;
                }
                return `
                        <div class="unit-card" onclick="viewDetails('${l.id}')" style="cursor:pointer;">
                            <div class="card-avatar" style="${l.image ? `background:url(${l.image}) center center/cover;` : ''}">
                                ${l.image ? '' : 'L'}
                            </div>
                            <div class="card-info">
                                <h3>${l.name || 'Lugar'}</h3>
                                <p class="card-summary">${unitSummary(l)}</p>
                                <button class="f-button glass" style="margin-top:10px; font-size:0.7rem;">EXPLORAR</button>
                            </div>
                            ${renderActions('units', l.id)}
                        </div>
                    `;
            }).join('')}
            </div>`;
        })()}
    `,
    mapas: (s) => `
        ${renderFolderGallery('mapas')}
        ${renderFolderBar('mapas')}
        <div class="view-header-actions">
            <button class="f-button" onclick="openModal('Mapa')">NUEVO MAPA</button>
        </div>
        ${(() => {
            const maps = filterByFolder((s.mapas || []).filter(m => matchesSearch(m, s.searchQuery)), 'mapas');
            return `<div class="card-grid" style="grid-template-columns:repeat(4, minmax(0, 1fr));">
                ${Array.from({ length: 16 }).map((_, i) => {
                const m = maps[i];
                if (!m) {
                    return `
                            <div class="f-card glass empty-slot" onclick="openModal('Mapa')" style="cursor:pointer; min-height:300px; border:1px dashed rgba(138, 79, 255, 0.45); display:flex; align-items:center; justify-content:center;">
                                <span style="font-size:2.2rem; color:var(--accent-primary); font-weight:800;">+</span>
                            </div>
                        `;
                }
                return `
                        <div class="f-card glass map-entry" data-id="${m.id}" style="position:relative; padding:0; overflow:hidden; display:flex; flex-direction:column; cursor:pointer;">
                            <div style="height:180px; background:${m.image ? `url(${m.image}) center/cover` : 'rgba(255,255,255,0.05)'}; border-bottom:1px solid rgba(255,255,255,0.1);"></div>
                            <div style="padding:1.5rem;">
                                <h3 style="margin-bottom:8px;">${m.name || 'Mapa sin nombre'}</h3>
                                <p class="card-summary">${(m.pins || []).length} marcadores</p>
                                ${renderActions('mapas', m.id)}
                            </div>
                        </div>
                    `;
            }).join('')}
            </div>`;
        })()}
    `,
    genealogy: (s) => `
        ${renderFolderGallery('genealogy')}
        ${renderFolderBar('genealogy')}
        <div class="view-header-actions">
            <button class="f-button" onclick="changeView('crear_genealogy')">NUEVO ARBOL</button>
        </div>
        <div class="card-grid">
            ${filterByFolder((s.genealogy || []), 'genealogy')
            .filter(g => matchesSearch(g, s.searchQuery, (g.members || []).map(m => `${m.name} ${m.role || ''}`)))
            .map(g => `
                <div class="f-card glass" style="position:relative; padding:2rem; display:flex; flex-direction:column; gap:10px;">
                    <div class="tool-tag" style="width:fit-content;">ARBOL</div>
                    <h3 style="font-size:1.35rem;">${g.name || 'Arbol sin nombre'}</h3>
                    <p class="card-summary">${clipText(g.desc || 'Sin descripcion', 100)}</p>
                    <p style="font-size:0.78rem; opacity:0.7;">${(g.members || []).length} miembros</p>
                    <div style="margin-top:auto;">
                        <button class="f-button glass" onclick="store.setState({ currentView: 'genealogy_detail', activeId: '${g.id}' })">ABRIR ARBOL</button>
                    </div>
                    ${renderActions('genealogy', g.id)}
                </div>
            `).join('')}
            ${(s.genealogy || []).length === 0 ? '<div class="dev-msg">No hay arboles genealogicos todavia.</div>' : ''}
        </div>
    `,
    crear_genealogy: () => `
        <div class="glass" style="padding:4rem; border-radius:40px; max-width:800px; margin:0 auto;">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:3rem;">
                <h2>NUEVO ARBOL GENEALOGICO</h2>
                <button class="f-button glass" onclick="changeView('genealogy')">VOLVER</button>
            </div>
            <form onsubmit="handleGenealogySubmit(event)">
                <input type="text" id="gen-name" required placeholder="Nombre del arbol..." class="f-input" style="margin-bottom:20px;">
                <textarea id="gen-desc" class="f-input" placeholder="Descripcion del linaje..." style="height:140px; margin-bottom:20px;"></textarea>
                <button type="submit" class="f-button" style="width:100%;">CREAR ARBOL</button>
            </form>
        </div>
    `,
    genealogy_detail: (s, id) => {
        const tree = (s.genealogy || []).find(g => g.id == id);
        if (!tree) return `<div class="glass" style="padding:4rem; text-align:center;"><h2>Arbol no encontrado.</h2><button class="f-button" onclick="changeView('genealogy')">VOLVER</button></div>`;
        const members = tree.members || [];
        const roots = members.filter(m => !m.parentId || !members.some(x => String(x.id) === String(m.parentId)));
        const childrenByParent = members.reduce((acc, m) => {
            const p = String(m.parentId || '');
            if (!acc[p]) acc[p] = [];
            acc[p].push(m);
            return acc;
        }, {});
        const renderNode = (member) => {
            const children = childrenByParent[String(member.id)] || [];
            const avatar = member.image
                ? `url(${member.image}) center/cover`
                : 'linear-gradient(135deg, rgba(138, 79, 255, 0.35), rgba(0, 210, 255, 0.35))';
            return `
                <li style="text-align:center; list-style:none; position:relative; padding:20px 8px 0 8px;">
                    <div style="display:inline-flex; flex-direction:column; align-items:center; gap:8px; min-width:120px; position:relative;">
                        <button type="button" title="Eliminar" onclick="removeGenealogyMember('${tree.id}', '${member.id}')" style="position:absolute; right:-4px; top:-8px; width:22px; height:22px; border-radius:999px; border:1px solid #ef4444; background:rgba(239,68,68,0.12); color:#ef4444; cursor:pointer; font-size:0.75rem;">X</button>
                        <div style="width:86px; height:86px; border-radius:999px; background:${avatar}; border:3px solid rgba(255,255,255,0.75); box-shadow:0 8px 20px rgba(0,0,0,0.18);"></div>
                        <div style="font-weight:800; font-size:1.05rem; line-height:1.1;">${member.name || 'Sin nombre'}</div>
                        <div style="opacity:0.78; font-size:0.88rem; line-height:1;">${member.role || 'Sin rol'}</div>
                    </div>
                    ${children.length ? `
                        <ul style="position:relative; padding-top:26px; margin:0; display:flex; justify-content:center; gap:34px;">
                            <span style="position:absolute; top:0; left:50%; width:2px; height:24px; background:rgba(255,255,255,0.45); transform:translateX(-50%);"></span>
                            <span style="position:absolute; top:0; left:10%; right:10%; height:2px; background:rgba(255,255,255,0.45);"></span>
                            ${children.map(ch => renderNode(ch)).join('')}
                        </ul>
                    ` : ''}
                </li>
            `;
        };
        return `
            <div class="glass genealogy-light-tree" style="padding:2.5rem; border-radius:32px; max-width:1280px; margin:0 auto; background:linear-gradient(135deg, rgba(18, 22, 54, 0.55), rgba(20, 25, 70, 0.42)); border:1px solid rgba(255,255,255,0.16); backdrop-filter:blur(14px); -webkit-backdrop-filter:blur(14px); box-shadow:0 14px 30px rgba(0,0,0,0.28); color:#f5f7ff;">
                <style>
                    .genealogy-light-tree .f-input {
                        background: #ffffff;
                        color: #000000 !important;
                        -webkit-text-fill-color: #000000;
                        border: 1px solid rgba(31, 41, 55, 0.18);
                    }
                    .genealogy-light-tree .f-input::placeholder {
                        color: rgba(31, 41, 55, 0.45);
                    }
                    .genealogy-light-tree label {
                        color: rgba(245, 247, 255, 0.82);
                    }
                </style>
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:1.2rem;">
                    <div>
                        <h2 style="margin-bottom:4px; font-size:3rem; letter-spacing:-0.5px;">${tree.name || 'Arbol genealogico'}</h2>
                        <p style="opacity:0.72; font-size:0.9rem;">${tree.desc || 'Sin descripcion'}</p>
                    </div>
                    <button class="f-button glass" onclick="changeView('genealogy')">VOLVER</button>
                </div>
                <form onsubmit="handleGenealogyMemberSubmit(event, '${tree.id}')" style="display:grid; grid-template-columns: 1.4fr 1fr 1fr 1fr auto; gap:12px; align-items:end; margin:1.2rem 0 1.8rem 0;">
                    <div>
                        <label style="display:block; font-size:0.7rem; opacity:0.7; margin-bottom:6px;">NOMBRE</label>
                        <input type="text" id="gm-name-${tree.id}" required class="f-input" placeholder="Ej. Aurelio I">
                    </div>
                    <div>
                        <label style="display:block; font-size:0.7rem; opacity:0.7; margin-bottom:6px;">ROL</label>
                        <input type="text" id="gm-role-${tree.id}" class="f-input" placeholder="Ej. Patriarca">
                    </div>
                    <div>
                        <label style="display:block; font-size:0.7rem; opacity:0.7; margin-bottom:6px;">PADRE/MADRE</label>
                        <select id="gm-parent-${tree.id}" class="f-input">
                            <option value="">Raiz</option>
                            ${members.map(m => `<option value="${m.id}">${m.name}</option>`).join('')}
                        </select>
                    </div>
                    <div>
                        <label style="display:block; font-size:0.7rem; opacity:0.7; margin-bottom:6px;">FOTO</label>
                        <input type="file" id="gm-image-${tree.id}" class="f-input" accept="image/*" style="padding:10px;">
                    </div>
                    <button type="submit" class="f-button">AGREGAR</button>
                </form>
                <div style="overflow:auto; padding:12px 8px 20px 8px;">
                    ${members.length
                ? `<ul style="margin:0; padding:6px 0 0 0; display:flex; justify-content:center; gap:28px;">${roots.map(r => renderNode(r)).join('')}</ul>`
                : '<div class="dev-msg">Aun no hay miembros en este arbol.</div>'}
                </div>
            </div>
        `;
    },
    timeline: (s) => `
        ${renderFolderGallery('timeline')}
        ${renderFolderBar('timeline')}
        <div class="view-header-actions">
            <button class="f-button" onclick="changeView('crear_timeline_board')">NUEVA TIMELINE</button>
        </div>
        ${(() => {
            const events = (s.timeline || [])
                .filter(t => matchesSearch(t, s.searchQuery, [t.unitName, t.unitType, t.date]));
            const boards = filterByFolder((s.timelineBoards || []), 'timeline')
                .filter(b => matchesSearch(b, s.searchQuery, (b.events || []).map(ev => `${ev.name || ''} ${ev.desc || ''}`)));
            return `
                <div style="margin-top:1.5rem;">
                    <h3 style="font-size:1.2rem; margin-bottom:0.9rem; letter-spacing:1px;">MIS TIMELINES</h3>
                    <div class="card-grid">
                        <div class="f-card glass" onclick="changeView('timeline_main_detail')" style="position:relative; padding:2rem; display:flex; flex-direction:column; gap:10px; cursor:pointer;">
                            <div class="tool-tag" style="width:fit-content;">PRINCIPAL</div>
                            <h3 style="font-size:1.35rem;">Timeline principal</h3>
                            <p class="card-summary">Tu linea de tiempo original.</p>
                            <p style="font-size:0.78rem; opacity:0.7;">${events.length} eventos</p>
                            <div style="margin-top:auto;">
                                <button class="f-button glass" onclick="event.stopPropagation(); changeView('timeline_main_detail')">ABRIR TIMELINE</button>
                            </div>
                        </div>
                        ${boards.map(b => `
                            <div class="f-card glass" onclick="store.setState({ currentView: 'timeline_board_detail', activeId: '${b.id}' })" style="position:relative; padding:2rem; display:flex; flex-direction:column; gap:10px; cursor:pointer;">
                                <div class="tool-tag" style="width:fit-content;">TIMELINE</div>
                                <h3 style="font-size:1.35rem;">${b.name || 'Timeline sin nombre'}</h3>
                                <p class="card-summary">${clipText(b.desc || 'Sin descripcion', 100)}</p>
                                <p style="font-size:0.78rem; opacity:0.7;">${(b.events || []).length} eventos</p>
                                <div style="margin-top:auto;">
                                    <button class="f-button glass" onclick="event.stopPropagation(); store.setState({ currentView: 'timeline_board_detail', activeId: '${b.id}' })">ABRIR TIMELINE</button>
                                </div>
                                ${renderActions('timelineBoards', b.id)}
                            </div>
                        `).join('')}
                        <div class="f-card glass empty-slot" onclick="changeView('crear_timeline_board')" style="cursor:pointer; min-height:240px; border:1px dashed rgba(138, 79, 255, 0.45); display:flex; align-items:center; justify-content:center;">
                            <span style="font-size:2.2rem; color:var(--accent-primary); font-weight:800;">+</span>
                        </div>
                    </div>
                </div>
            `;
        })()}
    `,

    timeline_main_detail: (s) => {
        const events = (s.timeline || []).filter(t => matchesSearch(t, s.searchQuery, [t.unitName, t.unitType, t.date]));
        return `
            <div style="display:flex; justify-content:space-between; align-items:flex-end; margin-bottom:1rem; gap:10px; flex-wrap:wrap;">
                <div>
                    <h2 style="margin:0 0 5px 0;">Timeline principal</h2>
                    <p style="margin:0; opacity:0.72; font-size:0.85rem;">Tu linea de tiempo original</p>
                </div>
                <div style="display:flex; gap:10px; flex-wrap:wrap;">
                    <button class="f-button" onclick="openTimelineEventForm()">ANADIR EVENTO</button>
                    <button class="f-button glass" onclick="changeView('timeline')">VOLVER</button>
                </div>
            </div>
            ${events.length
                ? renderTimelineShowcase(events, s.units || [])
                : '<div class="dev-msg">Esta timeline aun no tiene eventos.</div>'
            }
        `;
    },

    timeline_board_detail: (s, id) => {
        const board = (s.timelineBoards || []).find(b => String(b.id) === String(id));
        if (!board) return `<div class="glass" style="padding:4rem; text-align:center;"><h2>Timeline no encontrada.</h2><button class="f-button" onclick="changeView('timeline')">VOLVER</button></div>`;
        const events = (board.events || []).filter(t => matchesSearch(t, s.searchQuery, [t.unitName, t.unitType, t.date]));
        return `
            <div style="display:flex; justify-content:space-between; align-items:flex-end; margin-bottom:1rem; gap:10px; flex-wrap:wrap;">
                <div>
                    <h2 style="margin:0 0 5px 0;">${board.name || 'Timeline'}</h2>
                    <p style="margin:0; opacity:0.72; font-size:0.85rem;">${board.desc || 'Sin descripcion'}</p>
                </div>
                <div style="display:flex; gap:10px; flex-wrap:wrap;">
                    <button class="f-button" onclick="openTimelineEventForm('${board.id}')">ANADIR EVENTO</button>
                    <button class="f-button glass" onclick="changeView('timeline')">VOLVER</button>
                </div>
            </div>
            ${events.length
                ? renderTimelineShowcase(events, s.units || [], { boardId: board.id })
                : '<div class="dev-msg">Esta timeline aun no tiene eventos.</div>'
            }
        `;
    },

    crear_timeline_board: () => `
        <div class="glass" style="padding:4rem; border-radius:40px; max-width:800px; margin:0 auto;">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:3rem;">
                <h2>NUEVA TIMELINE</h2>
                <button class="f-button glass" onclick="changeView('timeline')">VOLVER</button>
            </div>
            <form onsubmit="handleTimelineBoardSubmit(event)">
                <input type="text" id="tlb-name" required placeholder="Nombre de la timeline..." class="f-input" style="margin-bottom:20px;">
                <textarea id="tlb-desc" class="f-input" placeholder="Descripcion..." style="height:140px; margin-bottom:20px;"></textarea>
                <button type="submit" class="f-button" style="width:100%;">CREAR TIMELINE</button>
            </form>
        </div>
    `,

    crear_timeline: (s) => `
        <div class="glass" style="padding:4rem; border-radius:40px; max-width:800px; margin:0 auto;">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:3rem;">
                <h2>CREAR EVENTO</h2>
                <button class="f-button glass" onclick="goBackFromTimelineCreate()">VOLVER</button>
            </div>
            <form onsubmit="handleTimelineSubmit(event)">
                <input type="text" id="tl-name" required placeholder="Titulo del evento..." class="f-input" style="margin-bottom:20px;">
                <input type="date" id="tl-date" class="f-input" style="margin-bottom:20px;">
                <textarea id="tl-desc" class="f-input" placeholder="Descripcion..." style="height:140px; margin-bottom:20px;"></textarea>
                <label style="display:block; font-size:0.7rem; opacity:0.6; margin-bottom:8px;">IMAGEN DEL EVENTO:</label>
                <input type="file" id="tl-image" accept="image/*" class="f-input" style="padding:10px; margin-bottom:20px;">
                <label style="display:block; font-size:0.7rem; opacity:0.6; margin-bottom:8px;">UNIDAD RELACIONADA:</label>
                <select id="tl-unit" class="f-input" style="margin-bottom:20px;">
                    <option value="">Sin unidad</option>
                    ${(s.units || []).map(u => `<option value="${u.id}">${u.type}: ${u.name || 'Sin nombre'}</option>`).join('')}
                </select>
                <button type="submit" class="f-button" style="width:100%;">GUARDAR EVENTO</button>
            </form>
        </div>
    `,
    network: (s) => `
        ${renderFolderGallery('network')}
        ${renderFolderBar('network')}
        <div class="network-layout">
            <div id="network-toolbar" class="glass" style="margin-bottom:1rem; padding:15px; display:flex; gap:15px; align-items:center; justify-content:space-between;">
                <div style="display:flex; gap:10px;">
                    <button class="f-button glass" onclick="setNetworkMode('move')" id="btn-net-move" style="background:rgba(255,255,255,0.1);">MOVER</button>
                    <button class="f-button glass" onclick="setNetworkMode('connect')" id="btn-net-conn">CONECTAR (HILO)</button>
                </div>
                <div style="display:flex; gap:10px;">
                     <button class="f-button" onclick="promptAddNetworkNode()">+ NUEVO NODO</button>
                     <button class="f-button glass" onclick="CustomDialog.confirm('Limpiar todo el mapa?').then(ok => ok && store.setState({networkNodes:[], networkConnections:[]}))" style="border-color:#ef4444; color:#ef4444;">LIMPIAR</button>
                </div>
            </div>
            
            <div id="network-canvas" class="glass" style="position:relative; height:75vh; overflow:hidden; background: radial-gradient(circle at 50% 50%, rgba(138, 79, 255, 0.05) 0%, transparent 100%); cursor:default;">
                <svg id="network-svg" style="position:absolute; top:0; left:0; width:100%; height:100%; pointer-events:none; z-index:1;"></svg>
                ${filterByFolder((s.networkNodes || []), 'network').map(n => `
                    <div class="network-node glass" 
                         data-id="${n.id}"
                         data-name="${n.name}"
                         style="position:absolute; left:${n.x}%; top:${n.y}%; padding:14px 26px; z-index:5; border-radius:18px; user-select:none; font-weight:700; border:1px solid rgba(138, 79, 255, 0.3); box-shadow: 0 8px 20px rgba(0,0,0,0.35); display:flex; align-items:center; gap:12px; min-width:190px; background:rgba(20, 20, 30, 0.84);">
                        ${n.image ? `<div style="width:36px; height:36px; border-radius:50%; background:url(${n.image}) center/cover;"></div>` : ''}
                        <div style="display:flex; flex-direction:column;">
                            <span style="font-size:1.02rem; line-height:1.1; color:#fff;">${n.name}</span>
                            <span style="font-size:0.78rem; color:var(--accent-secondary); text-transform:uppercase;">${n.type || 'NODO'}</span>
                        </div>
                        ${renderActions('network', n.id)}
                    </div>
                `).join('')}
            </div>
            <div id="network-details-panel" class="glass" style="display:none; position:absolute; left:50%; top:50%; transform:translate(-50%, -50%); width:340px; min-height:520px; padding:18px 18px 20px 18px; border-radius:42px; z-index:50; border:1px solid rgba(138,79,255,0.45); box-shadow:0 20px 40px rgba(0,0,0,0.45), 0 0 26px rgba(138,79,255,0.24); background:linear-gradient(165deg, rgba(34,36,82,0.9), rgba(24,26,58,0.94));">
                <div style="position:absolute; top:16px; right:16px; display:flex; gap:8px; z-index:3;">
                    <button id="btn-nd-edit" class="f-button glass" title="Editar" style="width:34px; height:34px; padding:0; display:flex; align-items:center; justify-content:center; border-radius:10px;"><img src="images/EDITAR.png" alt="Editar" class="action-btn-icon"></button>
                    <button id="btn-nd-delete" class="f-button glass" title="Eliminar" style="width:34px; height:34px; padding:0; display:flex; align-items:center; justify-content:center; border-radius:10px; border-color:#ef4444; color:#ef4444;">X</button>
                    <button onclick="document.getElementById('network-details-panel').style.display='none'" class="f-button glass" title="Cerrar" style="width:34px; height:34px; padding:0; display:flex; align-items:center; justify-content:center; border-radius:10px;">X</button>
                </div>
                <div id="nd-img-container" style="margin-top:22px; margin-bottom:18px; width:100%; height:235px; background:linear-gradient(135deg, #1f2846, #12162c); background-size:contain; background-repeat:no-repeat; background-position:center; border-radius:34px; border:1px solid rgba(255,255,255,0.18); display:flex; align-items:center; justify-content:center; overflow:hidden;">
                    <span id="nd-img-fallback" style="font-size:5rem; font-weight:900; opacity:0.34;">?</span>
                </div>
                <h3 id="nd-title" style="margin:0; text-align:center; font-size:2.9rem; line-height:1; font-weight:900;">0</h3>
                <p id="nd-type" style="font-size:1.45rem; color:#e9e9f7; margin:10px 0 0 0; text-align:center; font-weight:800;">NODO</p>
                <p id="nd-desc" style="font-size:1.15rem; opacity:0.88; margin:8px 0 18px 0; text-align:center; white-space: pre-wrap; width:100%; box-sizing:border-box; overflow-wrap:anywhere; word-break:break-word; max-height:116px; overflow-y:auto;">Sin descripcion.</p>
                <button id="btn-nd-open" class="f-button" style="width:100%; border-radius:18px; font-size:0.95rem; letter-spacing:2px;">VER DETALLES</button>
            </div>
            
            <div style="margin-top:10px; font-size:0.8rem; opacity:0.6; text-align:center;">
                Arrastra para mover. Usa "CONECTAR" o Mantn <strong>SHIFT</strong> y arrastra de un nodo a otro para crear un hilo.
            </div>
        </div>
    `,
    storyboard: (s) => `
        ${renderFolderGallery('storyboard')}
        ${renderFolderBar('storyboard')}
        <div class="view-header-actions"><button class="f-button" onclick="changeView('crear_storyboard')">NUEVO STORYBOARD</button></div>
        ${(() => {
            const boards = filterByFolder(
                (s.storyboard || []).filter(st => matchesSearch(st, s.searchQuery, (st.items || []).map(it => it.name))),
                'storyboard'
            );
            return `<div class="card-grid" style="grid-template-columns:repeat(4, minmax(0, 1fr));">
                ${Array.from({ length: 16 }).map((_, i) => {
                const st = boards[i];
                if (!st) {
                    return `
                            <div class="f-card glass empty-slot" onclick="changeView('crear_storyboard')" style="cursor:pointer; min-height:300px; border:1px dashed rgba(138, 79, 255, 0.45); display:flex; align-items:center; justify-content:center;">
                                <span style="font-size:2.2rem; color:var(--accent-primary); font-weight:800;">+</span>
                            </div>
                        `;
                }
                const coverBg = st.image ? `url(${st.image}) center/cover` : 'linear-gradient(135deg, rgba(138, 79, 255, 0.3), rgba(0, 210, 255, 0.3))';
                return `
                        <div class="f-card glass" style="position:relative; padding:0; overflow:hidden; display:flex; flex-direction:column; cursor:pointer;" onclick="store.setState({ currentView: 'storyboard_detalle', activeId: '${st.id}' })">
                            <div style="height:180px; background:${coverBg}; border-bottom:1px solid rgba(255,255,255,0.1);"></div>
                            <div style="padding:1.5rem;">
                                <h3 style="margin-bottom:8px;">${st.name || 'Storyboard'}</h3>
                                <p class="card-summary">${(st.items || []).length} escenas</p>
                                ${st.desc ? `<p class="card-summary">${clipText(st.desc, 90)}</p>` : ''}
                                <div style="margin-top:1.2rem; display:flex; gap:10px;">
                                    <button class="f-button glass" onclick="store.setState({ currentView: 'storyboard_detalle', activeId: '${st.id}' })">ABRIR</button>
                                </div>
                                ${renderActions('storyboard', st.id)}
                            </div>
                        </div>
                    `;
            }).join('')}
            </div>`;
        })()}
    `,
    crear_storyboard: () => `
        <div class="glass" style="padding:4rem; border-radius:40px; max-width:800px; margin:0 auto;">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:3rem;">
                <h2>NUEVO STORYBOARD</h2>
                <button class="f-button glass" onclick="changeView('storyboard')">VOLVER</button>
            </div>
            <form onsubmit="handleStoryboardSubmit(event)">
                <input type="text" id="sb-name" required placeholder="Nombre del storyboard..." class="f-input" style="margin-bottom:20px;">
                <div style="margin-bottom:20px;">
                    <label style="display:block; font-size:0.7rem; opacity:0.6; margin-bottom:8px;">PORTADA (OPCIONAL)</label>
                    <input type="file" id="sb-image" accept="image/*" class="f-input" style="padding:10px;">
                </div>
                <textarea id="sb-desc" class="f-input" placeholder="Descripcion..." style="height:120px; margin-bottom:20px;"></textarea>
                <button type="submit" class="f-button" style="width:100%;">CREAR STORYBOARD</button>
            </form>
        </div>
    `,
    storyboard_detalle: (s, id) => {
        const boardId = String(id || '');
        const board = (s.storyboard || []).find(st => String(st.id) === boardId) || { id: boardId, name: 'Storyboard', items: [] };
        const filled = board.items || [];
        const minSlots = 12;
        const slots = Math.max(minSlots, filled.length, Number(board.slotCount) || 0);
        const storyboardSlots = Array.from({ length: slots }).map((_, i) => filled[i] || null);
        return `
        <div class="glass" style="padding:2rem; border-radius:26px; max-width:1500px; margin:0 auto;">
            <div style="display:flex; justify-content:space-between; align-items:flex-end; margin-bottom:1.5rem; gap:12px; flex-wrap:wrap;">
                <div>
                    <h2 style="margin:0 0 6px 0;">${board.name}</h2>
                    <p style="margin:0; font-size:0.75rem; letter-spacing:2px; opacity:0.65;">WALL DE THUMBS â€¢ ${filled.length} ESCENAS</p>
                </div>
                <button class="f-button glass" onclick="changeView('storyboard')">VOLVER</button>
            </div>
            ${board.desc ? `<p style="opacity:0.7; margin:0 0 1.2rem 0;">${board.desc}</p>` : ''}
            <div style="display:grid; grid-template-columns:repeat(auto-fill, minmax(260px, 1fr)); gap:14px;">
                ${storyboardSlots.map((it, idx) => `
                    <div style="border:2px solid rgba(255,255,255,0.7); border-radius:4px; background:#fff; color:#111; overflow:hidden; box-shadow:0 6px 20px rgba(0,0,0,0.2); cursor:pointer;" onclick="handleStoryboardSlotClick('${boardId}', ${idx}, '${it?.id || ''}')">
                        <div style="position:relative; aspect-ratio:16/9; background:${it?.image ? `url(${it.image}) center/cover` : 'linear-gradient(180deg, #fbfbfb, #e9e9e9)'}; border-bottom:2px solid #111; display:flex; align-items:center; justify-content:center;">
                            ${it?.image ? '' : `<span style="font-weight:800; font-size:1.8rem; opacity:0.5;">+</span>`}
                            <span style="position:absolute; left:8px; top:8px; background:#111; color:#fff; border-radius:999px; padding:2px 8px; font-size:0.65rem; letter-spacing:1px;">#${idx + 1}</span>
                        </div>
                        <div style="padding:8px 10px; min-height:56px;">
                            <div style="font-weight:800; font-size:0.78rem; letter-spacing:0.3px;" contenteditable="plaintext-only" onmousedown="event.stopPropagation()" onclick="event.stopPropagation()" onkeydown="if(event.key==='Enter'){event.preventDefault(); this.blur();}" onblur="handleStoryboardInlineTextSave('${boardId}', '${it?.id || ''}', ${idx}, 'name', this.textContent)">${it?.name || 'ESCENA VACIA'}</div>
                            <div style="font-size:0.7rem; opacity:0.75; margin-top:3px;" contenteditable="plaintext-only" onmousedown="event.stopPropagation()" onclick="event.stopPropagation()" onblur="handleStoryboardInlineTextSave('${boardId}', '${it?.id || ''}', ${idx}, 'desc', this.textContent)">${it?.desc || 'Sin descripcion'}</div>
                        </div>
                        ${it ? `
                        <div style="display:flex; gap:8px; padding:0 10px 10px 10px;">
                            <button type="button" class="f-button glass" style="font-size:0.65rem; padding:7px 10px; flex:1;" onclick="event.stopPropagation(); handleStoryboardSceneEdit('${boardId}', '${it.id}')">EDITAR</button>
                            <button type="button" class="f-button glass" style="font-size:0.65rem; padding:7px 10px; border-color:#ef4444; color:#ef4444; flex:1;" onclick="event.stopPropagation(); handleStoryboardSceneDelete('${boardId}', '${it.id}')">BORRAR</button>
                        </div>
                        ` : ''}
                    </div>
                `).join('')}
            </div>
            <div style="display:flex; justify-content:center; margin-top:16px;">
                <button type="button" class="f-button glass" onclick="addStoryboardSlot('${boardId}')">+ AGREGAR CUADRO</button>
            </div>
        </div>
        `;
    },
    Colecciones: (s) => `
        ${renderFolderGallery('Colecciones')}
        ${renderFolderBar('Colecciones')}
        <div class="view-header-actions"><button class="f-button" onclick="changeView('crear_coleccion')">NUEVA COLECCION</button></div>
        <div class="card-grid">
            ${filterByFolder((s.Colecciones || []), 'Colecciones')
            .filter(c => matchesSearch(c, s.searchQuery, (c.items || []).map(i => i.name)))
            .map(c => {
                const total = (c.items || []).length;
                const checked = (c.items || []).filter(i => i.checked).length;
                const thumbs = (c.items || []).slice(0, 4).map(it => {
                    const bg = it.image ? `url(${it.image}) center/cover` : 'rgba(255,255,255,0.05)';
                    const label = it.image ? '' : (it.name ? it.name[0] : '*');
                    return `<div style="height:44px; border-radius:8px; background:${bg}; display:flex; align-items:center; justify-content:center; font-weight:800; font-size:0.7rem;">${label}</div>`;
                }).join('');
                const coverBg = c.image ? `url(${c.image}) center/cover` : 'linear-gradient(135deg, rgba(138, 79, 255, 0.3), rgba(0, 210, 255, 0.3))';

                return `
                <div class="f-card glass" style="padding:2rem; cursor:pointer;" onclick="store.setState({ currentView: 'coleccion_detalle', activeId: '${c.id}' })">
                    <div style="height:140px; border-radius:14px; margin-bottom:1rem; background:${coverBg}; background-size:cover; background-position:center; display:${c.image ? 'block' : 'grid'}; grid-template-columns:1fr 1fr; gap:8px; padding:${c.image ? '0' : '10px'};">
                        ${c.image ? '' : (thumbs || `<div style="grid-column:1/-1; display:flex; align-items:center; justify-content:center; opacity:0.6; font-size:0.8rem;">Sin elementos</div>`)}
                    </div>
                    <h3>Coleccion ${c.name || ''}</h3>
                    <p style="opacity:0.6; margin-top:10px;">${total} elementos - ${checked} con palomita</p>
                    ${c.desc ? `<p class="card-summary">${clipText(c.desc, 90)}</p>` : ''}
                    <div style="margin-top:1.2rem; display:flex; gap:10px;">
                        <button class="f-button glass" onclick="store.setState({ currentView: 'coleccion_detalle', activeId: '${c.id}' })">ABRIR</button>
                    </div>
                    ${renderActions('Colecciones', c.id)}
                </div>
            `;
            }).join('')}
        </div>
    `,
    crear_coleccion: (s) => `
        <div class="glass" style="padding:4rem; border-radius:40px; max-width:800px; margin:0 auto;">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:3rem;">
                <h2>NUEVA COLECCION</h2>
                <button class="f-button glass" onclick="changeView('Colecciones')">VOLVER</button>
            </div>
            <form onsubmit="handleColeccionSubmit(event)">
                <input type="text" id="col-name" required placeholder="Nombre de la coleccion..." class="f-input" style="margin-bottom:20px;">
                <div style="margin-bottom:20px;">
                    <label style="display:block; font-size:0.7rem; opacity:0.6; margin-bottom:10px;">IMAGEN DE PORTADA</label>
                    <p style="font-size:0.8rem; opacity:0.7;">La portada se generará automáticamente con las imágenes de los elementos.</p>
                </div>
                <textarea id="col-desc" class="f-input" placeholder="Descripcion..." style="height:120px; margin-bottom:20px;"></textarea>
                <button type="submit" class="f-button" style="width:100%;">CREAR COLECCION</button>
            </form>
        </div>
    `,

    coleccion_detalle: (s, id) => {
        const col = (s.Colecciones || []).find(c => c.id == id) || { name: 'Coleccion', items: [] };
        return `
        <div class="glass" style="padding:3rem; border-radius:40px; max-width:1400px; margin:0 auto;">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:2rem;">
                <h2>${col.name}</h2>
                <button class="f-button glass" onclick="changeView('Colecciones')">VOLVER</button>
            </div>
            ${col.desc ? `<p style="opacity:0.7; margin-bottom:2rem;">${col.desc}</p>` : ''}
            <form onsubmit="handleColeccionItemSubmit(event, '${col.id}')" style="margin-bottom:2rem; display:grid; grid-template-columns: 1fr 1fr 1fr auto; gap:15px; align-items:end;">
                <div>
                    <label style="display:block; font-size:0.7rem; opacity:0.6; margin-bottom:8px;">NOMBRE</label>
                    <input type="text" id="ci-name-${col.id}" class="f-input" placeholder="Elemento...">
                </div>
                <div>
                    <label style="display:block; font-size:0.7rem; opacity:0.6; margin-bottom:8px;">FOTO</label>
                    <input type="file" id="ci-image-${col.id}" accept="image/*" class="f-input" style="padding:10px;">
                </div>
                <label style="display:flex; align-items:center; gap:10px; font-size:0.8rem;">
                    <input type="checkbox" id="ci-check-${col.id}"> Con palomita
                </label>
                <button type="submit" class="f-button">AGREGAR</button>
            </form>
            <!-- Grid View -->
            <div class="collection-grid">
                ${(col.items || []).map(it => `
                    <div class="collection-item-card ${it.checked ? 'checked' : ''}" onclick="toggleColeccionItem('${col.id}', '${it.id}')" data-item-id="${it.id}">
                        <div class="collection-item-image" style="background:${it.image ? `url(${it.image}) center/cover` : 'linear-gradient(135deg, rgba(138, 79, 255, 0.2), rgba(0, 210, 255, 0.2))'};"></div>
                        <div class="collection-item-overlay">
                            <div class="collection-checkmark">
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
                                    <polyline points="20 6 9 17 4 12"></polyline>
                                </svg>
                            </div>
                        </div>
                        <div class="collection-item-info">
                            <h4>${it.name || 'Elemento'}</h4>
                            <button class="collection-edit-btn" title="Editar" onclick="event.stopPropagation(); handleColeccionItemEdit('${col.id}', '${it.id}')">
                                <img src="images/EDITAR.png" alt="Editar" class="action-btn-icon">
                            </button>
                        </div>
                    </div>
                `).join('')}
                ${((col.items || []).length === 0) ? '<div class="dev-msg" style="grid-column:1/-1;">Aun no hay elementos. Agrega tu primer elemento arriba.</div>' : ''}
            </div>
        </div>
        `;
    },
    tiers: (s) => `
        ${renderFolderGallery('tiers')}
        ${renderFolderBar('tiers')}
        <div class="view-header-actions"><button class="f-button" onclick="changeView('crear_tier')">NUEVA JERARQUIA</button></div>
        <div class="card-grid">
            ${filterByFolder((s.tiers || []), 'tiers')
            .filter(t => matchesSearch(t, s.searchQuery, t.items || []))
            .map(t => `
                <div class="f-card glass iceberg-card" style="padding:2rem; cursor:pointer;" onclick="changeView('tier_detail'); store.setState({activeId: '${t.id}'})">
                    <div style="height:140px; background:${t.image ? `url(${t.image}) center/cover` : 'rgba(255,255,255,0.05)'}; border-radius:14px; margin-bottom:1rem;"></div>
                    <h3>* ${t.name}</h3>
                    <p class="card-summary">${(t.rows || []).length} Filas - ${(t.pool || []).length} Elementos</p>
                    <div style="margin-top:1rem; display:flex; gap:10px;">
                        <button class="f-button glass" onclick="event.stopPropagation(); changeView('tier_detail'); store.setState({activeId: '${t.id}'})">ABRIR</button>
                    </div>
                    ${renderActions('tiers', t.id)}
                </div>
            `).join('')}
        </div>
    `,
    tier_detail: (s, id) => {
        const tier = (s.tiers || []).find(t => t.id == id);
        const tierMode = tier?.viewMode === 'iceberg' ? 'iceberg' : 'tier';
        if (!tier) return `<div class="glass" style="padding:4rem; text-align:center;"><h2>No se encontró el Tier List.</h2><button class="f-button" onclick="changeView('tiers')">VOLVER</button></div>`;

        // Define default rows
        const defaultRows = buildDefaultTierRows();

        // Ensure rows exist and are not empty
        let rows = (tier.rows && tier.rows.length > 0) ? tier.rows : defaultRows;

        // Handle migration of old "items" (list of strings) to pool if pool is empty
        let pool = tier.pool || [];
        if (pool.length === 0 && tier.items && tier.items.length > 0) {
            pool = tier.items.map((it, idx) => ({
                id: 'migrated_' + Date.now() + '_' + idx,
                name: (typeof it === 'string') ? it : (it.name || 'Elemento'),
                image: (typeof it === 'string') ? null : (it.image || null)
            }));
        }

        return `
            <div class="glass" style="padding:2.5rem; border-radius:40px; max-width:1400px; margin:0 auto; animation: fadeIn 0.4s ease-out;">
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:2.5rem;">
                    <div>
                        <span class="tool-tag" style="margin-bottom:10px;">TIER LIST EDITOR</span>
                        <h2 style="font-size:2.5rem; color:var(--text-primary);">${tier.name}</h2>
                    </div>
                    <button class="f-button glass" onclick="changeView('tiers')">VOLVER AL LISTADO</button>
                </div>
                
                <div style="display:flex; justify-content:space-between; align-items:center; gap:12px; margin-bottom:12px; flex-wrap:wrap;">
                    <div style="display:flex; align-items:center; gap:10px;">
                        <h3 style="font-size:1rem; opacity:0.85; letter-spacing:1px;">FILAS</h3>
                        <div class="tier-mode-switch">
                            <button class="f-button ${tierMode === 'tier' ? '' : 'glass'}" style="padding:8px 14px; font-size:0.7rem;" onclick="setTierMode('${tier.id}', 'tier')">TIER</button>
                            <button class="f-button ${tierMode === 'iceberg' ? '' : 'glass'}" style="padding:8px 14px; font-size:0.7rem;" onclick="setTierMode('${tier.id}', 'iceberg')">ICEBERG</button>
                        </div>
                    </div>
                    <button class="f-button glass" style="padding:10px 16px; font-size:0.72rem;" onclick="promptAddTierRow('${tier.id}')">+ ANADIR FILA</button>
                </div>
                <div class="tier-list-container ${tierMode === 'iceberg' ? 'iceberg-mode' : ''}" ${tierMode === 'iceberg' ? `style="background-image:url('images/iceberg.jpg');"` : ''} ${tierMode === 'iceberg' ? `onmousemove="handleIcebergPointer(event)" onmouseleave="resetIcebergPointer(event)"` : ''}>
                    ${rows.map((row, rowIndex) => `
                        <div class="tier-row" style="margin-bottom:8px; ${tierMode === 'iceberg' ? `background:linear-gradient(135deg, rgba(10,24,44, ${Math.min(0.01 + rowIndex * 0.006, 0.05)}), rgba(10,34,58, ${Math.min(0.008 + rowIndex * 0.005, 0.04)})); border-color: rgba(126, 196, 255, 0.06);` : ''}" ondragover="handleTierDragOver(event)" ondrop="handleTierDrop(event, '${tier.id}', '${row.id}')">
                            <div class="tier-label ${row.color || 'tier-f'}" ondblclick="editTierRowLabel('${tier.id}', '${row.id}')" title="Doble clic para editar texto" style="position:relative; ${tierMode === 'iceberg' ? `background:linear-gradient(180deg, rgb(${Math.max(155 - rowIndex * 12, 30)}, ${Math.max(220 - rowIndex * 20, 70)}, ${Math.max(255 - rowIndex * 22, 110)}), rgb(${Math.max(95 - rowIndex * 10, 18)}, ${Math.max(170 - rowIndex * 18, 48)}, ${Math.max(222 - rowIndex * 20, 90)})); color:${rowIndex >= 3 ? '#eaf7ff' : '#0c2e4a'};` : ''}">
                                <span>${row.label || '...'}</span>
                                <button onclick="(function(e){e.stopPropagation();e.preventDefault();promptAddTierTextItem('${tier.id}','${row.id}');})(event)" title="Agregar texto" style="position:absolute; bottom:6px; right:6px; width:18px; height:18px; border:none; border-radius:5px; background:rgba(255,255,255,0.35); color:#111; font-size:11px; font-weight:900; line-height:1; display:flex; align-items:center; justify-content:center; cursor:pointer;">T</button>
                                <button onclick="(function(e){e.stopPropagation();e.preventDefault();deleteTierRow('${tier.id}','${row.id}');})(event)" title="Eliminar fila" style="position:absolute; top:6px; right:6px; width:18px; height:18px; border:none; border-radius:5px; background:rgba(0,0,0,0.22); color:#111; font-size:11px; font-weight:900; line-height:1; display:flex; align-items:center; justify-content:center; cursor:pointer;">x</button>
                            </div>
                            <div class="tier-content">
                                  ${(row.items || []).map(item => {
            const isTextItem = item.kind === 'text';
            const hasImg = !isTextItem && item.image && !item.image.includes('placeholder.com');
            const style = hasImg ? `background-image: url('${item.image}');` : '';
            const showChar = (item.name || '').match(/[A-Za-z]/);
            return (isTextItem || hasImg || showChar) ? `
                                        <div class="tier-item ${isTextItem ? 'tier-text-item' : (!hasImg ? 'no-img' : '')}" 
                                            draggable="true" 
                                            ondragstart="handleTierDragStart(event, '${tier.id}', '${row.id}', '${item.id}')" 
                                            ondragend="this.classList.remove('dragging'); handleTierDragEnd()" 
                                            style="${style}" 
                                            title="${item.name}">
                                            ${isTextItem ? `<span>${String(item.name || 'Texto').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</span>` : (!hasImg ? (showChar ? `<span>${(item.name || '?').charAt(0).toUpperCase()}</span>` : '') : '')}
                                            <button onclick="(function(e){e.stopPropagation();e.preventDefault();deleteTierItem('${tier.id}','${row.id}','${item.id}');})(event)" style="position:absolute; top:6px; right:6px; width:22px; height:22px; border-radius:6px; background:rgba(239,68,68,0.14); color:#fff; display:flex; align-items:center; justify-content:center; font-size:12px; z-index:20; border:1px solid rgba(239,68,68,0.4);">âœ•</button>
                                        </div>
                                     ` : '';
        }).join('')}
                            </div>
                        </div>
                    `).join('')}
                </div>

                <div class="pool-container" style="margin-top:3rem; padding:2rem; background:rgba(255,255,255,0.02); border-radius:24px;">
                    <div class="pool-header" style="display:flex; justify-content:space-between; align-items:center; margin-bottom:2rem;">
                        <h3 style="font-size:1.1rem; opacity:0.8; letter-spacing:1px;">ðŸ“¦ ELEMENTOS DISPONIBLES</h3>
                        <button class="f-button" style="padding:10px 20px; font-size:0.75rem;" onclick="promptAddTierItem('${tier.id}')">+ ANADIR ELEMENTO</button>
                    </div>
                    <div class="pool-content" ondragover="handleTierDragOver(event)" ondrop="handleTierDrop(event, '${tier.id}', 'pool')" style="min-height:120px; display:flex; flex-wrap:wrap; gap:15px;">
                                ${pool.map(item => {
            const hasImg = item.image && !item.image.includes('placeholder.com');
            const style = hasImg ? `background-image: url('${item.image}');` : '';
            const showChar = (item.name || '').match(/[A-Za-z]/);
            return (hasImg || showChar) ? `
                                        <div class="tier-item ${!hasImg ? 'no-img' : ''}" 
                                             draggable="true" 
                                             ondragstart="handleTierDragStart(event, '${tier.id}', 'pool', '${item.id}')" 
                                             ondragend="this.classList.remove('dragging'); handleTierDragEnd()" 
                                             style="${style}; pointer-events: auto;" 
                                             title="${item.name}">
                                                 ${!hasImg ? (showChar ? `<span>${(item.name || '?').charAt(0).toUpperCase()}</span>` : '') : ''}
                                                 <button onclick="(function(e){e.stopPropagation();e.preventDefault();deleteTierItem('${tier.id}','pool','${item.id}');})(event)" style="position:absolute; top:6px; right:6px; width:22px; height:22px; border-radius:6px; background:rgba(239,68,68,0.14); color:#fff; display:flex; align-items:center; justify-content:center; font-size:12px; z-index:20; border:1px solid rgba(239,68,68,0.4);">âœ•</button>
                                        </div>
                                    ` : '';
        }).join('')}
                        ${pool.length === 0 ? '<div style="width:100%; text-align:center; padding:2rem; opacity:0.4; border:1px dashed rgba(255,255,255,0.1); border-radius:15px;">El pool está vacío. Añade elementos para empezar a clasificarlos.</div>' : ''}
                    </div>
                </div>
            </div>
        `;
    },

    crear_tier: () => `
        <div class="glass" style="padding:4rem; border-radius:40px; max-width:800px; margin:0 auto;">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:3rem;">
                <h2>NUEVO ICEBERG</h2>
                <button class="f-button glass" onclick="changeView('tiers')">VOLVER</button>
            </div>
            <form onsubmit="handleTierSubmit(event)">
                <input type="text" id="tier-name" required placeholder="Nombre del iceberg..." class="f-input" style="margin-bottom:20px;">
                <div style="margin-bottom:20px;">
                    <label style="display:block; font-size:0.7rem; opacity:0.6; margin-bottom:10px;">MODO:</label>
                    <input type="hidden" id="tier-view-mode" value="tier">
                    <div class="tier-mode-switch">
                        <button type="button" id="create-mode-tier" class="f-button create-tier-mode-btn active" style="padding:10px 16px; font-size:0.72rem;" onclick="setCreateTierMode('tier')">TIER</button>
                        <button type="button" id="create-mode-iceberg" class="f-button glass create-tier-mode-btn" style="padding:10px 16px; font-size:0.72rem;" onclick="setCreateTierMode('iceberg')">ICEBERG</button>
                    </div>
                </div>
                <textarea id="tier-items" class="f-input" placeholder="Escribe una lista, una linea por elemento..." style="height:180px; margin-bottom:20px;"></textarea>
                <div style="margin-bottom:20px;">
                    <label style="display:block; font-size:0.7rem; opacity:0.6; margin-bottom:10px;">IMAGEN/PORTADA (opcional):</label>
                    <input type="file" id="tier-image" accept="image/*" class="f-input" style="padding:10px;">
                </div>
                <button type="submit" class="f-button" style="width:100%;">GUARDAR</button>
            </form>
        </div>
    `,
    map_detail: (s, id) => {
        const m = (s.mapas || []).find(i => i.id == id) || { name: 'Desconocido', pins: [], image: '' };
        const tool = s.mapTool || { type: 'cursor', color: '#00d2ff', size: 26, label: '', icon: '*', image: null, arrowDir: 'right' };
        const viewport = mapViewportById[String(id)] || { scale: 1, tx: 0, ty: 0 };
        const mapTransform = `translate(${viewport.tx}px, ${viewport.ty}px) scale(${viewport.scale})`;
        const mapCursor = tool.type === 'cursor' ? 'grab' : 'crosshair';
        const renderPin = (p) => {
            const label = p.label ? `<span class="map-label">${p.label}</span>` : '';
            const style = `left:${p.x}%; top:${p.y}%; --marker-color:${p.color || '#00d2ff'}; --marker-size:${p.size || 26}px;`;
            if (p.type === 'image' && p.image) {
                return `<div class="map-marker map-image" data-pin-id="${p.id}" style="${style}"><img src="${p.image}" alt="icon">${label}<button class="map-marker-remove" onclick="removeMapPin(event, '${id}', '${p.id}')" title="Eliminar marcador">X</button></div>`;
            }
            if (p.type === 'image') return '';
            if (p.type === 'circle') {
                return `<div class="map-marker map-circle" data-pin-id="${p.id}" style="${style}">${label}<button class="map-marker-remove" onclick="removeMapPin(event, '${id}', '${p.id}')" title="Eliminar marcador">X</button></div>`;
            }
            if (p.type === 'arrow') {
                const length = Number(p.arrowLength) || 44;
                const angle = Number(p.arrowAngle) || 0;
                return `<div class="map-marker map-arrow-line" data-pin-id="${p.id}" style="${style}">
                    <div class="map-arrow-visual" style="width:${length}px; transform: rotate(${angle}deg);">
                        <span class="map-arrow-line-seg"></span>
                        <span class="map-arrow-head-glyph">></span>
                    </div>
                    ${label}
                    <button class="map-marker-remove" onclick="removeMapPin(event, '${id}', '${p.id}')" title="Eliminar marcador">X</button>
                </div>`;
            }
            return `<div class="map-marker map-pin" data-pin-id="${p.id}" style="${style}">${p.icon || 'PIN'}${label}<button class="map-marker-remove" onclick="removeMapPin(event, '${id}', '${p.id}')" title="Eliminar marcador">X</button></div>`;
        };
        return `
        <div class="glass" style="padding:2rem;">
            <div style="display:flex; justify-content:center; align-items:center; gap:20px; margin-bottom:1rem; position:relative;">
                <h2 style="text-align:center;">${m.name.toUpperCase()}</h2>
                <button class="f-button glass" style="position:absolute; right:0;" onclick="changeView('mapas')">X</button>
            </div>
            <div class="map-toolbar">
                <button type="button" class="f-button map-cursor-standalone ${tool.type === 'cursor' ? '' : 'glass'}" onclick="setMapToolType('cursor')" title="Cursor">
                    <svg class="map-cursor-svg" viewBox="0 0 24 24" aria-hidden="true">
                        <path d="M3 2L3 20L8.7 15.1L12 22L14.6 20.7L11.2 13.9L19 13.9Z"></path>
                    </svg>
                </button>
                <div class="map-tool-types">
                    <button type="button" class="f-button map-type-btn ${tool.type === 'pin' ? '' : 'glass'}" onclick="setMapToolType('pin')">Pin</button>
                    <button type="button" class="f-button map-type-btn ${tool.type === 'circle' ? '' : 'glass'}" onclick="setMapToolType('circle')">Circulo</button>
                    <button type="button" class="f-button map-type-btn ${tool.type === 'arrow' ? '' : 'glass'}" onclick="setMapToolType('arrow')">Flecha</button>
                    <button type="button" class="f-button map-type-btn ${tool.type === 'image' ? '' : 'glass'}" onclick="setMapToolType('image')">Imagen</button>
                </div>
                <div class="map-tool-meta">
                    <div class="map-tool-meta-top">
                        <input type="text" id="map-tool-label" value="${tool.label || ''}" class="f-input" placeholder="Etiqueta" onchange="setMapTool('label', this.value)">
                        ${tool.type === 'pin'
                ? `<input type="text" id="map-tool-icon" value="${tool.icon || ''}" class="f-input" placeholder="Pin" maxlength="3" oninput="setMapTool('icon', this.value)">`
                : `<div id="map-tool-icon-preview" class="f-input map-tool-icon-preview">${tool.type === 'cursor' ? 'ðŸ–±ï¸' : (tool.type === 'circle' ? 'â—¯' : (tool.type === 'arrow' ? 'âž¤' : (tool.type === 'image' ? 'ðŸ–¼' : 'â€¢')))}</div>`}
                    </div>
                    <input type="range" id="map-tool-size" min="14" max="60" value="${tool.size || 26}" class="f-input" onchange="setMapTool('size', this.value)">
                    <span class="map-tool-size-label">Tamaño del elemento</span>
                </div>
                ${tool.type === 'arrow' ? `<select id="map-tool-arrow-dir" class="f-input" style="max-width:180px;" onchange="setMapTool('arrowDir', this.value)">
                    <option value="right" ${tool.arrowDir === 'right' ? 'selected' : ''}>Flecha derecha</option>
                    <option value="left" ${tool.arrowDir === 'left' ? 'selected' : ''}>Flecha izquierda</option>
                    <option value="up" ${tool.arrowDir === 'up' ? 'selected' : ''}>Flecha arriba</option>
                    <option value="down" ${tool.arrowDir === 'down' ? 'selected' : ''}>Flecha abajo</option>
                </select>` : ''}
                ${tool.type === 'image' ? `<input type="file" id="map-tool-image" accept="image/*" class="f-input" style="padding:10px; max-width:260px;" onchange="handleMapIconUpload(event)">` : ''}
                ${tool.type === 'image' && tool.image ? `<img src="${tool.image}" alt="preview" style="width:30px; height:30px; border-radius:6px; object-fit:cover; border:1px solid rgba(255,255,255,0.2);">` : ''}
                <button type="button" class="f-button glass" style="border-color:#ef4444; color:#ef4444;" onclick="clearMapPins('${id}')">LIMPIAR TODO</button>
            </div>
            <div id="map-world-${id}" style="height:70vh; cursor:${mapCursor}; position:relative; overflow:hidden;" onclick="handleMapClick(event, ${id})" onmousedown="handleMapPointerDown(event, ${id})" onmousemove="handleMapPointerMove(event, ${id})" onmouseup="handleMapPointerUp(event, ${id})" onmouseleave="handleMapPointerUp(event, ${id})">
                <div id="map-canvas-${id}" class="map-canvas" style="position:absolute; inset:0; background:url(${m.image}) center/contain no-repeat; transform-origin:0 0; transform:${mapTransform};">
                    ${(m.pins || []).map(renderPin).join('')}
                </div>
                <div class="map-zoom-controls">
                    <button type="button" class="map-zoom-btn" onclick="zoomMap(event, ${id}, 1)">+</button>
                    <button type="button" class="map-zoom-btn" onclick="zoomMap(event, ${id}, -1)">-</button>
                </div>
            </div>
        </div>`;
    },
    ficha_detalle: (s, id) => {
        const char = (s.units || []).find(u => u.id == id) || { name: '---', fields: [] };
        return `<div class="glass" style="padding:4rem;"><button class="f-button glass" onclick="changeView('personajes')">VOLVER</button><div style="display:flex; gap:40px; margin-top:3rem;"><div style="width:250px; height:250px; background:url(${char.image}) center/cover; border-radius:30px;"></div><div style="flex:1;"><h1>${char.name.toUpperCase()}</h1><div id="custom-fields-container">${(char.fields || []).map(f => `<div class="f-card glass" style="margin-bottom:10px;">${f.label}: ${f.value}</div>`).join('')}</div><button class="f-button" onclick="addField(${id})">+ DATO</button></div></div></div>`;
    },
    editar_unit: (s, id) => {
        const item = (s.units || []).find(u => u.id == id);
        if (!item) return `<div>No encontrado</div>`;
        const label = item.type.toUpperCase();
        return `
            <div class="glass" style="padding:4rem; border-radius:40px; max-width:800px; margin:0 auto;">
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:3rem;">
                    <h2>EDITAR ${label}</h2>
                    <button class="f-button glass" onclick="changeView('${item.type === 'Personaje' ? 'personajes' : (item.type === 'Lugar' ? 'lugares' : 'inventario')}')">VOLVER</button>
                </div>
                <form onsubmit="handleDedicatedEditSubmit(event, '${id}')">
                    <input type="text" id="de-name" required value="${item.name}" placeholder="Nombre..." class="f-input" style="margin-bottom:20px;">
                    <div style="margin-bottom:20px;">
                        <label style="display:block; font-size:0.7rem; opacity:0.6; margin-bottom:10px;">CAMBIAR IMAGEN (Opcional):</label>
                        <input type="file" id="de-image" accept="image/*" class="f-input" style="padding:10px;">
                    </div>
                    <textarea id="de-desc" class="f-input" placeholder="Descripcion..." style="height:120px; margin-bottom:20px;">${item.desc || ''}</textarea>
                    <div class="field-block">
                        <label style="display:block; font-size:0.7rem; opacity:0.6; margin-bottom:10px;">DATOS EXTRA:</label>
                        <div class="field-rows">
                            ${(item.fields && item.fields.length > 0) ? item.fields.map(f => `
                                <div class="field-row">
                                    <input type="text" class="f-input field-label" value="${f.label}" placeholder="Campo (ej. Edad)">
                                    <input type="text" class="f-input field-value" value="${f.value}" placeholder="Valor">
                                    <button type="button" class="f-button glass field-remove" onclick="this.closest('.field-row').remove()">X</button>
                                </div>
                            `).join('') : `
                                <div class="field-row">
                                    <input type="text" class="f-input field-label" placeholder="Campo (ej. Edad)">
                                    <input type="text" class="f-input field-value" placeholder="Valor">
                                    <button type="button" class="f-button glass field-remove" onclick="this.closest('.field-row').remove()">X</button>
                                </div>
                            `}
                        </div>
                        <button type="button" class="f-button glass" onclick="addFieldRow(this)">+ CAMPO</button>
                    </div>
                    <button type="submit" class="f-button" style="width:100%;">GUARDAR CAMBIOS</button>
                </form>
            </div>
        `;
    },
    // --- NEW SECTIONS FROM SKETCH ---
    trivia: (s) => {
        const items = s.trivia || [];
        if (!items.length) {
            triviaSession.index = 0;
            return `
                <div class="view-header-actions">
                    <button class="f-button" onclick="changeView('crear_trivia')">+ NUEVA TRIVIA</button>
                </div>
                <div class="dev-msg">No hay trivias todavia. Crea una para poner a prueba a tus lectores!</div>
            `;
        }

        if (triviaSession.index >= items.length || triviaSession.index < 0) {
            triviaSession.index = 0;
        }

        const t = items[triviaSession.index];
        const total = items.length;
        const current = triviaSession.index + 1;
        const tvImage = 'images/TRIVIA.jpg';
        const shouldPlayStatic = !!triviaSession.playStatic;
        triviaSession.playStatic = false;

        return `
            <style>
                .trivia-stage {
                    display: grid;
                    gap: 1.2rem;
                }
                .trivia-tv-shell {
                    position: relative;
                    max-width: 1100px;
                    width: 100%;
                    margin: 0 auto;
                    aspect-ratio: 1 / 1;
                    overflow: hidden;
                    --tv-screen-left: 25.95%;
                    --tv-screen-top: 20.35%;
                    --tv-screen-width: 48.2%;
                    --tv-screen-height: 28.05%;
                    --tv-screen-shift-x: 37px;
                    --tv-screen-shift-y: 18px;
                    --tv-screen-grow-w: -33px;
                    --tv-screen-grow-h: -16px;
                }
                .trivia-tv-art {
                    position: absolute;
                    inset: 0;
                    width: 100%;
                    height: 100%;
                    object-fit: cover;
                }
                .trivia-tv-backdrop {
                    position: absolute;
                    inset: 0;
                    background: linear-gradient(180deg, rgba(10, 3, 20, 0.22) 0%, rgba(10, 3, 20, 0.12) 100%);
                }
                .trivia-tv-frame {
                    position: absolute;
                    z-index: 3;
                    left: calc(var(--tv-screen-left) + var(--tv-screen-shift-x));
                    top: calc(var(--tv-screen-top) + var(--tv-screen-shift-y));
                    width: calc(var(--tv-screen-width) + var(--tv-screen-grow-w));
                    height: calc(var(--tv-screen-height) + var(--tv-screen-grow-h));
                    border-radius: 0.25%;
                    padding: 0;
                    border: none;
                    background: transparent;
                    box-shadow: none;
                }
                .trivia-tv-screen {
                    position: relative;
                    border-radius: 0.2%;
                    padding: clamp(0.28rem, 0.6vw, 0.55rem);
                    height: 100%;
                    border: 1px solid rgba(82, 92, 132, 0.38);
                    background: linear-gradient(160deg, rgba(20, 18, 44, 0.72), rgba(11, 10, 24, 0.76));
                    display: grid;
                    gap: 0.35rem;
                    align-content: start;
                    overflow: hidden;
                }
                .trivia-tv-scanline {
                    position: absolute;
                    inset: 0;
                    background-image: repeating-linear-gradient(0deg, rgba(255, 255, 255, 0.05) 0, rgba(255, 255, 255, 0.05) 1px, transparent 2px, transparent 5px);
                    opacity: 0.24;
                    pointer-events: none;
                }
                .trivia-tv-static {
                    position: absolute;
                    inset: 0;
                    opacity: 0;
                    pointer-events: none;
                    background:
                        repeating-radial-gradient(circle at 20% 30%, rgba(255, 255, 255, 0.22) 0 1px, transparent 1px 2px),
                        repeating-radial-gradient(circle at 75% 70%, rgba(255, 255, 255, 0.2) 0 1px, transparent 1px 2px),
                        linear-gradient(180deg, rgba(255, 255, 255, 0.2), rgba(255, 255, 255, 0.02));
                    mix-blend-mode: screen;
                }
                .trivia-tv-static.play {
                    animation: trivia-static-flicker ${TRIVIA_STATIC_MS}ms steps(14, end) 1;
                }
                .trivia-tv-hud {
                    display: flex;
                    justify-content: space-between;
                    gap: 6px;
                    align-items: center;
                    font-size: clamp(0.5rem, 0.78vw, 0.74rem);
                    letter-spacing: 1px;
                    color: rgba(240, 244, 255, 0.88);
                    font-weight: 800;
                    text-transform: uppercase;
                }
                .trivia-tv-question {
                    margin: 0;
                    font-size: clamp(0.82rem, 1.35vw, 1.24rem);
                    line-height: 1.14;
                    font-weight: 900;
                    color: #f6f8ff;
                    text-shadow: 0 2px 8px rgba(0, 0, 0, 0.45);
                }
                .trivia-tv-options {
                    display: grid;
                    gap: 0.45rem;
                }
                .trivia-tv-options button {
                    width: 100%;
                    text-align: left;
                    border-radius: 10px;
                    padding: 4px 8px;
                    font-size: clamp(0.62rem, 0.95vw, 0.9rem);
                    border: 1px solid rgba(170, 188, 255, 0.42);
                    background: linear-gradient(135deg, rgba(120, 72, 245, 0.17), rgba(16, 128, 180, 0.12));
                    color: #f6f8ff;
                    cursor: pointer;
                    transition: transform 0.2s ease, filter 0.2s ease;
                }
                .trivia-tv-options button.is-correct {
                    border-color: rgba(34, 197, 94, 0.9);
                    background: linear-gradient(135deg, rgba(34, 197, 94, 0.38), rgba(34, 197, 94, 0.2));
                    color: #eafff1;
                }
                .trivia-tv-options button.is-wrong {
                    border-color: rgba(239, 68, 68, 0.9);
                    background: linear-gradient(135deg, rgba(239, 68, 68, 0.38), rgba(239, 68, 68, 0.2));
                    color: #ffecec;
                }
                .trivia-tv-options button:hover {
                    transform: translateY(-1px);
                    filter: brightness(1.12);
                }
                .trivia-tv-options button:disabled {
                    opacity: 0.65;
                    cursor: default;
                    transform: none;
                }
                .trivia-tv-feedback {
                    min-height: 14px;
                    font-size: clamp(0.54rem, 0.8vw, 0.74rem);
                    font-weight: 700;
                    letter-spacing: 0.2px;
                    color: rgba(218, 225, 255, 0.84);
                    text-align: center;
                }
                .trivia-tv-answer-icon {
                    min-height: 30px;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                }
                .trivia-tv-answer-icon img {
                    display: none;
                    width: clamp(20px, 3vw, 34px);
                    height: clamp(20px, 3vw, 34px);
                    object-fit: contain;
                    filter: drop-shadow(0 2px 5px rgba(0, 0, 0, 0.35));
                }
                .trivia-tv-answer-icon img.show {
                    display: block;
                }
                .trivia-tv-feedback.ok {
                    color: #72f4c8;
                }
                .trivia-tv-feedback.fail {
                    color: #ff8f8f;
                }
                @media (max-width: 900px) {
                    .trivia-tv-frame {
                        left: calc(var(--tv-screen-left) + var(--tv-screen-shift-x));
                        top: calc(var(--tv-screen-top) + var(--tv-screen-shift-y));
                        width: calc(var(--tv-screen-width) + var(--tv-screen-grow-w));
                        height: calc(var(--tv-screen-height) + var(--tv-screen-grow-h));
                    }
                    .trivia-tv-screen {
                        padding: 0.45rem;
                    }
                    .trivia-tv-hud {
                        font-size: 0.52rem;
                    }
                }
                @keyframes trivia-static-flicker {
                    0% { opacity: 0.92; transform: translateX(0); }
                    25% { opacity: 0.82; transform: translateX(-1px); }
                    50% { opacity: 0.62; transform: translateX(1px); }
                    75% { opacity: 0.45; transform: translateX(-1px); }
                    100% { opacity: 0; transform: translateX(0); }
                }
            </style>
            <div class="view-header-actions">
                <button class="f-button" onclick="changeView('crear_trivia')">+ NUEVA TRIVIA</button>
                <div style="display:flex; gap:8px;">
                    <button class="f-button glass" onclick="prevTriviaQuestion()">ANTERIOR</button>
                    <button class="f-button glass" onclick="nextTriviaQuestion()">SIGUIENTE</button>
                </div>
            </div>
            <div class="trivia-stage" data-trivia-id="${t.id}">
                <div class="trivia-tv-shell">
                    <img class="trivia-tv-art" src="${tvImage}" alt="Trivia TV">
                    <div class="trivia-tv-backdrop"></div>
                    <div class="trivia-tv-frame">
                        <div class="trivia-tv-screen" data-correct="${t.correct}">
                            <div class="trivia-tv-static ${shouldPlayStatic ? 'play' : ''}"></div>
                            <div class="trivia-tv-scanline"></div>
                            <div class="trivia-tv-hud">
                                <span>TRIVIA EN VIVO</span>
                                <span>PREGUNTA ${current} / ${total}</span>
                            </div>
                            <h3 class="trivia-tv-question">${t.question}</h3>
                            <div class="trivia-tv-options">
                                ${t.options.map((o, i) => `
                                    <button data-choice="${String.fromCharCode(65 + i)}" onclick="handleTriviaOption('${t.id}', '${String.fromCharCode(65 + i)}', this)">${String.fromCharCode(65 + i)}) ${o}</button>
                                `).join('')}
                            </div>
                            <div class="trivia-tv-answer-icon">
                                <img id="trivia-answer-icon" alt="Resultado">
                            </div>
                            <div class="trivia-tv-feedback" id="trivia-feedback">Selecciona una opcion para continuar.</div>
                        </div>
                    </div>
                </div>
                <div style="position:relative;">
                    ${renderActionsNoFolder('trivia', t.id)}
                </div>
            </div>
        `;
    },
    crear_trivia: () => `
        <div class="glass" style="padding:4rem; border-radius:40px; max-width:800px; margin:0 auto;">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:3rem;">
                <h2>DISE'AR TRIVIA</h2>
                <button class="f-button glass" onclick="changeView('trivia')">VOLVER</button>
            </div>
            <form onsubmit="handleTriviaSubmit(event)">
                <input type="text" id="tr-question" required placeholder="Escribe la pregunta..." class="f-input" style="margin-bottom:20px;">
                <div style="display:grid; grid-template-columns: 1fr 1fr; gap:10px; margin-bottom:20px;">
                    <input type="text" id="tr-o1" required placeholder="Opcin A" class="f-input">
                    <input type="text" id="tr-o2" required placeholder="Opcin B" class="f-input">
                    <input type="text" id="tr-o3" required placeholder="Opcin C" class="f-input">
                    <input type="text" id="tr-o4" required placeholder="Opcin D" class="f-input">
                </div>
                <input type="text" id="tr-correct" required placeholder="Respuesta correcta (e.g. Opcin B)" class="f-input" style="margin-bottom:20px;">
                <button type="submit" class="f-button" style="width:100%; background:linear-gradient(135deg, var(--accent-primary), var(--accent-secondary));">FORJAR DESAFO</button>
            </form>
        </div>
    `,
    merch: (s) => `
        <div class="view-header-actions" style="display:flex; align-items:center; justify-content:space-between; gap:12px;">
            <div style="font-size:0.9rem; opacity:0.7;">Productos oficiales disponibles</div>
            ${s.isSuperadmin ? '<button class="f-button" onclick="merchAddItem()">+ Agregar producto</button>' : ''}
        </div>
        <div class="card-grid">
            ${(s.merch || []).map(p => `
                <div class="f-card glass product-card" style="padding:1.5rem;">
                    <div style="height:220px; background:url(${p.image_url || p.image || 'images/iconos/MERCH2.png'}) center/cover; border-radius:15px; margin-bottom:1rem; border:1px solid rgba(255,255,255,0.05);"></div>
                    ${s.isSuperadmin ? `
                        <div style="display:grid; grid-template-columns:1fr 120px; gap:10px; margin-bottom:10px;">
                            <input class="f-input" value="${escapeHtml(p.name || '')}" placeholder="Nombre"
                                oninput="merchUpdateField('${p.id}', 'name', this.value)">
                            <input class="f-input" value="${escapeHtml(p.price || '')}" placeholder="Precio"
                                oninput="merchUpdateField('${p.id}', 'price', this.value)">
                        </div>
                        <input class="f-input" value="${escapeHtml(p.image_url || p.image || '')}" placeholder="Imagen URL"
                            oninput="merchUpdateField('${p.id}', 'image_url', this.value)" style="margin-bottom:10px;">
                        <input type="file" class="f-input" accept="image/*" onchange="merchUploadImage('${p.id}', this)" style="margin-bottom:10px;">
                        <textarea class="f-input" style="min-height:70px; margin-bottom:10px;" placeholder="Descripcion"
                            oninput="merchUpdateField('${p.id}', 'desc', this.value)">${escapeHtml(p.description || p.desc || '')}</textarea>
                        <button class="f-button" style="width:100%; margin-bottom:10px;" onclick="merchSaveProduct('${p.id}')">Guardar producto</button>
                        <button class="f-button glass" style="width:100%; border-color:#ef4444; color:#ef4444;" onclick="merchRemoveItem('${p.id}')">Eliminar producto</button>
                    ` : `
                        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:1rem;">
                            <h3 style="font-size:1.2rem;">${p.name}</h3>
                            <span style="font-weight:900; color:var(--accent-secondary); font-size:1.1rem;">$${p.price || '19.99'}</span>
                        </div>
                        <p style="font-size:0.8rem; opacity:0.6; margin-bottom:1.5rem;">${p.desc || 'Producto oficial de Narrativa.'}</p>
                        <button class="f-button" style="width:100%;" onclick="CustomDialog.confirm('Anadido al carrito con xito')">ADQUIRIR YA</button>
                    `}
                </div>
            `).join('')}
            ${(s.merch || []).length === 0 ? '<div class="dev-msg">Tu tienda de Merch esta vacia. Anade productos de tus historias!</div>' : ''}
        </div>
    `,
    admin: (s) => {
        if (!s.isSuperadmin) {
            return `<div class="glass" style="padding:3rem; text-align:center;">Acceso denegado.</div>`;
        }

        const users = adminCache.users || [];
        const selected = adminCache.selectedUser;
        const state = adminCache.state || {};
        const counts = {
            proyectos: Array.isArray(state.proyectos) ? state.proyectos.length : 0,
            units: Array.isArray(state.units) ? state.units.length : 0,
            timeline: Array.isArray(state.timeline) ? state.timeline.length : 0,
            mapas: Array.isArray(state.mapas) ? state.mapas.length : 0,
            storyboard: Array.isArray(state.storyboard) ? state.storyboard.length : 0,
            publicaciones: Array.isArray(state.publicaciones) ? state.publicaciones.length : 0
        };
        const countsHtml = Object.keys(counts).map((k) => `
            <div class="glass" style="padding:10px 12px; border-radius:12px; text-align:center; min-width:110px;">
                <div style="font-size:0.7rem; opacity:0.7;">${k.toUpperCase()}</div>
                <div style="font-size:1.2rem; font-weight:800;">${counts[k]}</div>
            </div>
        `).join('');

        const usersHtml = adminCache.loadingUsers
            ? `<div class="dev-msg">Cargando usuarios...</div>`
            : users.map((u) => `
                <button class="f-button glass" style="width:100%; margin-bottom:8px; text-align:left; ${adminCache.selectedUserId == u.id ? 'border-color:var(--accent-secondary); color:var(--accent-secondary);' : ''}"
                    onclick="adminSelectUser('${u.id}')">
                    <div style="font-weight:800;">${escapeHtml(u.username || 'Sin nombre')}</div>
                    <div style="font-size:0.7rem; opacity:0.7;">${escapeHtml(u.email || '')}</div>
                    <div style="font-size:0.65rem; opacity:0.6;">ROLE: ${escapeHtml(u.role || 'user')}</div>
                </button>
            `).join('') || `<div class="dev-msg">Sin usuarios.</div>`;

        return `
            <div class="glass" style="padding:2rem; border-radius:30px;">
                <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:1.5rem;">
                    <div>
                        <h2 style="margin:0;">Panel Admin</h2>
                        <div style="font-size:0.8rem; opacity:0.7;">Gestiona usuarios, roles y datos</div>
                    </div>
                    <div style="display:flex; gap:10px;">
                        <button class="f-button glass" onclick="adminRefreshUsers()">Recargar usuarios</button>
                    </div>
                </div>
                ${adminCache.error ? `<div class="dev-msg" style="color:#fca5a5;">${escapeHtml(adminCache.error)}</div>` : ''}
                <div style="display:grid; grid-template-columns:260px 1fr; gap:20px;">
                    <div>
                        <div style="margin-bottom:10px; font-size:0.8rem; opacity:0.7;">Usuarios</div>
                        ${usersHtml}
                    </div>
                    <div>
                        ${selected ? `
                            <div class="glass" style="padding:1rem 1.2rem; border-radius:16px; margin-bottom:1rem;">
                                <div style="display:flex; justify-content:space-between; align-items:center; gap:10px;">
                                    <div>
                                        <div style="font-size:0.9rem; opacity:0.7;">Usuario seleccionado</div>
                                        <div style="font-weight:800; font-size:1.1rem;">${escapeHtml(selected.username || '')}</div>
                                        <div style="font-size:0.75rem; opacity:0.65;">${escapeHtml(selected.email || '')}</div>
                                    </div>
                                    <div>
                                        <select id="admin-role-select" class="f-input" style="min-width:160px;">
                                            <option value="user" ${String(selected.role || '').toLowerCase() === 'user' ? 'selected' : ''}>user</option>
                                            <option value="admin" ${String(selected.role || '').toLowerCase() === 'admin' ? 'selected' : ''}>admin</option>
                                            <option value="superadmin" ${String(selected.role || '').toLowerCase() === 'superadmin' ? 'selected' : ''}>superadmin</option>
                                            <option value="main" ${String(selected.role || '').toLowerCase() === 'main' ? 'selected' : ''}>main</option>
                                        </select>
                                        <button class="f-button" style="margin-top:8px; width:100%;" onclick="adminSetUserRole()">Guardar rol</button>
                                    </div>
                                </div>
                            </div>
                            <div style="display:flex; gap:10px; flex-wrap:wrap; margin-bottom:1rem;">
                                ${countsHtml}
                            </div>
                            <div class="glass" style="padding:1rem 1.2rem; border-radius:16px;">
                                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px;">
                                    <div>
                                        <div style="font-size:0.8rem; opacity:0.7;">Estado completo (JSON)</div>
                                        <div style="font-size:0.7rem; opacity:0.6;">Edita con cuidado</div>
                                    </div>
                                    <button class="f-button" onclick="adminSaveStateJson()">Guardar estado</button>
                                </div>
                                <textarea id="admin-state-json" class="f-input" style="min-height:260px; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace;"
                                    oninput="adminUpdateStateJson(this.value)">${escapeHtml(adminCache.stateJsonDraft || '{}')}</textarea>
                            </div>
                        ` : `<div class="dev-msg">Selecciona un usuario para ver sus datos.</div>`}
                    </div>
                </div>
            </div>
        `;
    },
    publicaciones: (s) => {
        const pubs = s._communityPubs || [];
        const myUserId = s._myUserId || null;
        const visiblePubs = pubs.filter(o => matchesSearch(o, s.searchQuery, [o.title, o.author, o.genre, o.description]));
        const myPubs = visiblePubs.filter(o => String(o.user_id) === String(myUserId));
        const libraryPubs = visiblePubs.slice(0, 12);
        const continueReading = visiblePubs
            .map((o) => ({ ...o, _progress: getPublicationProgress(o.id) }))
            .filter((o) => o._progress > 0)
            .sort((a, b) => Number(b._progress || 0) - Number(a._progress || 0))
            .slice(0, 3);
        const latestDrafts = myPubs
            .filter((o) => !o.content || String(o.content).trim().length < 350)
            .slice(0, 3);

        const progressBar = (pubId) => {
            const pct = getPublicationProgress(pubId);
            return `
                <div class="pub-progress-wrap" aria-label="Porcentaje leido ${pct}%">
                    <div class="pub-progress-bar">
                        <span style="width:${pct}%"></span>
                    </div>
                    <small>${pct}% leido</small>
                </div>
            `;
        };

        const ownerActions = (pub) => String(pub.user_id) === String(myUserId) ? `
            <div class="pub-owner-actions">
                <button onclick="event.stopPropagation(); openEditCommunityPub(${pub.id})" title="Editar">E</button>
                <button onclick="event.stopPropagation(); deleteCommunityPub(${pub.id})" title="Eliminar">X</button>
            </div>
        ` : '';

        const renderBookCard = (pub) => `
            <article class="pub-book-card" onclick="openObraDetalle(${pub.id})" title="${pub.title || ''}">
                <div class="pub-book-cover" style="background:${pub.cover_url ? `url(${pub.cover_url}) center/cover` : 'linear-gradient(145deg, rgba(138,79,255,0.5), rgba(0,210,255,0.28))'};">
                    ${ownerActions(pub)}
                </div>
                ${progressBar(pub.id)}
                <h4>${pub.title || 'Sin titulo'}</h4>
                <p>${pub.author || 'Anonimo'}</p>
            </article>
        `;

        return `
        <section class="pub-library-shell">
            <div class="pub-library-left">
                <div class="pub-library-head">
                    <div>
                        <h2>Mi Biblioteca</h2>
                        <p>Obras de la herramienta Publicar</p>
                    </div>
                    <button class="pub-chip-btn" onclick="startNewPublication()">+ Nuevo proyecto</button>
                </div>

                <div id="pub-loading" class="pub-loading" style="display:${pubs.length === 0 && !s._pubsLoaded ? 'block' : 'none'};">Cargando publicaciones...</div>

                <div class="pub-books-grid">
                    ${libraryPubs.map(renderBookCard).join('')}
                </div>

                ${libraryPubs.length === 0 && s._pubsLoaded ? '<div class="dev-msg">No hay libros para mostrar.</div>' : ''}

                <div class="pub-inline-section">
                    <h3>Continuar leyendo</h3>
                    <div class="pub-continue-row">
                        ${continueReading.map((pub) => `
                            <button class="pub-continue-item" onclick="openObraDetalle(${pub.id})">
                                <div class="thumb" style="background:${pub.cover_url ? `url(${pub.cover_url}) center/cover` : 'linear-gradient(145deg, rgba(138,79,255,0.45), rgba(0,210,255,0.24))'};"></div>
                                <div class="meta">
                                    <strong>${pub.title || 'Sin titulo'}</strong>
                                    <span>${pub._progress}% leido</span>
                                </div>
                            </button>
                        `).join('')}
                        ${continueReading.length === 0 ? '<div class="pub-empty-inline">Aun no tienes lectura en progreso.</div>' : ''}
                    </div>
                </div>
            </div>

            <aside class="pub-library-right glass">
                <div class="pub-right-block">
                    <p class="pub-right-eyebrow">Panel de Publicación</p>
                    <h3>Publica tu obra</h3>
                    <button class="f-button" style="width:100%;" onclick="startNewPublication()">Nuevo proyecto</button>
                </div>

                <div class="pub-right-block">
                    <h4>Mis borradores</h4>
                    ${latestDrafts.map((d) => `
                        <button class="pub-side-card" onclick="openEditCommunityPub(${d.id})">
                            <div class="meta">
                                <strong>${d.title || 'Sin titulo'}</strong>
                                <span>Editar borrador</span>
                            </div>
                            <span class="arrow">></span>
                        </button>
                    `).join('')}
                    ${latestDrafts.length === 0 ? '<div class="pub-side-empty">No hay borradores detectados.</div>' : ''}
                </div>

                <div class="pub-right-block">
                    <h4>Libros publicados</h4>
                    ${myPubs.slice(0, 3).map((d) => `
                        <button class="pub-side-card" onclick="openObraDetalle(${d.id})">
                            <div class="meta">
                                <strong>${d.title || 'Sin titulo'}</strong>
                                <span>${Number(d.rating_count || 0)} lecturas/calificaciones</span>
                            </div>
                            <span class="arrow">></span>
                        </button>
                    `).join('')}
                    ${myPubs.length === 0 ? '<div class="pub-side-empty">Aun no publicas obras propias.</div>' : ''}
                </div>

                <div class="pub-right-block">
                    <h4>Crear nueva historia</h4>
                    <label>Titulo</label>
                    <input class="f-input" type="text" readonly value="Shadows of the Moon">
                    <label>Genero</label>
                    <input class="f-input" type="text" readonly value="Fantasía">
                    <button class="f-button glass pub-upload-btn" onclick="startNewPublication()">Subir DOCX/EPUB</button>
                    <button class="f-button glass pub-upload-btn" onclick="startNewPublication()">Subir imagen</button>
                </div>
            </aside>
        </section>
    `;
    },
    obra_detalle: (s) => {
        const pub = s._detallePub || null;
        if (!pub) return `<div class="glass" style="padding:4rem; text-align:center;"><h2>Cargando...</h2></div>`;
        const myRating = s._myPubRating || 0;
        const myUserId = s._myUserId || null;
        const isOwner = String(pub.user_id) === String(myUserId);
        const renderStarsInteractive = (current, pubId) =>
            [1, 2, 3, 4, 5].map(i =>
                `<button onclick="rateCommunityPub(${pubId},${i})" title="${i} estrella${i > 1 ? 's' : ''}" style="background:none; border:none; cursor:pointer; font-size:1.6rem; color:${i <= current ? '#f59e0b' : 'rgba(100,80,40,0.3)'}; transition:color 0.2s; padding:2px;">&#9733;</button>`
            ).join('');
        const paragrafs = (pub.content || '').split('\n').filter(Boolean)
            .map(p => `<p>${p}</p>`).join('');
        const wordCount = (pub.content || '').split(/\s+/).filter(Boolean).length;
        const readMins = Math.max(1, Math.round(wordCount / 230));

        return `
        <style>
            .kindle-wrap { --k-bg: #f5f0e8; --k-text: #2c1e0f; --k-border: #d4c5a9; --k-accent: #8b5e3c; --k-size: 18px; position:relative; overflow:hidden; min-height:100vh; display:flex; flex-direction:column; }
            .kindle-wrap.dark { --k-bg: #1a1208; --k-text: #d4c5a9; --k-border: #3a2e1e; --k-accent: #c4965a; }
            .kindle-wrap.white { --k-bg: #ffffff; --k-text: #111111; --k-border: #ddd; --k-accent: #555; }
            .kindle-topbar { position:sticky; top:0; z-index:50; background:var(--k-bg); border-bottom:1px solid var(--k-border); padding:10px 20px; display:flex; align-items:center; gap:12px; }
            
            .book-viewport { flex:1; overflow:hidden; position:relative; padding:20px; display:flex; justify-content:center; align-items:flex-start; }
            .book-container { 
                width: 1000px; max-width: 95vw; height: 75vh; 
                background: var(--k-bg); color: var(--k-text); 
                font-family: 'Georgia', serif; font-size: var(--k-size); 
                line-height: 1.8; overflow-x: auto; overflow-y: hidden; position: relative;
                box-shadow: 0 10px 40px rgba(0,0,0,0.15); border-radius: 8px; border: 1px solid var(--k-border);
                scroll-behavior: smooth;
                scrollbar-width: none; -ms-overflow-style: none;
            }
            .book-container::-webkit-scrollbar { display: none; }
            .book-columns {
                height: 100%; column-width: 410px; column-gap: 60px; column-fill: auto;
                padding: 50px 60px; text-align: justify;
            }
            .book-columns p { margin: 0 0 1.25em 0; text-indent: 1.5em; break-inside: avoid; column-break-inside: avoid; }
            .book-columns p:first-of-type { text-indent: 0; }
            .book-columns > div { break-inside: avoid; column-break-inside: avoid; }
            
            .nav-btn { 
                position: absolute; top: 50%; transform: translateY(-50%); z-index: 100;
                background: rgba(0,0,0,0.05); border: 1px solid var(--k-border); color: var(--k-accent); opacity: 0.3;
                width: 60px; height: 120px; display: flex; align-items: center; justify-content: center;
                cursor: pointer; transition: 0.3s; font-size: 2.5rem; border-radius: 8px;
            }
            .nav-btn:hover { background: rgba(0,0,0,0.1); opacity: 1; transform: translateY(-50%) scale(1.05); }
            .nav-prev { left: 15px; }
            .nav-next { right: 15px; }
            
            .kindle-footer { 
                background:var(--k-bg); border-top:1px solid var(--k-border); padding:10px 20px; 
                display:flex; justify-content:space-between; align-items:center; font-size:0.75rem; color:var(--k-accent);
            }
            @media (max-width: 800px) { .book-columns { column-count: 1; padding: 30px; } }
            
            .book-title-page { break-after: column; text-align: center; display: flex; flex-direction: column; justify-content: center; height: 100%; }
            .book-divider { height: 1px; background: var(--k-border); margin: 30px 0; }
        </style>
        
        <div class="kindle-wrap" id="kindle-wrap">
            <div class="kindle-topbar">
                    <button class="kb-btn" onclick="changeView('publicaciones')">&larr; Biblioteca</button>
                <div style="flex:1; text-align:center; font-size:0.85rem; font-style:italic;">${pub.title}</div>
                <div style="display:flex; gap:6px;">
                    ${isOwner ? `<button class="kb-btn" onclick="openEditCommunityPub(${pub.id})">Editar</button>` : ''}
                    <button class="kb-btn" onclick="kindleFontSize(-2)">A-</button>
                    <button class="kb-btn" onclick="kindleFontSize(2)">A+</button>
                    <button class="kb-btn" onclick="kindleTheme('sepia')">S</button>
                    <button class="kb-btn" onclick="kindleTheme('dark')">N</button>
                    <button class="kb-btn" onclick="kindleTheme('white')">B</button>
                </div>
            </div>
            
            <div class="book-viewport">
                <div class="nav-btn nav-prev" onclick="kindlePageFlip(-1)">&lsaquo;</div>
                <div class="nav-btn nav-next" onclick="kindlePageFlip(1)">&rsaquo;</div>
                
                <div class="book-container" data-pub-id="${pub.id}">
                    <div class="book-columns" id="book-columns">
                        <div class="book-title-page">
                            ${pub.cover_url ? `<img src="${pub.cover_url}" style="max-height:220px; border-radius:4px; margin-bottom:20px; align-self:center; box-shadow:0 10px 20px rgba(0,0,0,0.1);">` : ''}
                            <h2 style="font-size:2rem; margin:0 0 10px 0;">${pub.title}</h2>
                            <div style="text-transform:uppercase; letter-spacing:2px; color:var(--k-accent); font-size:0.9rem;">${pub.author}</div>
                            <div class="book-divider"></div>
                            ${pub.genre ? `<div style="font-size:0.8rem; margin-bottom:10px;">GÉNERO: ${pub.genre}</div>` : ''}
                            <div style="font-size:0.75rem; opacity:0.6;">${wordCount} palabras &bull; ~${readMins} min</div>
                            ${pub.description ? `<p style="margin-top:20px; font-style:italic; font-size:0.85rem; text-indent:0;">${pub.description}</p>` : ''}
                        </div>
                        ${paragrafs}
                        <div style="break-before: column; padding: 40px; text-align: center;">
                            <div class="book-divider"></div>
                            <div style="font-size:0.9rem; margin-bottom:20px;">FIN DE LA OBRA</div>
                            <div style="margin-bottom:10px; font-size:0.8rem; color:var(--k-accent);">CALIFICA ESTA HISTORIA</div>
                            <div>${renderStarsInteractive(myRating, pub.id)}</div>
                        </div>
                    </div>
                </div>
            </div>
            
            <div class="kindle-footer">
                <div>Página <span id="k-page-num">1</span></div>
                <div id="k-page-total">Cargando...</div>
            </div>
        </div>
        `;
    },
    publicar_obra: (s) => {
        const myUserId = s._myUserId || null;
        const candidate = s._pubEditing || null;
        const editing = candidate && String(candidate.user_id) === String(myUserId) ? candidate : null;
        const esc = (v) => String(v || '')
            .replace(/&/g, '&amp;')
            .replace(/"/g, '&quot;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
        return `
        <div class="glass" style="padding:4rem; border-radius:40px; max-width:800px; margin:0 auto;">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:2.5rem;">
                <h2>${editing ? 'EDITAR OBRA' : 'PUBLICAR NUEVA OBRA'}</h2>
                <button class="f-button glass" onclick="changeView('publicaciones')">VOLVER</button>
            </div>
            <form onsubmit="handlePublicacionSubmit(event)">
                <input type="hidden" id="pub-edit-id" value="${editing ? Number(editing.id) : 0}">
                <input type="hidden" id="pub-existing-cover" value="${editing ? esc(editing.cover_url || '') : ''}">
                <label style="display:block; font-size:0.72rem; opacity:0.6; margin-bottom:6px;">TÍTULO *</label>
                <input type="text" id="pub-title" required placeholder="El nombre de tu obra..." class="f-input" style="margin-bottom:20px;" value="${editing ? esc(editing.title) : ''}">
                <label style="display:block; font-size:0.72rem; opacity:0.6; margin-bottom:6px;">AUTOR / SEUDÓNIMO</label>
                <input type="text" id="pub-author" placeholder="Tu nombre o seudónimo..." class="f-input" style="margin-bottom:20px;" value="${editing ? esc(editing.author) : ''}">
                <label style="display:block; font-size:0.72rem; opacity:0.6; margin-bottom:6px;">GÉNERO</label>
                <select id="pub-genre" class="f-input" style="margin-bottom:20px;">
                    <option value="" ${editing && !editing.genre ? 'selected' : ''}>Sin género</option>
                    <option value="Fantasía" ${editing && editing.genre === 'Fantasía' ? 'selected' : ''}>Fantasía</option>
                    <option value="Ciencia Ficción" ${editing && editing.genre === 'Ciencia Ficción' ? 'selected' : ''}>Ciencia Ficción</option>
                    <option value="Romance" ${editing && editing.genre === 'Romance' ? 'selected' : ''}>Romance</option>
                    <option value="Terror" ${editing && editing.genre === 'Terror' ? 'selected' : ''}>Terror</option>
                    <option value="Aventura" ${editing && editing.genre === 'Aventura' ? 'selected' : ''}>Aventura</option>
                    <option value="Misterio" ${editing && editing.genre === 'Misterio' ? 'selected' : ''}>Misterio</option>
                    <option value="Drama" ${editing && editing.genre === 'Drama' ? 'selected' : ''}>Drama</option>
                    <option value="Poesía" ${editing && editing.genre === 'Poesía' ? 'selected' : ''}>Poesía</option>
                    <option value="Histórica" ${editing && editing.genre === 'Histórica' ? 'selected' : ''}>Histórica</option>
                    <option value="Otro" ${editing && editing.genre === 'Otro' ? 'selected' : ''}>Otro</option>
                </select>
                <label style="display:block; font-size:0.72rem; opacity:0.6; margin-bottom:6px;">SINOPSIS</label>
                <textarea id="pub-desc" class="f-input" placeholder="Breve descripción de la obra..." style="height:100px; margin-bottom:20px;">${editing ? esc(editing.description) : ''}</textarea>
                <label style="display:block; font-size:0.72rem; opacity:0.6; margin-bottom:6px;">CONTENIDO *</label>
                <textarea id="pub-content" required class="f-input" placeholder="Escribe tu historia aquí..." style="height:300px; margin-bottom:20px;">${editing ? esc(editing.content) : ''}</textarea>
                <label style="display:block; font-size:0.72rem; opacity:0.6; margin-bottom:6px;">IMAGEN DE PORTADA (opcional)</label>
                <div style="margin-bottom:28px;">
                    <input type="file" id="pub-cover" accept="image/*" class="f-input" style="padding:12px; margin-bottom:10px;" onchange="previewPubCover(this)">
                    <div id="pub-cover-preview" style="display:${editing && editing.cover_url ? 'block' : 'none'}; width:100%; height:180px; border-radius:14px; background:${editing && editing.cover_url ? `url(${editing.cover_url}) center/cover` : 'center/cover'}; border:1px solid rgba(255,255,255,0.12); margin-top:8px;"></div>
                </div>
                <div id="pub-status" style="display:none; margin-bottom:16px; padding:12px; border-radius:12px;"></div>
                <button type="submit" class="f-button" style="width:100%;" id="pub-submit-btn">${editing ? 'GUARDAR CAMBIOS' : 'PUBLICAR EN LA BIBLIOTECA'}</button>
            </form>
        </div>
    `;
    },
    indautor: () => `
        <div class="glass" style="padding:4rem 3rem; border-radius:38px; text-align:center; max-width:1100px; margin:0 auto;">
            <div style="font-size:4.2rem; margin-bottom:1.2rem;">INDAUTOR</div>
            <h1 style="font-size:2.8rem; font-weight:900; background:linear-gradient(135deg, #fff, var(--accent-secondary)); -webkit-background-clip:text; -webkit-text-fill-color:transparent;">Registro de obra con gestion integral</h1>
            <p style="font-size:1rem; color:var(--text-secondary); line-height:1.7; margin:1.2rem auto 2rem; max-width:900px;">
                Tramitamos tu registro de derechos de autor ante INDAUTOR. El cliente cubre dos conceptos: el <strong>pago oficial de INDAUTOR</strong> y nuestros <strong>honorarios de gestion</strong> por acompanamiento completo del expediente.
            </p>
            <div class="glass" style="padding:1.3rem 1.6rem; border-radius:18px; max-width:920px; margin:0 auto 1.6rem; text-align:left;">
                <h3 style="margin-bottom:0.8rem;">Requisitos base para registrar obra (INDAUTOR)</h3>
                <ul style="margin-left:1.2rem; display:grid; gap:8px; font-size:0.9rem; color:var(--text-secondary);">
                    <li>Solicitud de registro de obra (formato RPDA) debidamente llenada y firmada.</li>
                    <li>Dos ejemplares de la obra (o un ejemplar en casos especificos como fotografia/arte aplicado).</li>
                    <li>Documento que acredite personalidad del representante legal o mandatario (si aplica).</li>
                    <li>Documento de cesion de derechos, coautoria o titularidad compartida (si aplica).</li>
                    <li>Pago de derechos federales del tramite (lo gestiona nuestro equipo).</li>
                    <li>Traduccion al espanol de anexos en otro idioma (si aplica).</li>
                </ul>
            </div>
            <div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap:14px; margin:0 auto 1.8rem; max-width:920px;">
                <div class="f-card glass" style="padding:1.3rem; border:1px dashed var(--accent-primary);">
                    <h3 style="margin-bottom:0.6rem;">PAGO OFICIAL</h3>
                    <p style="font-size:0.8rem; opacity:0.72;">Derechos oficiales de INDAUTOR: incluidos en el servicio integral (sin desglose en esta vista).</p>
                </div>
                <div class="f-card glass" style="padding:1.3rem; border:1px dashed var(--accent-secondary);">
                    <h3 style="margin-bottom:0.6rem;">NUESTRO SERVICIO</h3>
                    <p style="font-size:0.8rem; opacity:0.72;">Gestion integral del tramite: revision, armado de expediente, envio y seguimiento.</p>
                </div>
                <div class="f-card glass" style="padding:1.3rem; border:1px dashed var(--accent-primary);">
                    <h3 style="margin-bottom:0.6rem;">PAQUETE INTEGRAL</h3>
                    <p style="font-size:0.8rem; opacity:0.72;">Costo fijo del servicio completo: <strong>$2,867 MXN</strong>.</p>
                </div>
            </div>
            <div style="max-width:860px; margin:0 auto;">
                <form id="indautor-form" onsubmit="handleIndautorSubmit(event)" class="glass" style="padding:2rem; border-radius:22px; text-align:left;">
                    <h3 style="margin-bottom:1.1rem; text-align:center;">INICIAR TRAMITE INDAUTOR</h3>
                    <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px; margin-bottom:12px;">
                        <input type="text" id="indautor-nombre" class="f-input" placeholder="Nombre completo*" required>
                        <input type="text" id="indautor-telefono" class="f-input" placeholder="Telefono / WhatsApp*" required>
                    </div>
                    <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px; margin-bottom:12px;">
                        <input type="email" id="indautor-email" class="f-input" placeholder="Correo*" required>
                        <input type="text" id="indautor-ciudad" class="f-input" placeholder="Ciudad" value="Guadalajara">
                    </div>
                    <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px; margin-bottom:12px;">
                        <select id="indautor-tipo-obra" class="f-input">
                            <option value="Literaria">Obra literaria</option>
                            <option value="Musical">Obra musical</option>
                            <option value="Audiovisual">Obra audiovisual</option>
                            <option value="Software">Programa de computo</option>
                            <option value="Artes visuales">Artes visuales</option>
                            <option value="Otra">Otra</option>
                        </select>
                        <input type="text" id="indautor-obra" class="f-input" placeholder="Titulo de la obra*" required>
                    </div>
                    <div class="glass" style="padding:12px; border-radius:14px; margin-bottom:12px;">
                        <div style="display:grid; grid-template-columns:1fr 1fr 1fr; gap:12px;">
                            <div>
                                <label style="display:block; font-size:0.72rem; opacity:0.8; margin-bottom:5px;">Pago oficial INDAUTOR (fijo)</label>
                                <div id="indautor-costo-gob-txt" class="f-input" style="display:flex; align-items:center; min-height:42px;">Incluido en paquete</div>
                            </div>
                            <div>
                                <label style="display:block; font-size:0.72rem; opacity:0.8; margin-bottom:5px;">Honorarios de gestion (fijo)</label>
                                <div id="indautor-honorarios-txt" class="f-input" style="display:flex; align-items:center; min-height:42px;">Incluido en paquete</div>
                            </div>
                            <div>
                                <label style="display:block; font-size:0.72rem; opacity:0.8; margin-bottom:5px;">Total estimado (fijo)</label>
                                <div id="indautor-total-txt" class="f-input" style="display:flex; align-items:center; min-height:42px; font-weight:800;">$2,867 MXN</div>
                            </div>
                        </div>
                    </div>
                    <div class="glass" style="padding:12px; border-radius:14px; margin-bottom:12px;">
                        <div style="display:grid; grid-template-columns:1fr auto; gap:12px; align-items:end;">
                            <div>
                                <label style="display:block; font-size:0.72rem; opacity:0.8; margin-bottom:5px;">Pago de honorarios</label>
                                <div class="f-input" style="display:flex; align-items:center; min-height:42px;">PayPal (obligatorio antes de enviar solicitud)</div>
                                <p id="indautor-pay-status" style="margin:6px 0 0 0; font-size:0.74rem; opacity:0.78;">Estado: pendiente de pago.</p>
                                <input type="hidden" id="indautor-paid" value="0">
                                <input type="hidden" id="indautor-pay-ref" value="">
                            </div>
                            <div style="display:flex; gap:8px; flex-wrap:wrap;">
                                <button type="button" id="indautor-pay-btn" class="f-button glass" onclick="payIndautorWithPaypal()">1) PAGAR EN PAYPAL</button>
                            </div>
                        </div>
                    </div>
                    <div style="margin:6px 0 10px 0; font-size:0.8rem; opacity:0.82;">Adjunta lo que ya tengas del expediente:</div>
                    <div style="display:grid; grid-template-columns:1fr 1fr; gap:10px; margin-bottom:12px;">
                        <div>
                            <label style="display:block; font-size:0.7rem; opacity:0.75; margin-bottom:5px;">Solicitud RPDA / formato llenado</label>
                            <input type="file" id="indautor-file-solicitud" class="f-input" accept=".pdf,image/*">
                        </div>
                        <div>
                            <label style="display:block; font-size:0.7rem; opacity:0.75; margin-bottom:5px;">Ejemplar(es) de la obra</label>
                            <input type="file" id="indautor-file-obra" class="f-input" accept=".pdf,image/*,.zip,.doc,.docx">
                        </div>
                        <div>
                            <label style="display:block; font-size:0.7rem; opacity:0.75; margin-bottom:5px;">Identificacion / personalidad juridica</label>
                            <input type="file" id="indautor-file-id" class="f-input" accept=".pdf,image/*">
                        </div>
                        <div>
                            <label style="display:block; font-size:0.7rem; opacity:0.75; margin-bottom:5px;">Carta poder / representacion (si aplica)</label>
                            <input type="file" id="indautor-file-poder" class="f-input" accept=".pdf,image/*">
                        </div>
                    </div>
                    <textarea id="indautor-notas" class="f-input" placeholder="Comentarios, fechas objetivo o dudas..." style="height:105px; margin-bottom:12px;"></textarea>
                    <label style="display:flex; align-items:center; gap:10px; font-size:0.8rem; opacity:0.9; margin-bottom:14px;">
                        <input type="checkbox" id="indautor-acepta-costo" required> Acepto el costo fijo: pago INDAUTOR + honorarios de gestion.
                    </label>
                    <button type="submit" id="indautor-submit-btn" class="f-button" style="width:100%; opacity:0.6; cursor:not-allowed;" disabled>2) ENVIAR SOLICITUD</button>
                </form>
            </div>
            <p style="margin-top:1.2rem; font-size:0.74rem; opacity:0.56;">Los montos oficiales pueden actualizarse; se validan antes de generar la linea de captura.</p>
        </div>
    `,
    impi: () => routes.indautor(),
    servicios: () => `
        <div class="glass" style="padding:5rem; border-radius:40px; text-align:center; max-width:900px; margin:0 auto;">
            <h2 style="font-size:2.5rem; margin-bottom:1.5rem;">Servicios</h2>
            <p style="font-size:1.1rem; color:var(--text-secondary);">Seccion en construccion.</p>
        </div>
    `,
    expo: () => `
        <div class="glass" style="padding:5rem; border-radius:40px; text-align:center; max-width:900px; margin:0 auto;">
            <h2 style="font-size:2.5rem; margin-bottom:1.5rem;">Expo</h2>
            <p style="font-size:1.1rem; color:var(--text-secondary);">Seccion en construccion.</p>
        </div>
    `
};


window.handleEditClick = (e, key, id) => {
    if (e) e.stopPropagation();
    const s = store.getState();
    const item = (s[key] || []).find(i => i.id == id);
    if (!item) return;
    if (key === 'proyectos' || key === 'mapas') {
        openModal(key === 'proyectos' ? 'Proyecto' : 'Mapa', id);
        return;
    }
    if (key === 'units') {
        store.setState({ currentView: 'editar_unit', activeId: id, activeType: item.type });
        return;
    }
    if (key === 'timeline') {
        CustomDialog.promptWithFile('Editar Evento:', item.name || '').then(async (res) => {
            if (res === false) return;
            const next = {};
            if (typeof res.value === 'string' && res.value.trim()) next.name = res.value.trim();
            if (res.file) next.image = await readFileAsDataURL(res.file);
            if (Object.keys(next).length) store.updateItem('timeline', id, next);
        });
        return;
    }
    if (key === 'timelineBoards') {
        CustomDialog.prompt('Editar nombre de timeline:', item.name || '').then(name => {
            if (name === false) return;
            CustomDialog.prompt('Descripcion:', item.desc || '').then(desc => {
                if (desc === false) return;
                store.updateItem('timelineBoards', id, { name: String(name || '').trim(), desc: String(desc || '').trim() });
            });
        });
        return;
    }
    if (key === 'storyboard') {
        handleStoryboardEditClick(id);
        return;
    }
    if (key === 'trivia') {
        const q = item.question || '';
        const opts = (item.options || []).join(' | ');
        CustomDialog.prompt('Editar pregunta:', q).then(question => {
            if (question === false) return;
            CustomDialog.prompt('Opciones (separa con |):', opts).then(optText => {
                if (optText === false) return;
                const options = optText.split('|').map(o => o.trim()).filter(Boolean);
                if (options.length < 2) {
                    CustomDialog.confirm('Debes incluir al menos 2 opciones.');
                    return;
                }
                const letters = options.map((_, i) => String.fromCharCode(65 + i));
                const currentCorrect = item.correct || '';
                const defaultCorrect = letters.find(l => currentCorrect.includes(l)) || letters[0];
                CustomDialog.prompt(`Respuesta correcta (${letters.join(', ')}):`, defaultCorrect).then(correctLetter => {
                    if (correctLetter === false) return;
                    const cl = String(correctLetter || '').trim().toUpperCase();
                    const finalCorrect = letters.includes(cl) ? `Opcion ${cl}` : `Opcion ${defaultCorrect}`;
                    store.updateItem('trivia', id, { question, options, correct: finalCorrect });
                });
            });
        });
        return;
    }
    if (key === 'tiers') {
        CustomDialog.promptWithFile('Editar Iceberg:', item.name).then(async (res) => {
            if (res === false) return;
            const next = {};
            if (typeof res.value === 'string' && res.value.trim()) next.name = res.value.trim();
            if (res.file) next.image = await readFileAsDataURL(res.file);
            if (Object.keys(next).length) store.updateItem('tiers', id, next);
        });
        return;
    }
    if (key === 'genealogy') {
        CustomDialog.prompt('Editar nombre del arbol:', item.name || '').then(name => {
            if (name === false) return;
            CustomDialog.prompt('Descripcion del arbol:', item.desc || '').then(desc => {
                if (desc === false) return;
                store.updateItem('genealogy', id, { name, desc });
            });
        });
        return;
    }
    if (key === 'Colecciones') {
        CustomDialog.promptWithFile('Editar Coleccion (nombre):', item.name).then(async (res) => {
            if (res === false) return;
            const next = {};
            if (typeof res.value === 'string' && res.value.trim()) next.name = res.value.trim();
            if (res.file) next.image = await readFileAsDataURL(res.file);
            CustomDialog.prompt('Descripcion:', item.desc || '').then(desc => {
                if (desc !== false) next.desc = desc;
                if (Object.keys(next).length) store.updateItem('Colecciones', id, next);
            });
        });
        return;
    }
};

window.handleDeleteClick = (e, key, id) => {
    if (e) e.stopPropagation();
    CustomDialog.confirm('Eliminar registro?').then(ok => {
        if (ok) store.removeItem(key, id);
    });
};
window.promptCreateFolder = () => {
    CustomDialog.prompt('Nombre de carpeta:').then(val => {
        if (val === false) return;
        ensureFolder(val);
    });
};
window.promptDeleteFolder = () => {
    const s = store.getState();
    if (!(s.folders || []).length) {
        CustomDialog.confirm('No hay carpetas para borrar.');
        return;
    }
    CustomDialog.prompt('Nombre de carpeta a borrar:').then(val => {
        if (val === false) return;
        const folder = getFolderByName(val);
        if (!folder) {
            CustomDialog.confirm('Carpeta no encontrada.');
            return;
        }
        CustomDialog.confirm(`Eliminar carpeta "${folder.name}"?`).then(ok => {
            if (!ok) return;
            const nextFolders = (s.folders || []).filter(f => f.id != folder.id);
            const clearFolder = (list) => (list || []).map(i => (String(i.folderId || '') === String(folder.id) ? { ...i, folderId: '' } : i));
            const nextFilters = { ...(s.folderFilters || {}) };
            Object.keys(nextFilters).forEach(k => {
                if (String(nextFilters[k]) === String(folder.id)) nextFilters[k] = '';
            });
            store.setState({
                folders: nextFolders,
                folderFilters: nextFilters,
                proyectos: clearFolder(s.proyectos),
                mapas: clearFolder(s.mapas),
                storyboard: clearFolder(s.storyboard),
                units: clearFolder(s.units)
            });
        });
    });
};
window.handleFolderAssign = (e, key, id) => {
    if (e) e.stopPropagation();
    const s = store.getState();
    const item = (s[key] || []).find(i => i.id == id);
    if (!item) return;
    const folders = (s.folders || []);
    if (!folders.length) {
        CustomDialog.confirm('No hay carpetas. ¿Quieres crear una?').then(ok => ok && promptCreateFolder());
        return;
    }
    const options = [{ label: 'Sin carpeta', value: '' }].concat(folders.map(f => ({ label: f.name, value: String(f.id) })));
    CustomDialog.selectPrompt('Selecciona carpeta:', options, String(item.folderId || '')).then(val => {
        if (val === false) return;
        store.updateItem(key, id, { folderId: val });
    });
};
// --- LOGIC ENGINE ---
window.handleDedicatedSubmit = async (e, type) => {
    e.preventDefault();
    const limitKey = type === 'Personaje' ? 'characters' : (type === 'Objeto' ? 'objects' : 'places');
    if (!canCreateForPlan(limitKey)) return;
    const name = document.getElementById('dc-name').value;
    const desc = document.getElementById('dc-desc').value;
    const imageFile = document.getElementById('dc-image').files[0];
    const image = imageFile ? await readFileAsDataURL(imageFile) : null;
    const fields = collectFieldsFromForm(e.target);
    store.addItem('units', { name, type, desc, image, fields });
    const views = { 'Personaje': 'personajes', 'Lugar': 'lugares', 'Objeto': 'inventario' };
    changeView(views[type]);
};

window.handleDedicatedEditSubmit = async (e, id) => {
    e.preventDefault();
    const name = document.getElementById('de-name').value;
    const desc = document.getElementById('de-desc').value;
    const imageFile = document.getElementById('de-image').files[0];

    const s = store.getState();
    const item = s.units.find(u => u.id == id);
    if (!item) return;

    const image = imageFile ? await readFileAsDataURL(imageFile) : item.image;

    const fields = collectFieldsFromForm(e.target);
    store.updateItem('units', id, { name, desc, image, fields });
    
    const views = { 'Personaje': 'personajes', 'Lugar': 'lugares', 'Objeto': 'inventario' };
    changeView(views[item.type]);
};

window.openModal = (type, editId = null) => {
    const modal = document.getElementById('creation-modal');
    if (!modal) return;

    const form = document.getElementById('creation-form');
    form.reset();
    document.getElementById('edit-context').value = '';
    document.getElementById('edit-parent-id').value = '';
    document.getElementById('btn-delete-item').style.display = 'none';
    document.getElementById('m-type').style.display = 'block';
    document.getElementById('edit-id').value = editId || '';

    if (editId) {
        const s = store.getState();
        const key = type === 'Proyecto' ? 'proyectos' : (type === 'Mapa' ? 'mapas' : 'units');
        const item = (s[key] || []).find(i => i.id == editId);
        if (item) {
            document.getElementById('m-name').value = item.name;
            document.getElementById('m-desc').value = item.desc || '';
            document.getElementById('modal-title').textContent = 'EDITAR ' + type.toUpperCase();
        }
    } else {
        document.getElementById('modal-title').textContent = 'NUEVO ' + type.toUpperCase();
    }

    document.getElementById('m-type').value = type;
    modal.style.display = 'flex';
};

window.promptAdd = async (key, label) => {
    const val = await CustomDialog.prompt(label + ':');
    if (val !== false) store.addItem(key, { name: val, desc: '' });
};

window.promptAddNetwork = async () => {
    const p1 = await CustomDialog.prompt('Elemento A:');
    if (p1 === false) return;
    const p2 = await CustomDialog.prompt('Elemento B:');
    if (p2 !== false) store.addItem('network', { p1, p2 });
};

window.merchAddItem = async () => {
    const s = store.getState();
    if (!s.isSuperadmin) return;
    const name = await CustomDialog.prompt('Nombre del producto:');
    if (!name) return;

    try {
        const token = await getCsrfToken();
        const res = await fetch('php/merch.php?action=add', {
            method: 'POST',
            credentials: 'same-origin',
            headers: {
                'Content-Type': 'application/json',
                'X-CSRF-Token': token
            },
            body: JSON.stringify({ name, price: '19.99', desc: 'Nuevo producto' })
        });
        const data = await res.json();
        if (data && data.success) {
            await loadGlobalMerch();
        }
    } catch (e) {
        console.error('[MERCH] Add failed:', e);
    }
};

window.merchRemoveItem = async (id) => {
    const s = store.getState();
    if (!s.isSuperadmin) return;
    const ok = await CustomDialog.confirm('¿Eliminar este producto permanentemente de la tienda global?');
    if (!ok) return;

    try {
        const token = await getCsrfToken();
        const res = await fetch('php/merch.php?action=delete', {
            method: 'POST',
            credentials: 'same-origin',
            headers: {
                'Content-Type': 'application/json',
                'X-CSRF-Token': token
            },
            body: JSON.stringify({ id })
        });
        const data = await res.json();
        if (data && data.success) {
            await loadGlobalMerch();
        }
    } catch (e) {
        console.error('[MERCH] Remove failed:', e);
    }
};

window.merchUpdateField = (id, key, value) => {
    const s = store.getState();
    if (!s.isSuperadmin) return;
    const next = (s.merch || []).map(p =>
        String(p.id) === String(id) ? { ...p, [key]: value } : p
    );
    // Local update only for UI responsiveness
    store.setState({ merch: next }, { silent: true });
};

window.merchUploadImage = async (id, input) => {
    try {
        const s = store.getState();
        if (!s.isSuperadmin) return;
        const file = input && input.files && input.files[0];
        if (!file) return;
        const token = await getCsrfToken();
        const form = new FormData();
        form.append('image', file);
        const res = await fetch('php/admin.php?action=upload_merch_image', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'X-CSRF-Token': token },
            body: form
        });
        const data = await res.json();
        if (!res.ok || !data.success || !data.path) {
            alert(data.message || 'No se pudo subir la imagen.');
            return;
        }
        window.merchUpdateField(id, 'image_url', data.path);
        await window.merchSaveProduct(id);
    } catch (e) {
        alert('No se pudo subir la imagen.');
    }
};

window.merchSaveProduct = async (id) => {
    try {
        const s = store.getState();
        if (!s.isSuperadmin) return;
        const item = (s.merch || []).find((m) => String(m.id) === String(id));
        if (!item) {
            alert('Producto no encontrado.');
            return;
        }

        const token = await getCsrfToken();
        const res = await fetch('php/merch.php?action=update', {
            method: 'POST',
            credentials: 'same-origin',
            headers: {
                'Content-Type': 'application/json',
                'X-CSRF-Token': token
            },
            body: JSON.stringify({
                id: item.id,
                name: item.name,
                price: item.price,
                desc: item.desc || item.description,
                image: item.image_url || item.image
            })
        });
        const data = await res.json();
        if (data && data.success) {
            await loadGlobalMerch();
            alert('Producto guardado globalmente.');
        } else {
            alert(data.message || 'Error al guardar.');
        }
    } catch (e) {
        console.error('[MERCH] Save failed:', e);
    }
};

// --- ADMIN ACTIONS ---
window.adminRefreshUsers = () => {
    adminEnsureUsersLoaded();
};

window.adminSelectUser = (userId) => {
    adminCache.selectedUserId = Number(userId) || null;
    adminCache.selectedUser = adminCache.users.find((u) => String(u.id) === String(userId)) || null;
    adminCache.state = null;
    adminCache.stateJsonDraft = '';
    adminCache.stateUpdatedAt = '';
    adminTriggerRender();
    if (adminCache.selectedUserId) {
        adminLoadUserState(adminCache.selectedUserId);
    }
};

window.adminUpdateStateJson = (value) => {
    adminCache.stateJsonDraft = value;
};

window.adminSaveStateJson = async () => {
    if (!adminCache.selectedUserId) return;
    try {
        const parsed = JSON.parse(adminCache.stateJsonDraft || '{}');
        if (!parsed || typeof parsed !== 'object') throw new Error('Estado invalido');
        adminCache.state = parsed;
        await adminSaveUserState(adminCache.selectedUserId, parsed);
    } catch (e) {
        adminCache.error = 'JSON invalido. Corrige y vuelve a intentar.';
        adminTriggerRender();
    }
};

window.adminSetUserRole = async () => {
    if (!adminCache.selectedUserId) return;
    const select = document.getElementById('admin-role-select');
    const role = select ? select.value : 'user';
    await adminSetRole(adminCache.selectedUserId, role);
};

// --- CORE APP ---
function initApp() {
    const container = document.getElementById('view-container');
    const title = document.getElementById('active-tool-title');
    const navItems = document.querySelectorAll('#tool-nav li');
    const searchInput = document.getElementById('global-search');
    if (searchInput) {
        searchInput.addEventListener('input', (e) => {
            const value = e.target.value || '';
            const trimmed = value.trim();
            const s = store.getState();
            if (trimmed) {
                const prev = (s.currentView && s.currentView !== 'resultados')
                    ? s.currentView
                    : (s._searchPrevView || 'proyectos');
                store.setState({ searchQuery: value, currentView: 'resultados', _searchPrevView: prev });
            } else {
                const nextView = s._searchPrevView || 'proyectos';
                store.setState({ searchQuery: '', currentView: nextView });
            }
        });
    }

    if (!container || !title) {
        console.error('[CRITICAL] UI elements not found!');
        return;
    }

    // Attach a global debug listener for dragstart once
    if (!window.__tier_debug_attached) {
        window.__tier_debug_attached = true;
        document.addEventListener('dragstart', (ev) => {
            try {
                console.log('[GLOBAL] dragstart detected on:', ev.target, ev.target?.className || ev.target?.id || ev.target?.tagName);
            } catch (err) { console.log('[GLOBAL] dragstart (err)', err); }
        }, true);
        document.addEventListener('drop', (ev) => {
            try { console.log('[GLOBAL] drop on:', ev.target, ev.target?.className || ev.target?.id || ev.target?.tagName); } catch (e) { }
        }, true);
    }

    let _lastView = null;
    const render = () => {
        try {
            const s = store.getState();
            if (searchInput && searchInput.value !== (s.searchQuery || '')) {
                searchInput.value = s.searchQuery || '';
            }
            const view = s.currentView || 'proyectos';
            // Auto-load community publications when switching to the view
            if (view === 'publicaciones' && view !== _lastView) {
                loadCommunityPubs();
            }
            if (view === 'admin' && s.isSuperadmin && !adminCache.loadingUsers && adminCache.users.length === 0) {
                adminEnsureUsersLoaded();
            }
            _lastView = view;

            // Sidebar Visibility Toggle
            document.body.classList.toggle('is-pro', s.isSubscribed);
            const promo = document.getElementById('sidebar-promo');
            if (promo) promo.style.display = 'block';

            // Subscription Check
            if (RESTRICTED_VIEWS.includes(view) && !s.isSubscribed) {
                container.innerHTML = renderLockedView();
                title.textContent = 'HERRAMIENTA BLOQUEADA';
                navItems.forEach(li => li.classList.toggle('active', li.dataset.view === view));
                return;
            }

            const renderer = routes[view] || routes.proyectos;

            container.innerHTML = (renderer.length === 2) ? renderer(s, s.activeId) : renderer(s);

            if (view === 'tier_detail') {
                try {
                    console.log('[TIER] tier_detail rendered. tier id:', s.activeId);
                    const list = container.querySelector('.tier-list-container');
                    console.log('[TIER] tier container present?', !!list);
                    console.log('[TIER] sample html:', container.querySelector('.tier-list-container')?.innerHTML?.slice(0, 400));
                } catch (err) { console.warn('[TIER] debug failed', err); }
            }

            // Ensure edit/delete buttons work even if inline handlers are blocked
            container.querySelectorAll('.btn-edit-universal').forEach((btn) => {
                btn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    handleEditClick(e, btn.dataset.key, btn.dataset.id);
                });
            });
            container.querySelectorAll('.btn-delete-universal').forEach((btn) => {
                btn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    handleDeleteClick(e, btn.dataset.key, btn.dataset.id);
                });
            });

            if (view === 'editar_unit') {
                const item = (s.units || []).find(u => u.id == s.activeId);
                const rows = container.querySelector('.field-rows');
                if (rows) {
                    rows.innerHTML = '';
                    const fields = item?.fields || [];
                    if (fields.length) fields.forEach(f => appendFieldRow(rows, f));
                    else appendFieldRow(rows);
                }
            }

            // Update Active States
            document.querySelectorAll('#tool-nav li').forEach(li => li.classList.toggle('active', li.dataset.view === view));
            document.querySelectorAll('.nav-item').forEach(btn => btn.classList.toggle('active', btn.dataset.view === view));

            const welcomeTag = currentSessionUsername ? `<span style="display:block; font-size:0.8rem; letter-spacing:3px; color:var(--accent-secondary); margin-bottom:10px;">HOLA, ${currentSessionUsername.toUpperCase()}</span>` : '';

            if (view.startsWith('crear_')) {
                title.innerHTML = welcomeTag + 'CREANDO ' + view.split('_')[1].toUpperCase();
            } else if (view === 'map_detail') {
                title.innerHTML = welcomeTag + 'MAPA INTERACTIVO';
            } else {
                title.innerHTML = welcomeTag + view.toUpperCase().replace('_', ' ');
            }

            // Network View Initialization
            if (view === 'network') {
                setTimeout(initNetwork, 50);
            }
            if (view === 'indautor' || view === 'impi') {
                setTimeout(() => {
                    if (window.updateIndautorTotal) window.updateIndautorTotal();
                }, 10);
            }
        } catch (err) {
            console.error('[RENDER] Error rendering view:', err);
            container.innerHTML = `<div class="dev-msg" style="color:red;">Error de visualizacin. Pulsa en otra seccin.</div>`;
        }
    };

    // Global Click Dispatcher (capture for reliability)
    document.addEventListener('click', (e) => {
        const t = e.target;

        // CRUD Edit
        const edit = t.closest('.btn-edit-universal');
        if (edit) {
            e.preventDefault();
            e.stopPropagation();
            handleEditClick(e, edit.dataset.key, edit.dataset.id);
            return;
        }

        // CRUD Delete
        const del = t.closest('.btn-delete-universal');
        if (del) {
            e.preventDefault();
            e.stopPropagation();
            CustomDialog.confirm('Eliminar registro?').then(ok => {
                if (ok) store.removeItem(del.dataset.key, del.dataset.id);
            });
            return;
        }

        // Navigation (Sidebar)
        const nav = t.closest('li[data-view]');
        if (nav) {
            const navView = nav.dataset.view || '';
            const s = store.getState();
            if (!s.isSubscribed && (navView === 'mapas' || navView === 'storyboard')) {
                window.openPlanCenter();
                return;
            }
            store.setState({ searchQuery: '' });
            window.changeView(navView);
            return;
        }

        const topNav = t.closest('.nav-item[data-view]');
        if (topNav) {
            store.setState({ searchQuery: '' });
            window.changeView(topNav.dataset.view);
            return;
        }

        // Modals
        if (t.id === 'btn-close-modal' || t.id === 'creation-modal') {
            const form = document.getElementById('creation-form');
            if (form) form.reset();
            document.getElementById('edit-context').value = '';
            document.getElementById('edit-parent-id').value = '';
            document.getElementById('btn-delete-item').style.display = 'none';
            document.getElementById('m-type').style.display = 'block';
            document.getElementById('creation-modal').style.display = 'none';
            return;
        }

        // Details
        const mapEntry = t.closest('.map-entry');
        if (mapEntry) {
            const s = store.getState();
            if (!s.isSubscribed) {
                window.openPlanCenter();
                return;
            }
            store.setState({ currentView: 'map_detail', activeId: mapEntry.dataset.id });
            return;
        }

        const ficha = t.closest('.btn-view-ficha');
        if (ficha) {
            store.setState({ currentView: 'ficha_detalle', activeId: ficha.dataset.id });
            return;
        }
    }, true);

    const form = document.getElementById('creation-form');
    if (form) {
        form.addEventListener('submit', async (e) => {
            e.preventDefault();
            const n = document.getElementById('m-name').value;
            const t = document.getElementById('m-type').value;
            const d = document.getElementById('m-desc').value;
            const imageFile = document.getElementById('m-image').files[0];
            const editId = document.getElementById('edit-id').value;

            const context = document.getElementById('edit-context').value;
            const parentId = document.getElementById('edit-parent-id').value;

            if (context === 'ColeccionItem') {
                const s = store.getState();
                const col = (s.Colecciones || []).find(c => c.id == parentId);
                if (col) {
                    let img = null;
                    const existingItem = (col.items || []).find(i => i.id == editId);
                    img = imageFile ? await readFileAsDataURL(imageFile) : (existingItem ? existingItem.image : null);

                    const items = (col.items || []).map(it =>
                        it.id == editId ? { ...it, name: n, desc: d, image: img } : it
                    );
                    store.updateItem('Colecciones', parentId, { items });
                }
            } else {
                const key = t === 'Proyecto' ? 'proyectos' : (t === 'NetworkNode' ? 'networkNodes' : 'mapas');
                let img = null;

                if (editId) {
                    const s = store.getState();
                    let existing = null;
                    if (key === 'networkNodes') existing = (s.networkNodes || []).find(i => i.id == editId);
                    else existing = (s[key] || []).find(i => i.id == editId);

                    img = imageFile ? await readFileAsDataURL(imageFile) : (existing ? existing.image : null);

                    if (t === 'NetworkNode') {
                        const nodes = (s.networkNodes || []).map(nodeItem => nodeItem.id == editId ? { ...nodeItem, name: n, desc: d, image: img } : nodeItem);
                        store.setState({ networkNodes: nodes });
                    } else {
                        store.updateItem(key, editId, { name: n, desc: d, image: img });
                    }
                } else {
                    img = imageFile ? await readFileAsDataURL(imageFile) : null;
                    if (t === 'Proyecto') store.addItem('proyectos', { name: n, desc: d, image: img });
                    else if (t === 'Mapa') store.addItem('mapas', { name: n, pins: [], image: img || 'https://via.placeholder.com/400x200?text=Mapa' });
                    else if (t === 'Merch') store.addItem('merch', { name: n, desc: d, price: '24.99', image: img || 'https://via.placeholder.com/300?text=MERCH' });
                    else if (t === 'NetworkNode') {
                        if (!canCreateForPlan('networks')) return;
                        const s = store.getState();
                        const newNode = {
                            id: 'node_' + Date.now(),
                            name: n,
                            type: 'Nota',
                            desc: d,
                            image: img,
                            x: 50,
                            y: 50
                        };
                        store.setState({ networkNodes: [...(s.networkNodes || []), newNode] });
                    }
                }
            }

            form.reset();
            document.getElementById('edit-context').value = '';
            document.getElementById('edit-parent-id').value = '';
            document.getElementById('btn-delete-item').style.display = 'none';
            document.getElementById('m-type').style.display = 'block'; // Restore
            document.getElementById('creation-modal').style.display = 'none';
        });
    }

    store.subscribe(render);
    render();
    console.log('[SYSTEM] Engine v2.4 initialized.');
}

// --- NEW HANDLERS ---


window.promptAddNetworkNode = async () => {
    // Check if we have existing units to quick-add
    const s = store.getState();
    const units = s.units || [];

    // First ask: Create new or Add Existing?
    const choice = await CustomDialog.selectPrompt(
        'Que quieres anadir?',
        [
            { label: 'Crear nuevo nodo (Foto/Desc)', value: 'new' },
            ...units.map(u => ({ label: `Existente: ${u.name} (${u.type})`, value: u.id }))
        ]
    );

    if (choice === false) return;

    if (choice === 'new') {
        if (!canCreateForPlan('networks')) return;
        // Open the creation modal adapted for Nodes
        const modal = document.getElementById('creation-modal');
        const form = document.getElementById('creation-form');
        document.getElementById('modal-title').textContent = 'Nuevo Nodo de Conexión';
        document.getElementById('m-name').value = '';
        document.getElementById('m-desc').value = '';
        document.getElementById('m-image').value = '';
        document.getElementById('edit-id').value = '';

        // Add "Nodo" option if not exists or select it
        const typeSelect = document.getElementById('m-type');
        let nodeOpt = Array.from(typeSelect.options).find(o => o.value === 'NetworkNode');
        if (!nodeOpt) {
            nodeOpt = document.createElement('option');
            nodeOpt.value = 'NetworkNode';
            nodeOpt.text = 'Nodo de Mapa';
            typeSelect.add(nodeOpt);
        }
        typeSelect.value = 'NetworkNode';

        modal.style.display = 'flex';
        // The submit handler in initApp will handle it (we need to update it)
    } else {
        // Add existing unit
        const u = units.find(unit => unit.id == choice);
        if (u) {
            if (!canCreateForPlan('networks')) return;
            const exists = (s.networkNodes || []).find(n => n.name === u.name);
            if (exists) {
                CustomDialog.confirm('Este elemento ya esta en el mapa.');
                return;
            }

            const nodes = s.networkNodes || [];
            const newNode = {
                id: 'node_' + Date.now(),
                name: u.name,
                type: u.type,
                image: u.image,
                desc: u.desc || '',
                x: 50,
                y: 50,
                linkedUnitId: u.id
            };
            store.setState({ networkNodes: [...nodes, newNode] });
        }
    }
};

// --- NETWORK HANDLERS ---
window.deleteNetworkNode = (id) => {
    CustomDialog.confirm('Seguro que quieres eliminar este nodo y sus conexiones?').then(ok => {
        if (!ok) return;
        const s = store.getState();
        const nodes = (s.networkNodes || []).filter(n => n.id !== id);
        const connections = (s.networkConnections || []).filter(c => c.from !== id && c.to !== id);
        store.setState({ networkNodes: nodes, networkConnections: connections });

        // If the view modal is open (custom dialog or creation modal), we might need to close it.
        // But since we use CustomDialog for the view, closing it programmatically is tricky if we don't track it.
        // Usually rerender handles UI updates.
        document.getElementById('creation-modal').style.display = 'none';

        // Force close custom dialog if it's the specific view one? 
        // CustomDialog.close(); // Not exposed directly like that, but ok for now.
    });
};

window.viewNetworkNode = (nodeId) => {
    const s = store.getState();
    const node = (s.networkNodes || []).find(n => n.id === nodeId);
    if (!node) return;

    const panel = document.getElementById('network-details-panel');
    if (!panel) return;

    // Populate
    document.getElementById('nd-title').textContent = node.name || 'NODO';
    document.getElementById('nd-type').textContent = node.type || 'NODO';
    document.getElementById('nd-desc').textContent = node.desc || 'Sin descripcion.';

    const imgCont = document.getElementById('nd-img-container');
    const fallback = document.getElementById('nd-img-fallback');
    if (node.image) {
        imgCont.style.backgroundImage = `url('${node.image}')`;
        if (fallback) fallback.style.display = 'none';
    } else {
        imgCont.style.backgroundImage = 'linear-gradient(135deg, #1f2846, #12162c)';
        if (fallback) {
            fallback.style.display = 'block';
            fallback.textContent = (node.name || '?').charAt(0).toUpperCase();
        }
    }

    // Actions
    const btnEdit = document.getElementById('btn-nd-edit');
    const btnDel = document.getElementById('btn-nd-delete');
    const btnOpen = document.getElementById('btn-nd-open');

    btnEdit.onclick = () => window.editNetworkNode(nodeId);
    btnDel.onclick = () => window.deleteNetworkNode(nodeId);
    if (btnOpen) btnOpen.onclick = () => window.editNetworkNode(nodeId);

    // Show
    panel.style.display = 'block';
};

window.editNetworkNode = (nodeId) => {
    const s = store.getState();
    const node = (s.networkNodes || []).find(n => n.id === nodeId);
    if (!node) return;

    const modal = document.getElementById('creation-modal');
    document.getElementById('modal-title').textContent = 'Editar Nodo';
    document.getElementById('m-name').value = node.name || '';
    document.getElementById('m-desc').value = node.desc || '';
    document.getElementById('m-image').value = '';
    document.getElementById('edit-id').value = nodeId;

    const typeSelect = document.getElementById('m-type');
    let nodeOpt = Array.from(typeSelect.options).find(o => o.value === 'NetworkNode');
    if (!nodeOpt) {
        nodeOpt = document.createElement('option');
        nodeOpt.value = 'NetworkNode';
        nodeOpt.text = 'Nodo de Mapa';
        typeSelect.add(nodeOpt);
    }
    typeSelect.value = 'NetworkNode';

    modal.style.display = 'flex';
};

window.promptConnectionLabel = async (fromId, toId) => {
    const s = store.getState();
    const n1 = (s.networkNodes || []).find(n => n.id === fromId);
    const n2 = (s.networkNodes || []).find(n => n.id === toId);

    const label = await CustomDialog.prompt(`Conectar ${n1?.name} con ${n2?.name}. Razón/Etiqueta:`, 'Relacion');
    if (label === false) return null; // Cancelled
    return label;
};

window.showConnectionDetails = (connId) => {
    const s = store.getState();
    const conn = (s.networkConnections || []).find(c => c.id === connId);
    if (!conn) return;

    const n1 = (s.networkNodes || []).find(n => n.id === conn.from);
    const n2 = (s.networkNodes || []).find(n => n.id === conn.to);

    CustomDialog.confirm(`
        CONEXION: ${conn.label || 'Sin etiqueta'}
        ----------------
        De: ${n1?.name}
        Para: ${n2?.name}
    `);
};


window.setNetworkMode = (mode) => {
    setMode(mode);
    // Visual feedback on buttons
    document.getElementById('btn-net-conn').style.background = mode === 'connect' ? 'rgba(0, 210, 255, 0.3)' : 'transparent';
};
window.handleTimelineSubmit = async (e) => {
    e.preventDefault();
    const name = document.getElementById('tl-name')?.value;
    const desc = document.getElementById('tl-desc')?.value;
    const date = document.getElementById('tl-date')?.value;
    const imageFile = document.getElementById('tl-image')?.files?.[0];
    const unitId = document.getElementById('tl-unit')?.value;
    const s = store.getState();
    const unit = (s.units || []).find(u => u.id == unitId);
    const image = imageFile ? await readFileAsDataURL(imageFile) : null;
    const payload = {
        name,
        desc,
        date,
        image,
        unitId: unit ? unit.id : null,
        unitType: unit ? unit.type : null,
        unitName: unit ? unit.name : null
    };
    const activeBoardId = s.activeTimelineBoardId;
    if (activeBoardId) {
        const board = (s.timelineBoards || []).find(b => String(b.id) === String(activeBoardId));
        if (board) {
            const events = [...(board.events || []), { ...payload, id: Date.now() }];
            store.updateItem('timelineBoards', activeBoardId, { events });
            store.setState({ currentView: 'timeline_board_detail', activeId: activeBoardId, activeTimelineBoardId: null });
            return;
        }
    }
    store.addItem('timeline', payload);
    store.setState({ currentView: 'timeline', activeTimelineBoardId: null });
};

window.openTimelineEventForm = (boardId = '') => {
    const targetBoardId = boardId ? String(boardId) : '';
    const next = { currentView: 'crear_timeline', activeTimelineBoardId: targetBoardId || null };
    if (targetBoardId) next.activeId = targetBoardId;
    store.setState(next);
};

window.goBackFromTimelineCreate = () => {
    const s = store.getState();
    const boardId = s.activeTimelineBoardId;
    if (boardId) {
        store.setState({ currentView: 'timeline_board_detail', activeId: boardId, activeTimelineBoardId: null });
        return;
    }
    store.setState({ currentView: 'timeline' });
};

window.handleTimelineBoardSubmit = (e) => {
    e.preventDefault();
    if (!canCreateForPlan('timelines')) return;
    const name = document.getElementById('tlb-name')?.value?.trim();
    const desc = document.getElementById('tlb-desc')?.value || '';
    if (!name) {
        CustomDialog.confirm('Escribe un nombre para la timeline.');
        return;
    }
    store.addItem('timelineBoards', { name, desc, events: [] });
    changeView('timeline');
};

window.handleColeccionSubmit = async (e) => {
    e.preventDefault();
    if (!canCreateForPlan('collections')) return;
    const name = document.getElementById('col-name')?.value;
    const desc = document.getElementById('col-desc')?.value;
    store.addItem('Colecciones', { name, desc, items: [] });
    changeView('Colecciones');
};

window.handleStoryboardSubmit = async (e) => {
    e.preventDefault();
    const name = document.getElementById('sb-name')?.value?.trim();
    const desc = document.getElementById('sb-desc')?.value;
    const imageFile = document.getElementById('sb-image')?.files?.[0];
    if (!name) {
        CustomDialog.confirm('Escribe un nombre para crear el storyboard.');
        return;
    }
    const image = imageFile ? await readFileAsDataURL(imageFile) : null;
    store.addItem('storyboard', { name, desc, image, items: [] });
    changeView('storyboard');
};

window.handleStoryboardSceneSubmit = async (e, boardId) => {
    e.preventDefault();
    const name = document.getElementById(`sbi-name-${boardId}`)?.value?.trim();
    const desc = document.getElementById(`sbi-desc-${boardId}`)?.value?.trim();
    const imageFile = document.getElementById(`sbi-image-${boardId}`)?.files?.[0];
    if (!name) {
        CustomDialog.confirm('Escribe el nombre de la escena.');
        return;
    }
    const image = imageFile ? await readFileAsDataURL(imageFile) : null;
    const s = store.getState();
    const board = (s.storyboard || []).find(st => st.id == boardId);
    if (!board) {
        CustomDialog.confirm('No se encontro el storyboard para guardar la escena. Vuelve a abrirlo.');
        return;
    }
    const items = [...(board.items || []), { id: Date.now(), name, desc: desc || '', image }];
    store.updateItem('storyboard', boardId, { items });
    const form = e.target;
    if (form) form.reset();
};

window.handleStoryboardSceneEdit = (boardId, itemId) => {
    const s = store.getState();
    const board = (s.storyboard || []).find(st => st.id == boardId);
    if (!board) return;
    const it = (board.items || []).find(i => i.id == itemId);
    if (!it) return;
    CustomDialog.promptWithFile('Editar escena (nombre):', it.name || '').then(async (res) => {
        if (res === false) return;
        const next = { ...it };
        if (typeof res.value === 'string' && res.value.trim()) next.name = res.value.trim();
        if (res.file) next.image = await readFileAsDataURL(res.file);
        CustomDialog.prompt('Descripcion de escena:', it.desc || '').then(desc => {
            if (desc !== false) next.desc = desc;
            const items = (board.items || []).map(i => i.id == itemId ? next : i);
            store.updateItem('storyboard', boardId, { items });
        });
    });
};

window.handleTimelineFieldFocus = (e, field) => {
    if (e) e.stopPropagation();
    const el = e?.currentTarget;
    if (!el) return;
    if (field === 'date') {
        el.textContent = el.dataset.rawDate || '';
    }
};

window.handleTimelineDatePicker = (e, id, boardId = '') => {
    if (e) e.stopPropagation();
    const anchorEl = e?.currentTarget || null;
    const s = store.getState();
    const isBoard = !!String(boardId || '');
    const board = isBoard ? (s.timelineBoards || []).find(b => String(b.id) === String(boardId)) : null;
    const list = isBoard ? (board?.events || []) : (s.timeline || []);
    const item = list.find(t => String(t.id) === String(id));
    if (!item) return;

    const update = (nextDate) => {
        if (isBoard && board) {
            const events = (board.events || []).map(ev => String(ev.id) === String(id) ? { ...ev, date: nextDate } : ev);
            store.updateItem('timelineBoards', board.id, { events });
        } else {
            store.updateItem('timeline', id, { date: nextDate });
        }
    };

    const input = document.createElement('input');
    input.type = 'date';
    input.value = item.date || '';
    input.style.position = 'fixed';
    const rect = anchorEl?.getBoundingClientRect?.();
    input.style.left = `${Math.max(8, Math.round(rect?.left || 8))}px`;
    input.style.top = `${Math.max(8, Math.round((rect?.bottom || 8) + 6))}px`;
    input.style.width = '1px';
    input.style.height = '1px';
    input.style.opacity = '0.01';
    input.style.pointerEvents = 'none';
    input.style.zIndex = '9999';
    document.body.appendChild(input);

    const clean = () => {
        if (input && input.parentNode) input.parentNode.removeChild(input);
    };

    input.addEventListener('change', () => {
        update(input.value || '');
    }, { once: true });
    input.addEventListener('blur', () => {
        setTimeout(clean, 0);
    }, { once: true });

    input.focus();
    if (typeof input.showPicker === 'function') {
        input.showPicker();
    } else {
        input.click();
    }
};

window.handleTimelineInlineCommit = (e, id, field, boardId = '') => {
    if (e) e.stopPropagation();
    const el = e?.currentTarget;
    if (!el) return;
    const s = store.getState();
    const isBoard = !!String(boardId || '');
    const board = isBoard ? (s.timelineBoards || []).find(b => String(b.id) === String(boardId)) : null;
    const list = isBoard ? (board?.events || []) : (s.timeline || []);
    const item = list.find(t => String(t.id) === String(id));
    if (!item) return;
    let value = String(el.textContent || '').trim();
    const update = (patch) => {
        if (isBoard && board) {
            const events = (board.events || []).map(ev => String(ev.id) === String(id) ? { ...ev, ...patch } : ev);
            store.updateItem('timelineBoards', board.id, { events });
        } else {
            store.updateItem('timeline', id, patch);
        }
    };

    if (field === 'name') {
        if (!value) value = item.name || 'Evento';
        if (value !== (item.name || '')) update({ name: value });
        return;
    }

    if (field === 'desc') {
        if (value === 'Sin descripcion') value = '';
        if (value !== (item.desc || '')) update({ desc: value });
        return;
    }

    if (field === 'date') {
        if (!value) {
            if (item.date) update({ date: '' });
            return;
        }
        const isoMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
        if (isoMatch) {
            if (value !== (item.date || '')) update({ date: value });
            return;
        }
        const d = new Date(value);
        if (Number.isNaN(d.getTime())) {
            el.textContent = formatTimelineDate(item.date);
            return;
        }
        const yyyy = d.getFullYear();
        const mm = String(d.getMonth() + 1).padStart(2, '0');
        const dd = String(d.getDate()).padStart(2, '0');
        const normalized = `${yyyy}-${mm}-${dd}`;
        if (normalized !== (item.date || '')) update({ date: normalized });
    }
};

window.handleTimelineBoardEventEdit = (e, boardId, eventId) => {
    if (e) e.stopPropagation();
    const s = store.getState();
    const board = (s.timelineBoards || []).find(b => String(b.id) === String(boardId));
    if (!board) return;
    const item = (board.events || []).find(ev => String(ev.id) === String(eventId));
    if (!item) return;
    CustomDialog.promptWithFile('Editar Evento:', item.name || '').then(async (res) => {
        if (res === false) return;
        const next = { ...item };
        if (typeof res.value === 'string' && res.value.trim()) next.name = res.value.trim();
        if (res.file) next.image = await readFileAsDataURL(res.file);
        const events = (board.events || []).map(ev => String(ev.id) === String(eventId) ? next : ev);
        store.updateItem('timelineBoards', boardId, { events });
    });
};

window.handleTimelineBoardEventDelete = (e, boardId, eventId) => {
    if (e) e.stopPropagation();
    CustomDialog.confirm('Eliminar evento de esta timeline?').then(ok => {
        if (!ok) return;
        const s = store.getState();
        const board = (s.timelineBoards || []).find(b => String(b.id) === String(boardId));
        if (!board) return;
        const events = (board.events || []).filter(ev => String(ev.id) !== String(eventId));
        store.updateItem('timelineBoards', boardId, { events });
    });
};

window.handleStoryboardSlotClick = async (boardId, slotIndex, itemId = '') => {
    if (itemId) {
        window.handleStoryboardSceneEdit(boardId, itemId);
        return;
    }
    const s = store.getState();
    const board = (s.storyboard || []).find(st => String(st.id) === String(boardId));
    if (!board) return;

    const res = await CustomDialog.promptWithFile('Nueva escena (nombre):', '');
    if (res === false) return;
    const name = (typeof res?.value === 'string' ? res.value.trim() : '');
    if (!name) {
        CustomDialog.confirm('Escribe el nombre de la escena.');
        return;
    }

    const desc = await CustomDialog.prompt('Descripcion de escena:', '');
    if (desc === false) return;
    const image = res?.file ? await readFileAsDataURL(res.file) : null;

    const items = [...(board.items || [])];
    const next = { id: Date.now(), name, desc: desc || '', image };
    const idx = Number(slotIndex);
    if (Number.isInteger(idx) && idx >= 0 && idx <= items.length) items.splice(idx, 0, next);
    else items.push(next);
    store.updateItem('storyboard', boardId, { items });
};

window.handleStoryboardInlineTextSave = (boardId, itemId, slotIndex, field, value) => {
    const key = field === 'name' ? 'name' : 'desc';
    const nextValue = String(value || '').trim();
    const s = store.getState();
    const board = (s.storyboard || []).find(st => String(st.id) === String(boardId));
    if (!board) return;
    const idx = Number(slotIndex);
    const hasItemId = String(itemId || '').trim() !== '';

    if (!hasItemId) {
        if (!nextValue) return;
        const items = [...(board.items || [])];
        const next = {
            id: Date.now(),
            name: key === 'name' ? nextValue : 'ESCENA',
            desc: key === 'desc' ? nextValue : '',
            image: null
        };
        if (Number.isInteger(idx) && idx >= 0 && idx <= items.length) items.splice(idx, 0, next);
        else items.push(next);
        store.updateItem('storyboard', boardId, { items });
        return;
    }

    const items = (board.items || []).map((it) => {
        if (String(it.id) !== String(itemId)) return it;
        if (key === 'name' && !nextValue) return { ...it, name: it.name || 'ESCENA' };
        return { ...it, [key]: nextValue };
    });
    store.updateItem('storyboard', boardId, { items });
};

window.addStoryboardSlot = (boardId) => {
    const s = store.getState();
    const board = (s.storyboard || []).find(st => String(st.id) === String(boardId));
    if (!board) return;
    const currentSlots = Math.max(12, (board.items || []).length, Number(board.slotCount) || 0);
    store.updateItem('storyboard', boardId, { slotCount: currentSlots + 1 });
};

window.handleStoryboardSceneDelete = (boardId, itemId) => {
    CustomDialog.confirm('Eliminar escena?').then(ok => {
        if (!ok) return;
        const s = store.getState();
        const board = (s.storyboard || []).find(st => st.id == boardId);
        if (!board) return;
        const items = (board.items || []).filter(i => i.id != itemId);
        store.updateItem('storyboard', boardId, { items });
    });
};

window.handleColeccionItemSubmit = async (e, colId) => {
    e.preventDefault();
    const name = document.getElementById(`ci-name-${colId}`)?.value;
    const imageFile = document.getElementById(`ci-image-${colId}`)?.files?.[0];
    const checked = document.getElementById(`ci-check-${colId}`)?.checked;
    const image = imageFile ? await readFileAsDataURL(imageFile) : null;
    const s = store.getState();
    const col = (s.Colecciones || []).find(c => c.id == colId);
    if (!col) return;
    const items = [...(col.items || []), { id: Date.now(), name, image, checked: !!checked }];
    store.updateItem('Colecciones', colId, { items });
};

window.toggleColeccionItem = (colId, itemId) => {
    const s = store.getState();
    const col = (s.Colecciones || []).find(c => c.id == colId);
    if (!col) return;
    const items = (col.items || []).map(it => it.id == itemId ? { ...it, checked: !it.checked } : it);
    store.updateItem('Colecciones', colId, { items });
};

window.handleColeccionItemEdit = (colId, itemId) => {
    const s = store.getState();
    const col = (s.Colecciones || []).find(c => c.id == colId);
    if (!col) return;
    const it = (col.items || []).find(i => i.id == itemId);
    if (!it) return;
    CustomDialog.promptWithFile('Editar elemento:', it.name).then(async (res) => {
        if (res === false) return;
        const nextItem = { ...it };
        if (typeof res.value === 'string' && res.value.trim()) nextItem.name = res.value.trim();
        if (res.file) nextItem.image = await readFileAsDataURL(res.file);
        const items = (col.items || []).map(i => i.id == itemId ? nextItem : i);
        store.updateItem('Colecciones', colId, { items });
    });
};

window.handleTierSubmit = async (e) => {
    e.preventDefault();
    const name = document.getElementById('tier-name')?.value;
    const itemsRaw = document.getElementById('tier-items')?.value;
    const imageFile = document.getElementById('tier-image')?.files?.[0];
    const viewMode = document.getElementById('tier-view-mode')?.value === 'iceberg' ? 'iceberg' : 'tier';

    const items = listToItems(itemsRaw);
    const image = imageFile ? await readFileAsDataURL(imageFile) : null;

    // Default structure for new Tier List
    const newTier = {
        name,
        image,
        viewMode,
        rows: buildDefaultTierRows(),
        pool: items.map((it, idx) => ({
            id: 'item_' + Date.now() + '_' + idx,
            name: it,
            image: null // Removed broken placeholder
        }))
    };

    store.addItem('tiers', newTier);
    changeView('tiers');
};

let draggingData = null;

window.handleTierDragStart = (e, tierId, fromRowId, itemId) => {
    draggingData = { tierId, fromRowId, itemId };
    try {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', itemId);
    } catch (err) {
        console.warn('[TIER] dataTransfer may be unavailable:', err);
    }
    e.target.classList.add('dragging');
    console.log('[TIER] dragstart', draggingData);
};

window.handleTierDragOver = (e) => {
    e.preventDefault();
    e.currentTarget.classList.add('drag-over');
};

window.handleTierDragLeave = (e) => {
    e.currentTarget.classList.remove('drag-over');
};

window.handleTierDrop = (e, tierId, toRowId) => {
    e.preventDefault();
    const target = e.currentTarget;
    target.classList.remove('drag-over');
    // If draggingData is not available (some browsers or interruptions), try to read from dataTransfer
    if ((!draggingData || draggingData.tierId !== tierId) && e.dataTransfer) {
        try {
            const dtId = e.dataTransfer.getData('text/plain');
            if (dtId) {
                draggingData = { tierId, fromRowId: null, itemId: dtId };
            }
        } catch (err) {
            console.warn('[TIER] could not read dataTransfer on drop:', err);
        }
    }

    if (!draggingData || draggingData.tierId !== tierId) {
        console.log('[TIER] drop ignored - no draggingData or tier mismatch', { draggingData, tierId });
        return;
    }

    const { fromRowId, itemId } = draggingData;
    console.log('[TIER] drop handling', { tierId, toRowId, fromRowId, itemId });
    if (fromRowId === toRowId) return;

    const s = store.getState();
    const tiers = (s.tiers || []).map(t => {
        if (t.id != tierId) return t;
        console.log('[TIER] found tier in state', t.id, 'rows:', (t.rows || []).map(r => r.id), 'pool count:', (t.pool || []).length);
        console.log('[TIER] pool ids:', (t.pool || []).map(i => i.id).slice(0, 50));
        // Ensure we have a usable rows array (migrate missing rows to default layout)
        const defaultRowsTemplate = buildDefaultTierRows();
        const nextRows = (t.rows && t.rows.length) ? (t.rows || []).map(r => ({ ...r, items: [...(r.items || [])] })) : defaultRowsTemplate.map(r => ({ ...r, items: [] }));
        const nextPool = [...(t.pool || [])];
        let itemToMove = null;

        // Find and remove item from source
        if (fromRowId === 'pool') {
            const idx = nextPool.findIndex(i => i.id === itemId);
            if (idx > -1) [itemToMove] = nextPool.splice(idx, 1);
        } else {
            const rowIndex = nextRows.findIndex(r => r.id === fromRowId);
            if (rowIndex > -1) {
                const row = { ...nextRows[rowIndex], items: [...(nextRows[rowIndex].items || [])] };
                const idx = row.items.findIndex(i => i.id === itemId);
                if (idx > -1) {
                    [itemToMove] = row.items.splice(idx, 1);
                    nextRows[rowIndex] = row;
                }
            }
        }

        if (!itemToMove) {
            console.log('[TIER] itemToMove not found. fromRowId:', fromRowId, 'itemId:', itemId);
            return t;
        }

        // Add item to destination
        if (toRowId === 'pool') {
            nextPool.push(itemToMove);
        } else {
            const rowIndex = nextRows.findIndex(r => r.id === toRowId);
            if (rowIndex > -1) {
                const row = { ...nextRows[rowIndex], items: [...(nextRows[rowIndex].items || []), itemToMove] };
                nextRows[rowIndex] = row;
            }
        }

        return { ...t, rows: nextRows, pool: nextPool };
    });

    store.setState({ tiers });
    draggingData = null;
};

window.handleTierDragEnd = () => {
    // ensure we clear any stale dragging state
    if (draggingData) console.log('[TIER] dragend - clearing', draggingData);
    draggingData = null;
};

window.deleteTierItem = (tierId, rowId, itemId) => {
    const s = store.getState();
    const tiers = (s.tiers || []).map(t => {
        if (t.id != tierId) return t;

        // ensure rows exist
        const rows = (t.rows && t.rows.length) ? (t.rows || []).map(r => ({ ...r, items: [...(r.items || [])] })) : buildDefaultTierRows();

        let nextPool = [...(t.pool || [])];

        if (rowId === 'pool') {
            nextPool = nextPool.filter(i => i.id != itemId);
        } else {
            const rowIndex = rows.findIndex(r => r.id == rowId);
            if (rowIndex > -1) {
                rows[rowIndex] = { ...rows[rowIndex], items: (rows[rowIndex].items || []).filter(i => i.id != itemId) };
            }
        }

        return { ...t, rows, pool: nextPool };
    });

    store.setState({ tiers });
};

window.editTierRowLabel = async (tierId, rowId) => {
    const s = store.getState();
    const tier = (s.tiers || []).find(t => t.id == tierId);
    if (!tier) return;

    const rows = (tier.rows && tier.rows.length) ? [...tier.rows] : buildDefaultTierRows();
    const row = rows.find(r => r.id == rowId);
    if (!row) return;

    const nextLabel = await CustomDialog.prompt('Texto de la fila:', row.label || '');
    if (nextLabel === false) return;

    const cleanLabel = String(nextLabel || '').trim();
    if (!cleanLabel) return;

    const nextRows = rows.map(r => r.id == rowId ? { ...r, label: cleanLabel } : r);
    const tiers = (s.tiers || []).map(t => t.id == tierId ? { ...t, rows: nextRows } : t);
    store.setState({ tiers });
};

window.promptAddTierTextItem = async (tierId, rowId) => {
    const s = store.getState();
    const tier = (s.tiers || []).find(t => t.id == tierId);
    if (!tier) return;

    const rows = (tier.rows && tier.rows.length) ? [...tier.rows] : buildDefaultTierRows();
    const row = rows.find(r => r.id == rowId);
    if (!row) return;

    const textValue = await CustomDialog.prompt('Texto del nuevo elemento:', '');
    if (textValue === false) return;

    const cleanText = String(textValue || '').trim();
    if (!cleanText) return;

    const textItem = {
        id: `text_${Date.now()}_${Math.floor(Math.random() * 10000)}`,
        name: cleanText,
        image: null,
        kind: 'text'
    };

    const nextRows = rows.map(r => r.id == rowId ? { ...r, items: [...(r.items || []), textItem] } : r);
    const tiers = (s.tiers || []).map(t => t.id == tierId ? { ...t, rows: nextRows } : t);
    store.setState({ tiers });
};

window.setTierMode = (tierId, mode) => {
    const safeMode = mode === 'iceberg' ? 'iceberg' : 'tier';
    const s = store.getState();
    const tiers = (s.tiers || []).map(t => t.id == tierId ? { ...t, viewMode: safeMode } : t);
    store.setState({ tiers });
};

window.setCreateTierMode = (mode) => {
    const safeMode = mode === 'iceberg' ? 'iceberg' : 'tier';
    const input = document.getElementById('tier-view-mode');
    if (input) input.value = safeMode;

    const tierBtn = document.getElementById('create-mode-tier');
    const icebergBtn = document.getElementById('create-mode-iceberg');
    if (!tierBtn || !icebergBtn) return;

    tierBtn.classList.toggle('active', safeMode === 'tier');
    tierBtn.classList.toggle('glass', safeMode !== 'tier');
    icebergBtn.classList.toggle('active', safeMode === 'iceberg');
    icebergBtn.classList.toggle('glass', safeMode !== 'iceberg');
};

window.handleIcebergPointer = (e) => {
    const el = e.currentTarget;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    el.style.setProperty('--mx', `${x}px`);
    el.style.setProperty('--my', `${y}px`);
};

window.resetIcebergPointer = (e) => {
    const el = e.currentTarget;
    if (!el) return;
    el.style.removeProperty('--mx');
    el.style.removeProperty('--my');
};

window.promptAddTierRow = async (tierId) => {
    const s = store.getState();
    const tier = (s.tiers || []).find(t => t.id == tierId);
    if (!tier) return;

    const rows = (tier.rows && tier.rows.length) ? [...tier.rows] : buildDefaultTierRows();
    const defaultName = `Fila ${rows.length + 1}`;
    const nextLabel = await CustomDialog.prompt('Nombre de la nueva fila:', defaultName);
    if (nextLabel === false) return;

    const cleanLabel = String(nextLabel || '').trim();
    if (!cleanLabel) return;

    const colorCycle = ['tier-s', 'tier-a', 'tier-b', 'tier-c', 'tier-d', 'tier-f'];
    const rowColor = colorCycle[rows.length % colorCycle.length];
    const newRow = {
        id: `row_${Date.now()}_${Math.floor(Math.random() * 10000)}`,
        label: cleanLabel,
        color: rowColor,
        items: []
    };

    const tiers = (s.tiers || []).map(t => t.id == tierId ? { ...t, rows: [...rows, newRow] } : t);
    store.setState({ tiers });
};

window.deleteTierRow = async (tierId, rowId) => {
    const s = store.getState();
    const tier = (s.tiers || []).find(t => t.id == tierId);
    if (!tier) return;

    const rows = (tier.rows && tier.rows.length) ? [...tier.rows] : buildDefaultTierRows();
    if (rows.length <= 1) {
        CustomDialog.confirm('Debe existir al menos una fila.');
        return;
    }

    const row = rows.find(r => r.id == rowId);
    if (!row) return;

    const rowItems = [...(row.items || [])];
    const ok = await CustomDialog.confirm(`Eliminar fila "${row.label || 'Fila'}"?`);
    if (!ok) return;

    const nextRows = rows.filter(r => r.id != rowId);
    const nextPool = [...(tier.pool || []), ...rowItems];
    const tiers = (s.tiers || []).map(t => t.id == tierId ? { ...t, rows: nextRows, pool: nextPool } : t);
    store.setState({ tiers });
};

window.promptAddTierItem = async (tierId) => {
    const res = await CustomDialog.promptWithFile('Nombre del elemento:', '');
    if (res === false || !res.value) return;

    const name = res.value;
    const image = res.file ? await readFileAsDataURL(res.file) : null; // Avoid placeholders

    const s = store.getState();
    const tiers = (s.tiers || []).map(t => {
        if (t.id != tierId) return t;
        const pool = [...(t.pool || []), { id: 'item_' + Date.now(), name, image }];
        return { ...t, pool };
    });

    store.setState({ tiers });
};

const INDAUTOR_COSTO_OFICIAL = 367;
const INDAUTOR_HONORARIOS_GESTION = 2500;
const INDAUTOR_PAYPAL_BASE = (typeof window !== 'undefined' && window.INDAUTOR_PAYPAL_LINK)
    ? String(window.INDAUTOR_PAYPAL_LINK)
    : 'https://paypal.me/Mindtrain';

const resolveIndautorPaypalLink = () => {
    const total = INDAUTOR_COSTO_OFICIAL + INDAUTOR_HONORARIOS_GESTION;
    const raw = (INDAUTOR_PAYPAL_BASE || '').trim();
    if (!raw || raw.includes('TUUSUARIO')) return '';
    const cleaned = raw.replace(/\/+$/, '');
    if (/paypal\.me\/[^/]+\/\d+(\.\d+)?$/i.test(cleaned)) return cleaned;
    if (/paypal\.me\/[^/]+$/i.test(cleaned)) return `${cleaned}/${total}`;
    return cleaned;
};

window.updateIndautorTotal = () => {
    const total = INDAUTOR_COSTO_OFICIAL + INDAUTOR_HONORARIOS_GESTION;
    const costoTxt = document.getElementById('indautor-costo-gob-txt');
    const honorariosTxt = document.getElementById('indautor-honorarios-txt');
    const totalTxt = document.getElementById('indautor-total-txt');
    if (costoTxt) costoTxt.textContent = 'Incluido en paquete';
    if (honorariosTxt) honorariosTxt.textContent = 'Incluido en paquete';
    if (totalTxt) totalTxt.textContent = `$${total.toLocaleString('es-MX')} MXN`;
};

window.payIndautorWithPaypal = () => {
    const link = resolveIndautorPaypalLink();
    if (!link) {
        CustomDialog.confirm('Configura el enlace de PayPal en INDAUTOR_PAYPAL_LINK para habilitar el cobro.');
        return;
    }
    window.open(link, '_blank', 'noopener,noreferrer');
    CustomDialog.prompt('Cuando termines el pago, pega tu ID/folio de transaccion PayPal:').then((ref) => {
        if (ref === false) return;
        const cleanRef = String(ref || '').trim();
        if (!cleanRef) {
            CustomDialog.confirm('Necesitamos el folio de PayPal para habilitar el envio.');
            return;
        }
        const paid = document.getElementById('indautor-paid');
        const payRef = document.getElementById('indautor-pay-ref');
        const status = document.getElementById('indautor-pay-status');
        const submitBtn = document.getElementById('indautor-submit-btn');
        if (paid) paid.value = '1';
        if (payRef) payRef.value = cleanRef;
        if (status) status.textContent = `Estado: pago confirmado (${cleanRef}).`;
        if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.style.opacity = '1';
            submitBtn.style.cursor = 'pointer';
        }
    });
};


window.handleIndautorSubmit = (e) => {
    e.preventDefault();
    const paid = document.getElementById('indautor-paid')?.value === '1';
    if (!paid) {
        CustomDialog.confirm('Primero realiza el pago en PayPal para habilitar el envio de solicitud.');
        return;
    }
    const payload = {
        nombre: document.getElementById('indautor-nombre')?.value?.trim(),
        telefono: document.getElementById('indautor-telefono')?.value?.trim(),
        email: document.getElementById('indautor-email')?.value?.trim(),
        ciudad: document.getElementById('indautor-ciudad')?.value?.trim(),
        tipoObra: document.getElementById('indautor-tipo-obra')?.value?.trim(),
        obra: document.getElementById('indautor-obra')?.value?.trim(),
        metodoPagoHonorarios: 'PayPal',
        referenciaPago: document.getElementById('indautor-pay-ref')?.value?.trim(),
        costoGob: INDAUTOR_COSTO_OFICIAL,
        honorarios: INDAUTOR_HONORARIOS_GESTION,
        total: INDAUTOR_COSTO_OFICIAL + INDAUTOR_HONORARIOS_GESTION,
        notas: document.getElementById('indautor-notas')?.value?.trim()
    };
    CustomDialog.confirm('Solicitud INDAUTOR enviada. En breve te contactamos para continuar el tramite.').then(() => {
        const form = document.getElementById('indautor-form');
        if (form) form.reset();
        const city = document.getElementById('indautor-ciudad');
        if (city) city.value = 'Guadalajara';
        const paidField = document.getElementById('indautor-paid');
        const refField = document.getElementById('indautor-pay-ref');
        const status = document.getElementById('indautor-pay-status');
        const submitBtn = document.getElementById('indautor-submit-btn');
        if (paidField) paidField.value = '0';
        if (refField) refField.value = '';
        if (status) status.textContent = 'Estado: pendiente de pago.';
        if (submitBtn) {
            submitBtn.disabled = true;
            submitBtn.style.opacity = '0.6';
            submitBtn.style.cursor = 'not-allowed';
        }
        window.updateIndautorTotal();
    });
    console.log('[INDAUTOR] Solicitud:', payload);
};

// Compatibilidad temporal por si quedo algun enlace viejo
window.handleImpiSubmit = (e) => window.handleIndautorSubmit(e);

window.setMapTool = (key, value) => {
    const s = store.getState();
    const tool = { ...(s.mapTool || {}) };
    tool[key] = value;
    store.setState({ mapTool: tool });
};

window.setMapToolType = (type) => {
    window.setMapTool('type', type);
};

window.handleMapIconUpload = async (e) => {
    const file = e?.target?.files?.[0];
    if (!file) return;
    const image = await readFileAsDataURL(file);
    const s = store.getState();
    const tool = { ...(s.mapTool || {}) };
    tool.image = image;
    tool.type = 'image';
    if (!tool.size || Number(tool.size) > 30) tool.size = 22;
    store.setState({ mapTool: tool });
};

window.handleStoryboardImageUpload = async (e, id, sceneId = null) => {
    const file = e?.target?.files?.[0];
    if (!file) return;
    const image = await readFileAsDataURL(file);
    if (!sceneId) {
        store.updateItem('storyboard', id, { image });
        return;
    }
    const s = store.getState();
    const board = (s.storyboard || []).find(st => st.id == id);
    if (!board) return;
    const items = (board.items || []).map(it => it.id == sceneId ? { ...it, image } : it);
    store.updateItem('storyboard', id, { items });
};

let mapArrowDraft = null;
let mapDragDraft = null;
let mapPanDraft = null;
let mapIgnoreNextClick = false;
const mapViewportById = {};

const getMapViewport = (mapId) => {
    const key = String(mapId);
    if (!mapViewportById[key]) mapViewportById[key] = { scale: 1, tx: 0, ty: 0 };
    return mapViewportById[key];
};

const applyMapViewport = (mapId) => {
    const canvas = document.getElementById(`map-canvas-${mapId}`);
    if (!canvas) return;
    const vp = getMapViewport(mapId);
    canvas.style.transform = `translate(${vp.tx}px, ${vp.ty}px) scale(${vp.scale})`;
};

const zoomMapAtPoint = (mapId, target, nextScale, anchorX, anchorY) => {
    if (!target) return;
    const vp = getMapViewport(mapId);
    const prevScale = vp.scale;
    const clamped = Math.max(0.6, Math.min(3.5, nextScale));
    if (clamped === prevScale) return;
    const worldX = (anchorX - vp.tx) / prevScale;
    const worldY = (anchorY - vp.ty) / prevScale;
    vp.scale = clamped;
    vp.tx = anchorX - worldX * clamped;
    vp.ty = anchorY - worldY * clamped;
    applyMapViewport(mapId);
};

const mapClientToLocal = (clientX, clientY, target, mapId) => {
    const rect = target.getBoundingClientRect();
    const vp = getMapViewport(mapId);
    const lx = (clientX - rect.left - vp.tx) / vp.scale;
    const ly = (clientY - rect.top - vp.ty) / vp.scale;
    const x = Math.max(0, Math.min(rect.width, lx));
    const y = Math.max(0, Math.min(rect.height, ly));
    return { x, y, width: rect.width, height: rect.height };
};

window.handleMapClick = (e, mapId) => {
    if (mapIgnoreNextClick) {
        mapIgnoreNextClick = false;
        return;
    }
    const tool = store.getState().mapTool || {};
    if (tool.type === 'arrow' || tool.type === 'cursor') return;
    window.addPin(e, mapId);
};

window.handleMapPointerDown = (e, mapId) => {
    const tool = store.getState().mapTool || {};
    const markerEl = e.target.closest('.map-marker');
    if (markerEl) {
        if (e.target.closest('.map-marker-remove')) return;
        if (tool.type === 'cursor') return;
        const target = e.currentTarget;
        const pinId = markerEl.dataset.pinId;
        if (!pinId) return;
        mapDragDraft = {
            mapId,
            pinId,
            markerEl,
            target,
            moved: false,
            startX: e.clientX,
            startY: e.clientY
        };
        e.preventDefault();
        return;
    }
    if (tool.type === 'cursor') {
        const vp = getMapViewport(mapId);
        mapPanDraft = {
            mapId,
            startX: e.clientX,
            startY: e.clientY,
            startTx: vp.tx,
            startTy: vp.ty,
            moved: false
        };
        return;
    }
    if (tool.type !== 'arrow') return;
    const target = e.currentTarget;
    const start = mapClientToLocal(e.clientX, e.clientY, target, mapId);
    const canvas = document.getElementById(`map-canvas-${mapId}`);
    mapArrowDraft = {
        mapId,
        startX: start.x,
        startY: start.y,
        target,
        canvas
    };
};

window.handleMapPointerMove = (e, mapId) => {
    if (mapDragDraft && String(mapDragDraft.mapId) === String(mapId)) {
        const { target, markerEl, startX, startY } = mapDragDraft;
        if (!target || !markerEl) return;
        const local = mapClientToLocal(e.clientX, e.clientY, target, mapId);
        markerEl.style.left = `${(local.x / local.width) * 100}%`;
        markerEl.style.top = `${(local.y / local.height) * 100}%`;
        if (!mapDragDraft.moved && Math.hypot(e.clientX - startX, e.clientY - startY) > 2) {
            mapDragDraft.moved = true;
        }
        return;
    }
    if (mapPanDraft && String(mapPanDraft.mapId) === String(mapId)) {
        const vp = getMapViewport(mapId);
        const dx = e.clientX - mapPanDraft.startX;
        const dy = e.clientY - mapPanDraft.startY;
        vp.tx = mapPanDraft.startTx + dx;
        vp.ty = mapPanDraft.startTy + dy;
        if (!mapPanDraft.moved && Math.hypot(dx, dy) > 2) mapPanDraft.moved = true;
        applyMapViewport(mapId);
        return;
    }
    if (!mapArrowDraft || String(mapArrowDraft.mapId) !== String(mapId)) return;
    const tool = store.getState().mapTool || {};
    const target = mapArrowDraft.target;
    const canvas = mapArrowDraft.canvas;
    if (!target || !canvas) return;
    const current = mapClientToLocal(e.clientX, e.clientY, target, mapId);
    const sx = mapArrowDraft.startX;
    const sy = mapArrowDraft.startY;
    const ex = current.x;
    const ey = current.y;
    const dx = ex - sx;
    const dy = ey - sy;
    const len = Math.max(14, Math.hypot(dx, dy));
    const ang = Math.atan2(dy, dx) * (180 / Math.PI);
    let preview = canvas.querySelector('.map-arrow-preview');
    if (!preview) {
        preview = document.createElement('div');
        preview.className = 'map-arrow-preview';
        preview.innerHTML = `<div class="map-arrow-visual"><span class="map-arrow-line-seg"></span><span class="map-arrow-head-glyph">></span></div>`;
        canvas.appendChild(preview);
    }
    preview.style.setProperty('--marker-color', tool.color || '#00d2ff');
    preview.style.left = `${(sx / current.width) * 100}%`;
    preview.style.top = `${(sy / current.height) * 100}%`;
    const visual = preview.querySelector('.map-arrow-visual');
    if (visual) {
        visual.style.width = `${len}px`;
        visual.style.transform = `rotate(${ang}deg)`;
    }
};

window.handleMapPointerUp = (e, mapId) => {
    if (mapDragDraft && String(mapDragDraft.mapId) === String(mapId)) {
        const { target, pinId, moved } = mapDragDraft;
        mapDragDraft = null;
        if (!target || !moved) return;
        const local = mapClientToLocal(e.clientX, e.clientY, target, mapId);
        const xPct = (local.x / local.width) * 100;
        const yPct = (local.y / local.height) * 100;
        const s = store.getState();
        const map = (s.mapas || []).find(m => String(m.id) === String(mapId));
        if (!map) return;
        const pins = (map.pins || []).map(p => String(p.id) === String(pinId) ? { ...p, x: xPct, y: yPct } : p);
        store.updateItem('mapas', mapId, { pins });
        mapIgnoreNextClick = true;
        return;
    }
    if (mapPanDraft && String(mapPanDraft.mapId) === String(mapId)) {
        const moved = mapPanDraft.moved;
        mapPanDraft = null;
        if (moved) mapIgnoreNextClick = true;
        return;
    }
    if (!mapArrowDraft || String(mapArrowDraft.mapId) !== String(mapId)) return;
    const target = mapArrowDraft.target;
    const local = mapClientToLocal(e.clientX, e.clientY, target, mapId);
    const sx = mapArrowDraft.startX;
    const sy = mapArrowDraft.startY;
    const ex = local.x;
    const ey = local.y;
    const dx = ex - sx;
    const dy = ey - sy;
    const len = Math.max(14, Math.hypot(dx, dy));
    const ang = Math.atan2(dy, dx) * (180 / Math.PI);

    const x = (sx / local.width) * 100;
    const y = (sy / local.height) * 100;
    const s = store.getState();
    const tool = s.mapTool || {};
    const map = (s.mapas || []).find(m => m.id == mapId);
    if (map) {
        const pin = {
            id: Date.now(),
            x, y,
            type: 'arrow',
            color: tool.color || '#00d2ff',
            size: Number(tool.size) || 26,
            label: tool.label || '',
            icon: tool.icon || '*',
            image: null,
            arrowDir: tool.arrowDir || 'right',
            arrowLength: Number(len.toFixed(1)),
            arrowAngle: Number(ang.toFixed(1))
        };
        store.updateItem('mapas', mapId, { pins: [...(map.pins || []), pin] });
    }

    const preview = mapArrowDraft.canvas?.querySelector('.map-arrow-preview');
    if (preview) preview.remove();
    mapArrowDraft = null;
};

window.handleMapWheel = (e, mapId) => {
    e.preventDefault();
    const target = e.currentTarget;
    if (!target) return;
    const rect = target.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    const vp = getMapViewport(mapId);
    const nextScale = vp.scale * (e.deltaY < 0 ? 1.1 : 0.9);
    zoomMapAtPoint(mapId, target, nextScale, px, py);
};

window.zoomMap = (e, mapId, direction) => {
    if (e) {
        e.preventDefault();
        e.stopPropagation();
    }
    const target = document.getElementById(`map-world-${mapId}`);
    if (!target) return;
    const rect = target.getBoundingClientRect();
    const anchorX = rect.width / 2;
    const anchorY = rect.height / 2;
    const vp = getMapViewport(mapId);
    const factor = direction > 0 ? 1.2 : (1 / 1.2);
    zoomMapAtPoint(mapId, target, vp.scale * factor, anchorX, anchorY);
};

window.addPin = (e, mapId) => {
    const target = e.currentTarget;
    if (e.target.closest('.map-marker')) return;
    const local = mapClientToLocal(e.clientX, e.clientY, target, mapId);
    const x = (local.x / local.width) * 100;
    const y = (local.y / local.height) * 100;
    const s = store.getState();
    const tool = s.mapTool || {};
    const map = (s.mapas || []).find(m => m.id == mapId);
    if (!map) return;
    if (tool.type === 'image' && !tool.image) {
        CustomDialog.confirm('Primero sube una imagen para colocarla en el mapa.');
        return;
    }
    const pin = {
        id: Date.now(),
        x, y,
        type: tool.type || 'pin',
        color: tool.color || '#00d2ff',
        size: Number(tool.size) || 26,
        label: tool.label || '',
        icon: tool.icon || '*',
        image: tool.image || null,
        arrowDir: tool.arrowDir || 'right'
    };
    const pins = [...(map.pins || []), pin];
    store.updateItem('mapas', mapId, { pins });
};

window.removeMapPin = (e, mapId, pinId) => {
    if (e) {
        e.preventDefault();
        e.stopPropagation();
    }
    const s = store.getState();
    const map = (s.mapas || []).find(m => String(m.id) === String(mapId));
    if (!map) return;
    const pins = (map.pins || []).filter(p => String(p.id) !== String(pinId));
    store.updateItem('mapas', mapId, { pins });
};

window.clearMapPins = (mapId) => {
    CustomDialog.confirm('Eliminar todos los marcadores de este mapa?').then(ok => {
        if (!ok) return;
        store.updateItem('mapas', mapId, { pins: [] });
    });
};

window.handleNetworkSubmit = (e) => {
    e.preventDefault();
    if (!canCreateForPlan('networks')) return;
    const p1 = document.getElementById('net-a')?.value?.trim();
    const p2 = document.getElementById('net-b')?.value?.trim();
    if (!p1 || !p2) return;
    store.addItem('network', { p1, p2 });
    document.getElementById('net-a').value = '';
    document.getElementById('net-b').value = '';
    changeView('network');
};

window.addField = async (id) => {
    const label = await CustomDialog.prompt('Nombre del campo:');
    if (label === false || !label) return;
    const value = await CustomDialog.prompt('Valor:');
    if (value === false) return;
    const s = store.getState();
    const item = (s.units || []).find(u => u.id == id);
    if (!item) return;
    const fields = [...(item.fields || []), { label, value }];
    store.updateItem('units', id, { fields });
};
window.handleTriviaSubmit = (e) => {
    e.preventDefault();
    const question = document.getElementById('tr-question').value;
    const options = [
        document.getElementById('tr-o1').value,
        document.getElementById('tr-o2').value,
        document.getElementById('tr-o3').value,
        document.getElementById('tr-o4').value
    ];
    const correct = document.getElementById('tr-correct').value;
    store.addItem('trivia', { question, options, correct });
    changeView('trivia');
};

window.handleTriviaOption = (id, choice, btn) => {
    const screen = document.querySelector('.trivia-tv-screen');
    if (!screen) return;
    if (screen.dataset.locked === '1') return;

    const buttons = Array.from(screen.querySelectorAll('.trivia-tv-options button'));
    buttons.forEach(b => { b.disabled = true; });
    screen.dataset.locked = '1';

    const correctRaw = (screen.dataset.correct || '').trim();
    const correctLetter = parseTriviaLetter(correctRaw);
    const isCorrect = choice === correctLetter || correctRaw.toUpperCase().includes(choice.toUpperCase());
    const feedback = document.getElementById('trivia-feedback');
    const answerIcon = document.getElementById('trivia-answer-icon');
    const chosenBtn = btn;
    const correctBtn = buttons.find(b => (b.dataset.choice || '').toUpperCase() === correctLetter);

    buttons.forEach(b => {
        b.classList.remove('is-correct', 'is-wrong');
    });
    if (chosenBtn) chosenBtn.classList.add(isCorrect ? 'is-correct' : 'is-wrong');
    if (!isCorrect && correctBtn) correctBtn.classList.add('is-correct');
    if (answerIcon) {
        answerIcon.src = isCorrect ? 'images/iconos/correcto.png' : 'images/iconos/INCORRECTO.png';
        answerIcon.classList.add('show');
    }

    if (feedback) {
        feedback.classList.remove('ok', 'fail');
        feedback.classList.add(isCorrect ? 'ok' : 'fail');
        feedback.textContent = isCorrect ? 'Correcto. Cambiando a la siguiente pregunta...' : `Incorrecto. Respuesta: ${correctRaw}`;
    }

    setTimeout(() => {
        screen.dataset.locked = '0';
        window.nextTriviaQuestion();
    }, TRIVIA_RESULT_MS);
};

window.resetTrivia = (id) => {
    triviaSession.index = 0;
    changeView('trivia');
};

window.nextTriviaQuestion = () => {
    const items = getTriviaList();
    if (!items.length) return;
    triviaSession.playStatic = true;
    triviaSession.index = (triviaSession.index + 1) % items.length;
    changeView('trivia');
};

window.prevTriviaQuestion = () => {
    const items = getTriviaList();
    if (!items.length) return;
    triviaSession.playStatic = true;
    triviaSession.index = (triviaSession.index - 1 + items.length) % items.length;
    changeView('trivia');
};

// â”€â”€ Kindle Reader Controls 
let _kindleFontSize = 18;
let _kindlePageWidth = 1;
let _kindlePageTotal = 1;
let _kindleUpdateInfo = null;
let _kindleProgressPubId = null;

window.kindleFontSize = (delta) => {
    _kindleFontSize = Math.min(26, Math.max(13, _kindleFontSize + delta));
    const wrap = document.getElementById('kindle-wrap');
    if (wrap) wrap.style.setProperty('--k-size', _kindleFontSize + 'px');
    setTimeout(() => {
        if (typeof _kindleUpdateInfo === 'function') _kindleUpdateInfo();
    }, 80);
};

window.kindleTheme = (t) => {
    const wrap = document.getElementById('kindle-wrap');
    if (!wrap) return;
    wrap.classList.remove('dark', 'white');
    if (t === 'dark') wrap.classList.add('dark');
    if (t === 'white') wrap.classList.add('white');
};

window.kindlePageFlip = (delta) => {
    console.log('[Reader] Flipping page:', delta);
    const container = document.querySelector('.book-container');
    if (!container) { console.warn('[Reader] No .book-container found'); return; }
    if (typeof _kindleUpdateInfo === 'function') _kindleUpdateInfo();
    const width = Math.max(1, _kindlePageWidth || container.clientWidth || 1);
    const currentPage = Math.round(container.scrollLeft / width);
    const nextPage = Math.max(0, Math.min((_kindlePageTotal || 1) - 1, currentPage + delta));
    container.scrollTo({ left: nextPage * width, behavior: 'smooth' });
};

// Global key handler to avoid duplication
const _kindleKeyHandler = (e) => {
    const container = document.querySelector('.book-container');
    if (!container) return;
    if (e.key === 'ArrowRight') kindlePageFlip(1);
    if (e.key === 'ArrowLeft') kindlePageFlip(-1);
};
window.removeEventListener('keydown', _kindleKeyHandler);
window.addEventListener('keydown', _kindleKeyHandler);

const _kindleReaderSetup = () => {
    console.log('[Reader] Setting up reader...');
    const container = document.querySelector('.book-container');
    const numEl = document.getElementById('k-page-num');
    const totalEl = document.getElementById('k-page-total');

    if (!container) {
        console.warn('[Reader] No container found for setup, retrying...');
        return;
    }

    const syncProgress = (pageNum, pageTotal) => {
        const targetId = _kindleProgressPubId || Number(container.dataset.pubId || 0);
        if (!targetId) return;
        const index = Math.max(0, Number(pageNum || 1) - 1);
        const total = Math.max(1, Number(pageTotal || 1));
        const percent = total <= 1 ? 0 : Math.round((index / (total - 1)) * 100);
        savePublicationProgress(targetId, { percent, page: pageNum, total });
    };

    const updateInfo = () => {
        const viewportWidth = Math.max(1, container.clientWidth || 1);
        const pageTotal = Math.max(1, Math.ceil((container.scrollWidth || viewportWidth) / viewportWidth));
        // Spread jumps across full scroll range so the last page reaches the end.
        const pageWidth = pageTotal > 1 ? Math.max(1, (container.scrollWidth - viewportWidth) / (pageTotal - 1)) : viewportWidth;
        _kindlePageTotal = pageTotal;
        _kindlePageWidth = pageWidth;
        const pageNum = Math.max(1, Math.min(pageTotal, Math.round(container.scrollLeft / pageWidth) + 1));
        if (numEl) numEl.textContent = pageNum;
        if (totalEl) totalEl.textContent = `Paginas: ${pageTotal}`;
        syncProgress(pageNum, pageTotal);
    };
    _kindleUpdateInfo = updateInfo;

    updateInfo();
    if (!container.dataset.readerBound) {
        container.addEventListener('scroll', updateInfo, { passive: true });
        container.dataset.readerBound = '1';
    }
    if (!window.__kindleResizeBound) {
        window.addEventListener('resize', () => {
            if (typeof _kindleUpdateInfo === 'function') _kindleUpdateInfo();
        }, { passive: true });
        window.__kindleResizeBound = true;
    }

    // Restore where the user stopped reading.
    const saved = getPublicationProgressMap()[String(_kindleProgressPubId || Number(container.dataset.pubId || 0))] || null;
    if (saved && Number(saved.total) > 1 && Number(saved.page) > 0) {
        const pageTarget = Math.max(1, Math.min(Number(saved.total), Number(saved.page)));
        container.scrollLeft = Math.max(0, (pageTarget - 1) * _kindlePageWidth);
    } else {
        container.scrollLeft = 0;
    }
    updateInfo();
};

window.previewPubCover = (input) => {
    const preview = document.getElementById('pub-cover-preview');
    if (!preview) return;
    const file = input.files?.[0];
    if (!file) { preview.style.display = 'none'; return; }
    const reader = new FileReader();
    reader.onload = (e) => {
        preview.style.display = 'block';
        preview.style.backgroundImage = `url(${e.target.result})`;
    };
    reader.readAsDataURL(file);
};

window.handlePublicacionSubmit = async (e) => {
    e.preventDefault();
    const editId = Number(document.getElementById('pub-edit-id')?.value || 0);
    const existingCover = document.getElementById('pub-existing-cover')?.value || '';
    const title = document.getElementById('pub-title')?.value?.trim();
    const author = document.getElementById('pub-author')?.value?.trim() || 'Anónimo';
    const genre = document.getElementById('pub-genre')?.value || '';
    const desc = document.getElementById('pub-desc')?.value?.trim() || '';
    const content = document.getElementById('pub-content')?.value?.trim() || '';
    const cover_file = document.getElementById('pub-cover')?.files?.[0] || null;
    let cover_url = existingCover;
    if (cover_file) {
        cover_url = await readFileAsDataURL(cover_file);
    }
    const btn = document.getElementById('pub-submit-btn');
    const statusEl = document.getElementById('pub-status');

    const showStatus = (msg, ok = false) => {
        if (!statusEl) return;
        statusEl.style.display = 'block';
        statusEl.style.background = ok ? 'rgba(16,185,129,0.15)' : 'rgba(239,68,68,0.15)';
        statusEl.style.color = ok ? '#10b981' : '#ef4444';
        statusEl.style.border = `1px solid ${ok ? '#10b98133' : '#ef444433'}`;
        statusEl.textContent = msg;
    };

    if (!title) { showStatus('El título es obligatorio.'); return; }
    if (!content) { showStatus('Debes escribir algo de contenido.'); return; }

    if (btn) { btn.disabled = true; btn.textContent = editId ? 'Guardando...' : 'Publicando...'; }
    try {
        const token = await getCsrfToken();
        const action = editId ? 'update' : 'publish';
        const res = await fetch('php/publications.php', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token },
            body: JSON.stringify({
                action,
                publication_id: editId || undefined,
                title,
                author,
                genre,
                description: desc,
                content,
                cover_url
            })
        });
        const data = await res.json();
        if (!data.success) { showStatus(data.message || (editId ? 'Error al actualizar.' : 'Error al publicar.')); return; }
        showStatus(editId ? 'Cambios guardados con éxito. Redirigiendo...' : '¡Obra publicada con éxito! Redirigiendo...', true);
        await loadCommunityPubs();
        store.setState({ _pubEditing: null });
        setTimeout(() => changeView('publicaciones'), 1200);
    } catch (err) {
        showStatus('Error de conexión con el servidor.');
        console.error(err);
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = editId ? 'GUARDAR CAMBIOS' : 'PUBLICAR EN LA BIBLIOTECA'; }
    }
};

// â”€â”€ Community Publications â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const loadCommunityPubs = async () => {
    try {
        const res = await fetch('php/publications.php?action=list', { credentials: 'same-origin' });
        const data = await res.json();
        if (data.success) {
            store.setState({ _communityPubs: data.publications, _pubsLoaded: true });
        }
    } catch (err) {
        console.warn('[Publications] Could not load community pubs:', err);
    }
};

window.startNewPublication = () => {
    store.setState({ _pubEditing: null, currentView: 'publicar_obra' });
};

window.openEditCommunityPub = async (pubId) => {
    try {
        const myUserId = store.getState()?._myUserId;
        if (!myUserId) {
            CustomDialog.confirm('Debes iniciar sesión para editar publicaciones.');
            return;
        }
        const res = await fetch(`php/publications.php?action=get&id=${pubId}`, { credentials: 'same-origin' });
        const data = await res.json();
        if (!data.success || !data.publication) {
            CustomDialog.confirm(data.message || 'No se pudo cargar la publicación.');
            return;
        }
        const pub = data.publication;
        if (String(pub.user_id) !== String(myUserId)) {
            CustomDialog.confirm('Solo puedes editar publicaciones que tú subiste.');
            return;
        }
        store.setState({ _pubEditing: pub, currentView: 'publicar_obra' });
    } catch (err) {
        console.error(err);
        CustomDialog.confirm('No se pudo abrir el editor de publicación.');
    }
};

window.openObraDetalle = async (pubId) => {
    store.setState({ currentView: 'obra_detalle', _detallePub: null, _myPubRating: 0 });
    _kindleProgressPubId = Number(pubId || 0) || null;
    try {
        const res = await fetch(`php/publications.php?action=get&id=${pubId}`, { credentials: 'same-origin' });
        const data = await res.json();
        if (data.success) {
            store.setState({ _detallePub: data.publication, _myPubRating: data.myRating || 0 });
            // Let it render, then setup the pagination
            setTimeout(_kindleReaderSetup, 300);
        }
    } catch (err) {
        console.warn('[Publications] Could not load obra detail:', err);
    }
};

window.rateCommunityPub = async (pubId, stars) => {
    try {
        const res = await fetch('php/publications.php', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'rate', publication_id: pubId, stars })
        });
        const data = await res.json();
        if (data.success) {
            const current = store.getState()._detallePub;
            if (current && String(current.id) === String(pubId)) {
                store.setState({
                    _myPubRating: stars,
                    _detallePub: { ...current, avg_rating: data.avg_rating, rating_count: data.rating_count }
                });
            }
        } else {
            CustomDialog.confirm(data.message || 'No se pudo calificar.');
        }
    } catch (err) {
        console.warn('[Publications] Rating error:', err);
    }
};

window.deleteCommunityPub = async (pubId) => {
    const ok = await CustomDialog.confirm('¿Eliminar esta publicación? Esta acción no se puede deshacer.');
    if (!ok) return;
    try {
        const token = await getCsrfToken();
        const res = await fetch('php/publications.php', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token },
            body: JSON.stringify({ action: 'delete', publication_id: pubId })
        });
        const data = await res.json();
        if (data.success) {
            await loadCommunityPubs();
        } else {
            CustomDialog.confirm(data.message || 'No se pudo eliminar.');
        }
    } catch (err) {
        console.warn('[Publications] Delete error:', err);
    }
};

window.toggleIAAssist = () => {
    CustomDialog.prompt('CHATEA CON NARRATIVA AI:', 'En que puedo ayudarte con tu historia hoy?').then(val => {
        if (val) {
            CustomDialog.confirm('IA: Analizando tramas... Sugerencia: El personaje secundario podra tener una motivacin oculta relacionada con el Mapa del Mundo.').then(() => {
                console.log('IA interaction logged.');
            });
        }
    });
};

// --- COLLECTION HANDLERS ---
window.handleColeccionSubmit = async (e) => {
    e.preventDefault();
    if (!canCreateForPlan('collections')) return;
    const name = document.getElementById('col-name')?.value;
    const desc = document.getElementById('col-desc')?.value;
    store.addItem('Colecciones', { name, desc, image: null, items: [] });
    changeView('Colecciones');
};

window.handleColeccionItemSubmit = async (e, colId) => {
    e.preventDefault();
    const name = document.getElementById(`ci-name-${colId}`)?.value;
    const imageFile = document.getElementById(`ci-image-${colId}`)?.files?.[0];
    const checked = document.getElementById(`ci-check-${colId}`)?.checked || false;

    if (!name) return;

    const image = imageFile ? await readFileAsDataURL(imageFile) : null;

    const s = store.getState();
    const col = (s.Colecciones || []).find(c => c.id == colId);
    if (!col) return;

    const items = [...(col.items || []), { id: Date.now(), name, image, checked }];
    store.updateItem('Colecciones', colId, { items });

    // Reset form
    document.getElementById(`ci-name-${colId}`).value = '';
    document.getElementById(`ci-image-${colId}`).value = '';
    document.getElementById(`ci-check-${colId}`).checked = false;
};

window.toggleColeccionItem = (colId, itemId) => {
    const s = store.getState();
    const col = (s.Colecciones || []).find(c => c.id == colId);
    if (!col) return;

    const items = (col.items || []).map(it =>
        it.id == itemId ? { ...it, checked: !it.checked } : it
    );
    store.updateItem('Colecciones', colId, { items });
};

window.handleColeccionItemEdit = (colId, itemId) => {
    const s = store.getState();
    const col = (s.Colecciones || []).find(c => c.id == colId);
    if (!col) return;

    const item = (col.items || []).find(it => it.id == itemId);
    if (!item) return;

    const modal = document.getElementById('creation-modal');
    document.getElementById('modal-title').textContent = 'Editar Elemento de Colección';
    document.getElementById('m-name').value = item.name || '';
    document.getElementById('m-desc').value = item.desc || ''; // Collections items might not have desc, but good to have
    document.getElementById('m-image').value = '';
    document.getElementById('edit-id').value = itemId;
    document.getElementById('edit-parent-id').value = colId;
    document.getElementById('edit-context').value = 'ColeccionItem';

    // Hide Type select as it's not needed for sub-items
    const typeSelect = document.getElementById('m-type');
    // const typeWrapper = typeSelect.closest('div'); // ERROR: This hides the whole modal content!
    typeSelect.style.display = 'none';

    // Show Delete Button
    const btnDel = document.getElementById('btn-delete-item');
    if (btnDel) {
        btnDel.style.display = 'inline-block';
        btnDel.onclick = () => {
            CustomDialog.confirm('¿Eliminar este elemento?').then(ok => {
                if (ok) {
                    const items = (col.items || []).filter(it => it.id != itemId);
                    store.updateItem('Colecciones', colId, { items });
                    modal.style.display = 'none';
                }
            });
        };
    }

    modal.style.display = 'flex';
};

window.handleGenealogySubmit = (e) => {
    e.preventDefault();
    if (!canCreateForPlan('trees')) return;
    const name = document.getElementById('gen-name')?.value?.trim();
    const desc = document.getElementById('gen-desc')?.value?.trim();
    if (!name) return;
    store.addItem('genealogy', { name, desc: desc || '', members: [] });
    changeView('genealogy');
};

window.handleGenealogyMemberSubmit = async (e, treeId) => {
    e.preventDefault();
    const nameEl = document.getElementById(`gm-name-${treeId}`);
    const roleEl = document.getElementById(`gm-role-${treeId}`);
    const parentEl = document.getElementById(`gm-parent-${treeId}`);
    const imageEl = document.getElementById(`gm-image-${treeId}`);
    const name = nameEl?.value?.trim();
    if (!name) return;
    const role = roleEl?.value?.trim() || '';
    const parentId = parentEl?.value || '';
    const imageFile = imageEl?.files?.[0];
    const image = imageFile ? await readFileAsDataURL(imageFile) : null;
    const s = store.getState();
    const tree = (s.genealogy || []).find(g => String(g.id) === String(treeId));
    if (!tree) return;
    const members = [...(tree.members || []), {
        id: `gm_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
        name,
        role,
        parentId,
        image
    }];
    store.updateItem('genealogy', treeId, { members });
    if (nameEl) nameEl.value = '';
    if (roleEl) roleEl.value = '';
    if (parentEl) parentEl.value = '';
    if (imageEl) imageEl.value = '';
};

window.removeGenealogyMember = (treeId, memberId) => {
    CustomDialog.confirm('Eliminar miembro del arbol?').then(ok => {
        if (!ok) return;
        const s = store.getState();
        const tree = (s.genealogy || []).find(g => String(g.id) === String(treeId));
        if (!tree) return;
        const members = (tree.members || [])
            .map(m => String(m.parentId || '') === String(memberId) ? { ...m, parentId: '' } : m)
            .filter(m => String(m.id) !== String(memberId));
        store.updateItem('genealogy', treeId, { members });
    });
};

// --- STORYBOARD HANDLERS ---
window.handleStoryboardEditClick = async (id) => {
    const s = store.getState();
    const item = (s.storyboard || []).find(st => st.id == id);
    if (!item) return;
    const res = await CustomDialog.promptWithFile('Editar storyboard (nombre):', item.name || '');
    if (res === false) return;
    const next = {};
    if (typeof res.value === 'string' && res.value.trim()) next.name = res.value.trim();
    if (res.file) next.image = await readFileAsDataURL(res.file);
    const desc = await CustomDialog.prompt('Descripcion:', item.desc || '');
    if (desc !== false) next.desc = desc;
    if (Object.keys(next).length) store.updateItem('storyboard', id, next);
};

// --- TIER HANDLERS ---
window.handleTierSubmit = async (e) => {
    e.preventDefault();
    const name = document.getElementById('tier-name')?.value;
    const itemsRaw = document.getElementById('tier-items')?.value;
    const imageFile = document.getElementById('tier-image')?.files?.[0];
    const viewMode = document.getElementById('tier-view-mode')?.value === 'iceberg' ? 'iceberg' : 'tier';
    const limitKey = viewMode === 'iceberg' ? 'icebergs' : 'tiers';
    if (!canCreateForPlan(limitKey)) return;

    if (!name) return;

    const items = listToItems(itemsRaw);
    const image = imageFile ? await readFileAsDataURL(imageFile) : null;
    const newTier = {
        name,
        image,
        viewMode,
        rows: buildDefaultTierRows(),
        pool: items.map((it, idx) => ({
            id: 'item_' + Date.now() + '_' + idx,
            name: it,
            image: null
        }))
    };

    store.addItem('tiers', newTier);
    changeView('tiers');
};

// --- FOLDER HANDLERS ---
window.promptCreateFolder = async () => {
    const name = await CustomDialog.prompt('Nombre de la carpeta:');
    if (name === false || !name) return;
    ensureFolder(name);
};

window.promptDeleteFolder = async () => {
    const s = store.getState();
    const folders = s.folders || [];
    if (!folders.length) {
        CustomDialog.confirm('No hay carpetas para eliminar.');
        return;
    }
    const options = folders.map(f => ({ value: f.id, label: f.name }));
    const folderId = await CustomDialog.selectPrompt('Selecciona carpeta a eliminar:', options);
    if (folderId === false) return;

    const ok = await CustomDialog.confirm('Eliminar esta carpeta? Los elementos NO se eliminaran, solo la carpeta.');
    if (!ok) return;

    store.setState({ folders: folders.filter(f => String(f.id) !== String(folderId)) });
};

window.handleFolderAssign = async (e, key, id) => {
    e.stopPropagation();
    const s = store.getState();
    const folders = s.folders || [];

    const folderName = await CustomDialog.prompt('Nombre de carpeta (nueva o existente):');
    if (folderName === false || !folderName) return;

    const folder = ensureFolder(folderName);
    if (!folder) return;

    store.updateItem(key, id, { folderId: folder.id });
};

window.handleLogout = async () => {
    try {
        await saveStateToServer();
        let token = '';
        try {
            const csrfRes = await fetch('php/csrf.php', { credentials: 'same-origin' });
            const csrfData = await csrfRes.json();
            if (csrfData && csrfData.success && csrfData.token) token = csrfData.token;
        } catch (err) {
            console.warn('[AUTH] CSRF token for logout not available.', err);
        }

        await fetch('php/auth.php', {
            method: 'POST',
            credentials: 'same-origin',
            headers: {
                'Content-Type': 'application/json',
                ...(token ? { 'X-CSRF-Token': token } : {})
            },
            body: JSON.stringify({ action: 'logout' })
        });
    } catch (err) {
        console.warn('[AUTH] Logout request failed, continuing local cleanup.', err);
    } finally {
        window.location.href = 'login.html';
    }
};

window.onload = async () => {
    await loadSessionUser();
    await loadStateFromServer({ silent: false });
    // In case loadStateFromServer skipped loading merch due to some reason
    if (!(store.getState().merch || []).length) {
        await loadGlobalMerch();
    }
    await retryInitialServerLoad();
    await loadSubscriptionStatus();
    initApp();
    window.closeMobileSidebar();
    serverSyncEnabled = true;
    scheduleLocalBackup();
    store.subscribe(() => {
        scheduleServerSave();
    });

    window.addEventListener('resize', () => {
        if (window.innerWidth > 980) window.closeMobileSidebar();
    }, { passive: true });
    window.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') window.closeMobileSidebar();
    });

    // Safety net: periodic sync and save on tab close/blur.
    setInterval(() => {
        saveStateToServer();
    }, 15000);

    window.addEventListener('beforeunload', () => {
        saveStateToServer();
    });
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') {
            saveStateToServer();
        }
    });
};














































