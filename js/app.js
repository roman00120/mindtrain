import { store } from './state.js';
import { initRouter, routes } from './router.js';

/**
 * Narrativa Bible - Robust Logic Layer
 */
document.addEventListener('DOMContentLoaded', () => {
    console.log('[SYSTEM] Initializing Narrativa Bible...');

    try {
        initRouter();
    } catch (e) {
        console.error('[CRITICAL] Router failed to initialize:', e);
    }

    // --- CONTEXT-AWARE CLICK DELEGATION ---
    document.addEventListener('click', (e) => {
        const target = e.target;

        // 1. NAVIGATION (Sidebar clicks)
        const navItem = target.closest('li[data-view]');
        if (navItem) {
            const view = navItem.dataset.view;
            console.log('[NAV] Switching to:', view);
            store.setState({ currentView: view });
            return; // Navigation handled
        }

        // 2. MODAL OPENERS (Universal detector)
        const addBtn = target.closest('[id^="btn-add-"]');
        if (addBtn) {
            const id = addBtn.id;
            const modal = document.getElementById('creation-modal');
            const typeSelect = document.getElementById('m-type');

            if (modal && typeSelect) {
                // Logic based on button ID
                if (id === 'btn-add-personaje' || id === 'btn-add-lugar') {
                    typeSelect.value = (id === 'btn-add-personaje' ? 'Personaje' : 'Lugar');
                    modal.style.display = 'flex';
                } else if (id === 'btn-add-regla-univ') {
                    const val = prompt('Nueva Regla Universal:');
                    if (val) store.addItem('reglasUniversales', { name: val });
                } else if (id === 'btn-add-regla-int') {
                    const val = prompt('Nueva Regla de Coherencia:');
                    if (val) store.addItem('reglasInternas', { name: val });
                } else if (id === 'btn-add-timeline') {
                    const val = prompt('Nombre del Evento:');
                    if (val) store.addItem('timeline', { name: val });
                } else if (id === 'btn-add-objeto') {
                    const n = prompt('Nombre del Objeto:');
                    const d = prompt('Descripcin breve:');
                    if (n) store.addItem('elementos', { name: n, desc: d || '' });
                } else if (id === 'btn-add-network') {
                    const p1 = prompt('Personaje 1:');
                    const p2 = prompt('Personaje 2:');
                    if (p1 && p2) store.addItem('network', { p1, p2, type: prompt('Relacin:') || 'Relacionados' });
                } else if (id === 'btn-add-storyboard') {
                    const desc = prompt('Descripcin del Storyboard:');
                    if (desc) store.addItem('storyboard', { num: store.getState().storyboard.length + 1, desc });
                }
            } else {
                console.warn('[FAIL] Modal elements missing from DOM');
            }
        }

        // 3. MODAL CLOSERS
        if (target.id === 'btn-close-modal' || target.id === 'creation-modal') {
            const modal = document.getElementById('creation-modal');
            if (modal) modal.style.display = 'none';
        }

        // 4. CRUD: DELETE
        const delBtn = target.closest('.btn-delete');
        if (delBtn) {
            const { key, id } = delBtn.dataset;
            if (confirm(`Eliminar permanentemente este registro?`)) {
                store.removeItem(key, parseInt(id));
            }
        }

        // 5. CRUD: EDIT
        const editBtn = target.closest('.btn-edit');
        if (editBtn) {
            const { key, id } = editBtn.dataset;
            const item = store.getState()[key].find(i => i.id == id);
            if (item) {
                const newVal = prompt('Modificar valor:', item.name || item.desc || item.type);
                if (newVal) {
                    const update = (item.name !== undefined) ? { name: newVal } : { desc: newVal };
                    store.updateItem(key, parseInt(id), update);
                }
            }
        }

        // 6. SPECIAL SAVES
        const saveFormBtn = target.closest('#btn-save-formato');
        if (saveFormBtn) {
            const universo = document.getElementById('inp-universo')?.value;
            const genero = document.getElementById('inp-genero')?.value;
            store.setState({ formato: { universo, genero } });
            alert('Configuracin guardada.');
        }

        const saveGuionBtn = target.closest('#btn-save-guion');
        if (saveGuionBtn) {
            const guion = document.getElementById('main-guion')?.value;
            store.setState({ guion });
            alert('Guion actualizado.');
        }

        // 7. EXPEDIENTE / FICHA
        const fichaBtn = target.closest('.btn-view-ficha');
        if (fichaBtn) {
            const id = fichaBtn.dataset.id;
            // Manual render override for detailed view
            const container = document.getElementById('view-container');
            const title = document.getElementById('active-tool-title');
            if (container && title) {
                title.textContent = routes.ficha_detalle.title;
                container.innerHTML = routes.ficha_detalle.render(store.getState(), id);
            }
        }

        const backBtn = target.closest('#btn-back-casting');
        if (backBtn) {
            store.setState({ currentView: 'unidades' });
        }
    });

    // --- FORM HANDLING (Creation Modal) ---
    const creationForm = document.getElementById('creation-form');
    const imageInput = document.getElementById('m-image');
    let base64Image = null;

    if (imageInput) {
        imageInput.addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (file) {
                const reader = new FileReader();
                reader.onload = (ev) => {
                    base64Image = ev.target.result;
                    const preview = document.getElementById('img-preview');
                    if (preview) {
                        preview.style.display = 'block';
                        preview.querySelector('img').src = base64Image;
                    }
                };
                reader.readAsDataURL(file);
            }
        });
    }

    if (creationForm) {
        creationForm.addEventListener('submit', (e) => {
            e.preventDefault();
            const name = document.getElementById('m-name').value;
            const type = document.getElementById('m-type').value;
            const desc = document.getElementById('m-desc').value;

            // Map to state keys
            let key = 'unidades';
            if (type === 'Evento') key = 'timeline';
            if (type === 'Objeto') key = 'elementos';

            store.addItem(key, { name, type, desc, image: base64Image });

            // Reset UI
            creationForm.reset();
            base64Image = null;
            const modal = document.getElementById('creation-modal');
            const preview = document.getElementById('img-preview');
            if (modal) modal.style.display = 'none';
            if (preview) preview.style.display = 'none';
            console.log('[SUCCESS] New item added:', name);
        });
    }

    // --- PREMIUM 3D TILT ---
    const updateTilt = (e) => {
        const cards = document.querySelectorAll('.unit-card');
        cards.forEach(card => {
            const rect = card.getBoundingClientRect();
            const x = e.clientX - rect.left;
            const y = e.clientY - rect.top;

            if (x > 0 && x < rect.width && y > 0 && y < rect.height) {
                const centerX = rect.width / 2;
                const centerY = rect.height / 2;
                card.style.transform = `perspective(2000px) rotateX(${(y - centerY) / 8}deg) rotateY(${(centerX - x) / 8}deg) scale(1.05)`;
                card.style.setProperty('--mx', `${(x / rect.width) * 100}%`);
                card.style.setProperty('--my', `${(y / rect.height) * 100}%`);
            } else {
                card.style.transform = `perspective(2000px) rotateX(0deg) rotateY(0deg) scale(1)`;
            }
        });
    };

    document.addEventListener('mousemove', updateTilt);
});

