import { store } from './state.js';

const renderActions = (key, id) => `
    <div style="display:flex; gap:10px;">
        <button class="btn-edit f-button glass" data-key="${key}" data-id="${id}" style="font-size:0.6rem; padding:8px 12px; background:rgba(255,255,255,0.05);">EDITAR</button>
        <button class="btn-delete f-button" data-key="${key}" data-id="${id}" style="font-size:0.6rem; padding:8px 12px; background:#ff3e3e;">BORRAR</button>
    </div>
`;

export const routes = {
    formato: {
        title: 'Formato / Universo',
        render: (state) => `
            <div class="glass" style="padding: 4rem; border-radius: 30px;">
                <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 30px;">
                    <div>
                        <label style="display:block; margin-bottom:15px; font-weight:800; font-size:0.8rem; color:var(--accent-secondary);">UNIVERSO</label>
                        <input type="text" id="inp-universo" class="f-input" value="${state.formato?.universo || ''}" placeholder="Ej: Cyberpunk 2077">
                    </div>
                    <div>
                        <label style="display:block; margin-bottom:15px; font-weight:800; font-size:0.8rem; color:var(--accent-secondary);">GENERO PRINCIPAL</label>
                        <input type="text" id="inp-genero" class="f-input" value="${state.formato?.genero || ''}" placeholder="Ej: Ciencia Ficcion">
                    </div>
                </div>
                <button class="f-button" id="btn-save-formato" style="margin-top:40px; width:100%;">GUARDAR ESTRUCTURA MAESTRA</button>
            </div>
        `
    },
    identidad: {
        title: 'Identidad Visual',
        render: () => `
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 40px;">
                <div class="glass" style="padding: 3rem; border-radius:30px; text-align:center;">
                    <h3 style="margin-bottom:2rem;">LOGO DEL PROYECTO</h3>
                    <div style="width:100%; height:200px; border:2px dashed rgba(255,255,255,0.1); margin-bottom:2rem; border-radius:20px; display:flex; align-items:center; justify-content:center; background:rgba(0,0,0,0.2);">
                        <span style="color:var(--text-muted);">ARRASTRA TU LOGOTIPO AQUI</span>
                    </div>
                    <button class="f-button glass" style="width:100%; background:transparent; border:1px solid var(--accent-primary);">EXPLORAR ARCHIVOS</button>
                </div>
                <div class="glass" style="padding: 3rem; border-radius:30px;">
                    <h3 style="margin-bottom:2rem;">PALETA DE COLORIMETRIA</h3>
                    <div style="display:grid; grid-template-columns: repeat(3, 1fr); gap:20px;">
                        <div style="aspect-ratio:1/1; background:var(--accent-primary); border-radius:15px; box-shadow:0 10px 20px rgba(138,79,255,0.3);"></div>
                        <div style="aspect-ratio:1/1; background:var(--accent-secondary); border-radius:15px; box-shadow:0 10px 20px rgba(0,210,255,0.3);"></div>
                        <div style="aspect-ratio:1/1; background:#ff3e3e; border-radius:15px; box-shadow:0 10px 20px rgba(255,62,62,0.3);"></div>
                    </div>
                    <button class="f-button" style="width:100%; margin-top:2rem; background:#444;">ANADIR MUESTRA</button>
                </div>
            </div>
        `
    },
    reglas: {
        title: 'Reglas Universales & Coherencia',
        render: (state) => `
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 40px;">
                <div class="glass" style="padding: 3rem; border-radius:30px;">
                    <h3 style="color:var(--accent-primary); margin-bottom:2rem;">Leyes del Mundo</h3>
                    <button class="f-button" id="btn-add-regla-univ" style="width:100%; margin-bottom:2rem;">+ NUEVA REGLA UNIVERSAL</button>
                    ${(state.reglasUniversales || []).map(r => `
                        <div class="f-card glass" style="display:flex; justify-content:space-between; align-items:center;">
                            <span style="font-weight:600;">${r.name}</span>
                            ${renderActions('reglasUniversales', r.id)}
                        </div>
                    `).join('')}
                    ${(state.reglasUniversales || []).length === 0 ? '<div class="dev-msg">No hay leyes registradas.</div>' : ''}
                </div>
                <div class="glass" style="padding: 3rem; border-radius:30px;">
                    <h3 style="color:var(--accent-secondary); margin-bottom:2rem;">Reglas de Guion</h3>
                    <button class="f-button" id="btn-add-regla-int" style="width:100%; background:#10b981; margin-bottom:2rem;">+ NUEVA REGLA INTERNA</button>
                    ${(state.reglasInternas || []).map(r => `
                        <div class="f-card glass" style="display:flex; justify-content:space-between; align-items:center;">
                            <span style="font-weight:600;">${r.name}</span>
                            ${renderActions('reglasInternas', r.id)}
                        </div>
                    `).join('')}
                    ${(state.reglasInternas || []).length === 0 ? '<div class="dev-msg">No hay reglas de coherencia.</div>' : ''}
                </div>
            </div>
        `
    },

    unidades: {
        title: 'Casting Maestro',
        render: (state) => `
            <div>
                <div style="display: flex; gap: 20px; margin-bottom: 4rem;">
                    <button class="f-button" id="btn-add-personaje">+ ANADIR PERSONAJE</button>
                    <button class="f-button" id="btn-add-lugar" style="background: #10b981;">+ ANADIR ESCENARIO</button>
                </div>
                <div id="units-list" class="card-grid">
                    ${(state.unidades || []).map((u, index) => `
                        <div class="unit-card" style="animation-delay: ${index * 0.1}s">
                            ${u.image ?
                `<div class="card-avatar" style="background: url(${u.image}) center center/cover; width:200px; height:200px;"></div>` :
                `<div class="card-avatar">${u.name ? u.name.charAt(0) : '?'}</div>`
            }
                            <div class="card-info">
                                <span class="tool-tag">${u.type === 'Personaje' ? 'PERSONAJE' : 'LOCACION'}</span>
                                <h3>${u.name || 'Sin nombre'}</h3>
                                <button class="f-button btn-view-ficha glass" data-id="${u.id}" style="font-size:0.7rem; margin-top:15px; background:rgba(0,210,255,0.1); border:1px solid var(--accent-secondary);">ABRIR EXPEDIENTE</button>
                            </div>
                            <div class="card-actions">
                                <button class="btn-edit" data-key="unidades" data-id="${u.id}" style="color:var(--accent-secondary); background:none; border:none; cursor:pointer; font-weight:800;">EDITAR</button>
                                <button class="btn-delete" data-key="unidades" data-id="${u.id}" style="color:#ff3e3e; background:none; border:none; cursor:pointer; font-weight:800;">BORRAR</button>
                            </div>
                        </div>
                    `).join('')}
                    ${(state.unidades || []).length === 0 ? '<div class="dev-msg" style="grid-column:1/-1;">El casting esta vacio. Anade tu primer protagonista.</div>' : ''}
                </div>
            </div>
        `
    },
    red: {
        title: 'Red de Relaciones',
        render: (state) => `
            <div class="glass" style="padding: 4rem; border-radius:30px;">
                <button class="f-button" id="btn-add-network" style="margin-bottom:3rem; width:100%;">+ FORJAR NUEVO VINCULO NARRATIVO</button>
                <div id="network-list">
                    ${(state.network || []).map(n => `
                        <div class="f-card glass" style="display:flex; justify-content:space-between; align-items:center; padding:2.5rem;">
                            <div style="font-size:1.2rem;">- <strong>${n.p1}</strong> <span style="color:var(--accent-primary); margin:0 20px;">-></span> <strong>${n.p2}</strong> <span style="background:var(--accent-secondary); color:#000; padding:4px 12px; border-radius:50px; font-size:0.7rem; font-weight:900; margin-left:20px; vertical-align:middle;">${n.type?.toUpperCase()}</span></div>
                            ${renderActions('network', n.id)}
                        </div>
                    `).join('')}
                </div>
            </div>
        `
    },
    timeline: {
        title: 'Cronologia de Eventos',
        render: (state) => `
            <div class="glass" style="padding: 4rem; border-radius:30px;">
                <button class="f-button" id="btn-add-timeline" style="margin-bottom:3rem;">+ INSERTAR HITO TEMPORAL</button>
                <div id="timeline-list" style="position:relative; padding-left:40px; border-left:2px solid var(--border-glass);">
                    ${(state.timeline || []).map(e => `
                        <div class="f-card glass" style="margin-bottom:20px; display:flex; justify-content:space-between; align-items:center;">
                            <strong style="font-size:1.1rem; color:var(--accent-secondary);">${e.name}</strong>
                            ${renderActions('timeline', e.id)}
                        </div>
                    `).join('')}
                </div>
            </div>
        `
    },
    elementos: {
        title: 'Inventario de Objetos',
        render: (state) => `
            <div>
                <button class="f-button" id="btn-add-objeto" style="margin-bottom:4rem;">+ REGISTRAR OBJETO CLAVE</button>
                <div class="card-grid">
                    ${(state.elementos || []).map(el => `
                        <div class="f-card glass" style="height:300px; display:flex; flex-direction:column;">
                            <h4 style="color:var(--accent-primary); font-size:1.4rem;">${el.name}</h4>
                            <p style="font-size:0.9rem; margin:20px 0; color:var(--text-secondary); flex:1;">${el.desc}</p>
                            ${renderActions('elementos', el.id)}
                        </div>
                    `).join('')}
                </div>
            </div>
        `
    },
    guion: {
        title: 'Guion Tecnico y Literario',
        render: (state) => `
            <div class="glass" style="padding:4rem; border-radius:30px;">
                <textarea id="main-guion" style="width:100%; height:75vh; background:rgba(0,0,0,0.3); border:1px solid var(--border-glass); color:#ccc; font-family:'Courier New', monospace; font-size:1.1rem; padding:3rem; border-radius:20px; resize:none; line-height:1.8;" placeholder="ESCENA 1. INTERIOR - DA...">${state.guion || ''}</textarea>
                <button class="f-button" id="btn-save-guion" style="margin-top:30px; width:100%;">GUARDAR SECUENCIA ACTUAL</button>
            </div>
        `
    },
    storyboard: {
        title: 'Storyboard Detallado',
        render: (state) => `
            <div>
                <button class="f-button" id="btn-add-storyboard" style="margin-bottom:4rem;">+ NUEVA VINETA VISUAL</button>
                <div class="card-grid">
                    ${(state.storyboard || []).map(s => `
                        <div class="glass" style="padding:1.5rem; border-radius:25px;">
                            <div style="aspect-ratio:16/9; background:#000; border-radius:15px; margin-bottom:1.5rem; display:flex; align-items:center; justify-content:center; color:#333; font-weight:900; font-size:2rem;">#${s.num}</div>
                            <p style="font-weight:600; margin-bottom:1rem;">${s.desc}</p>
                            ${renderActions('storyboard', s.id)}
                        </div>
                    `).join('')}
                </div>
            </div>
        `
    },
    manual_narrativa: {
        title: 'Academia Narrativa',
        render: () => `
            <div class="glass" style="padding:4rem; border-radius:30px; overflow-y:auto; max-height:80vh;">
                <h2 style="color:var(--accent-secondary); margin-bottom:3rem;">HERRAMIENTAS DE GUION</h2>
                <div style="display:grid; grid-template-columns: 1fr 1fr; gap:40px;">
                    <div class="f-card glass">
                        <h4 style="color:var(--accent-primary);">EL MACGUFFIN</h4>
                        <p style="font-size:0.9rem; color:var(--text-secondary);">Recurso para impulsar la trama. Un objeto o proposito que mueve a los personajes pero cuya importancia real es nula.</p>
                    </div>
                </div>
            </div>
        `
    },
    manual_montaje: {
        title: 'Teoria del Montaje',
        render: () => `<div class="glass" style="padding:4rem;"><h2>EL ARTE DEL CORTE</h2></div>`
    },
    post_produccion: {
        title: 'Post-Produccion',
        render: () => `<div class="glass" style="padding:4rem;"><h3>CONTINUIDAD Y RESULTADOS</h3></div>`
    },
    ficha_detalle: {
        title: 'Expediente Confidencial',
        render: (state, id) => {
            const char = (state.unidades || []).find(u => u.id == id);
            return `
                <div class="glass" style="padding:5rem; border-radius:40px;">
                    <button id="btn-back-casting" class="f-button glass" style="background:rgba(255,255,255,0.05); margin-bottom:3rem;">VOLVER</button>
                    <h2 style="font-size:3rem; margin-bottom:3rem; color:white;">PERFIL: ${char ? char.name.toUpperCase() : 'DESCONOCIDO'}</h2>
                    <div style="display:grid; grid-template-columns: repeat(3, 1fr); gap:30px;">
                        <input class="f-input" placeholder="Personalidad">
                        <input class="f-input" placeholder="Traumas">
                        <input class="f-input" placeholder="Valores">
                    </div>
                    <button class="f-button" style="width:100%; margin-top:40px;">ACTUALIZAR EXPEDIENTE MAESTRO</button>
                </div>
            `;
        }
    }
};

