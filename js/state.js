/**
 * Universal Narrative Bible State - Standardized Keys
 */
class State {
    constructor(initialState) {
        this.state = initialState;
        this.listeners = [];
    }

    getState() {
        return this.state;
    }

    setState(newState) {
        this.state = { ...this.state, ...newState };
        console.log('State Updated:', this.state);
        this.notify();
    }

    subscribe(listener) {
        this.listeners.push(listener);
        return () => {
            this.listeners = this.listeners.filter(l => l !== listener);
        };
    }

    notify() {
        this.listeners.forEach(listener => listener(this.state));
    }

    addItem(key, item) {
        this.setState({ [key]: [...this.state[key], { ...item, id: Date.now() }] });
    }

    removeItem(key, id) {
        this.setState({ [key]: this.state[key].filter(i => i.id !== id) });
    }

    updateItem(key, id, data) {
        this.setState({ [key]: this.state[key].map(i => i.id === id ? { ...i, ...data } : i) });
    }
}

export const store = new State({
    currentView: 'formato',
    // Data Modules
    unidades: [],           // Characters/Places
    timeline: [],           // Chronology
    network: [],            // Relation map
    storyboard: [],         // Scenes
    elementos: [],          // Objects/Props
    reglasUniversales: [],  // Universal Rules
    reglasInternas: [],     // Internal Logic Rules
    // Global Settings
    formato: { universo: '', genero: '', duracion: '' },
    identidad: { logo: '', paleta: [] },
    guion: '',
    fichas: {} // Profiles keyed by unit ID
});