export function initRouter() {
    console.log('[ROUTER] Initializing...');
    const viewContainer = document.getElementById('view-container');
    const viewTitle = document.getElementById('active-tool-title');
    const navPanel = document.getElementById('tool-nav');

    if (!viewContainer || !viewTitle) {
        console.error('[ROUTER] Missing core DOM elements!');
        return;
    }

    const render = (viewName, params = null) => {
        try {
            console.log('[ROUTER] Rendering:', viewName);
            const route = routes[viewName] || routes.formato;
            const state = store.getState();

            viewTitle.textContent = route.title;
            viewContainer.innerHTML = (viewName === 'ficha_detalle') ?
                route.render(state, params) :
                route.render(state);

            // Update Nav visual indicators
            if (navPanel) {
                const navItems = navPanel.querySelectorAll('li[data-view]');
                navItems.forEach(item => {
                    item.classList.toggle('active', item.dataset.view === viewName);
                });
            }
        } catch (e) {
            console.error('[ROUTER] Error during render:', e);
            viewContainer.innerHTML = `<div class="dev-msg" style="color:#ff3e3e;">[SYSTEM ERROR] Fallo al renderizar la vista: ${e.message}</div>`;
        }
    };

    store.subscribe((state) => {
        if (state.currentView !== 'ficha_detalle') {
            render(state.currentView);
        }
    });

    // Initial render
    render(store.getState().currentView);
}

