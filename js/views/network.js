/**
 * Character Network Visualizer - Interactive Version
 * Supports: Dragging nodes, Dragging connections ("hilo"), Adding nodes, Editing nodes.
 */
import { store } from '../main.js';

let canvas = null;
let svg = null;

// Interaction State
let isDraggingNode = false;
let isCreatingConnection = false;
let activeNodeId = null; // ID of the node being dragged or source of connection
let hoverNodeId = null;  // ID of the node currently hovered (potential target)
let dragOffset = { x: 0, y: 0 };
let tempLine = null; // SVG line for the "hilo" being dragged

// Constants
const NODE_WIDTH = 120; // Approx based on CSS
const NODE_HEIGHT = 50;

// --- INITIALIZATION ---
export function initNetwork() {
    console.log('[NETWORK] Initializing...');
    canvas = document.getElementById('network-canvas');
    svg = document.getElementById('network-svg');
    if (!canvas || !svg) {
        console.error('[NETWORK] Canvas or SVG not found!');
        return;
    }

    // Remove old listeners (not strictly necessary as we are in module scope, 
    // but good practice if we were not replacing the element, which we ARE).
    // The previous element is gone, so local listeners are gone. 
    // Global listeners on document might persist! We should be careful to not stack them.
    // Ideally we'd remove them, but since we use named functions, we can try.
    document.removeEventListener('mousemove', handleMouseMove);
    document.removeEventListener('mouseup', handleMouseUp);

    // Attach new listeners
    // MouseDown on canvas/nodes to start
    canvas.addEventListener('mousedown', handleMouseDown);

    // MouseMove/Up on document to handle dragging outside canvas bounds
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);

    // Initial Render
    renderNetwork();

    // Resize handler
    window.addEventListener('resize', () => {
        requestAnimationFrame(renderConnections);
    });
}

// --- RENDERING ---
function renderNetwork() {
    if (!canvas || !svg) return;

    const s = store.getState();
    const nodes = s.networkNodes || []; // We will use a new state key 'networkNodes' for better structure
    const connections = s.networkConnections || []; // New key 'networkConnections'

    // If legacy data exists, migrate it once (optional, but good for safety)
    if ((!nodes.length && !connections.length) && (s.network || []).length) {
        migrateLegacyData(s);
        return; // Migration triggers setState, which triggers re-render
    }

    // 1. Render Nodes (DOM Elements)
    // We only update if necessary or just clear and redraw for simplicity in this MVP
    // For better performance, we should diff, but innerHTML is fast enough for < 100 nodes.

    // We need to keep the 'network-panel' and SVG intact, so we only manage '.network-node' elements
    // actually, the view template in main.js handles the initial DOM. We just need to update positions/selection.

    // Wait, the template in main.js renders the nodes based on state. 
    // So initNetwork is mainly for ATTACHING BEHAVIOR and DRAWING LINES.
    // However, for smooth dragging, we manipulate the DOM directly and then save state on mouseup.

    renderConnections();
}

// (renderConnections removed - using the one at bottom)

// --- INTERACTION HANDLERS ---
let dragStartTime = 0;
const CLICK_THRESHOLD = 200; // ms

function handleMouseDown(e) {
    const nodeEl = e.target.closest('.network-node');
    if (!nodeEl) {
        // Check if connection line?
        // SVG lines are thin. We added a class .connection-line
        if (e.target.classList.contains('connection-line')) {
            const id = parseInt(e.target.dataset.id);
            if (id && window.showConnectionDetails) window.showConnectionDetails(id);
        }
        return;
    }

    // e.preventDefault();
    // e.stopPropagation();

    const id = nodeEl.dataset.id;
    const mode = document.body.dataset.networkMode || 'move';
    dragStartTime = Date.now();

    if (mode === 'connect' || e.shiftKey) {
        startConnectionDrag(id, e);
    } else {
        startNodeDrag(nodeEl, id, e);
    }
}

function handleMouseMove(e) {
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    if (isDraggingNode && activeNodeId) {
        const nodeEl = canvas.querySelector(`.network-node[data-id="${activeNodeId}"]`);
        if (nodeEl) {
            let newX = x - dragOffset.x;
            let newY = y - dragOffset.y;
            newX = Math.max(0, Math.min(newX, rect.width - nodeEl.offsetWidth));
            newY = Math.max(0, Math.min(newY, rect.height - nodeEl.offsetHeight));

            nodeEl.style.left = `${(newX / rect.width) * 100}%`;
            nodeEl.style.top = `${(newY / rect.height) * 100}%`;

            renderConnections();
        }
    } else if (isCreatingConnection && tempLine) {
        tempLine.setAttribute('x2', x);
        tempLine.setAttribute('y2', y);

        const targetEl = e.target.closest('.network-node');
        if (targetEl && targetEl.dataset.id !== activeNodeId) {
            targetEl.classList.add('node-hover');
            hoverNodeId = targetEl.dataset.id;
        } else {
            document.querySelectorAll('.node-hover').forEach(el => el.classList.remove('node-hover'));
            hoverNodeId = null;
        }
    }
}

function handleMouseUp(e) {
    const timeDiff = Date.now() - dragStartTime;

    if (isDraggingNode && activeNodeId) {
        if (timeDiff < CLICK_THRESHOLD) {
            // It was a click!
            if (window.viewNetworkNode) window.viewNetworkNode(activeNodeId);
        } else {
            // Finalize Move
            const nodeEl = canvas.querySelector(`.network-node[data-id="${activeNodeId}"]`);
            if (nodeEl) {
                const rect = canvas.getBoundingClientRect();
                const px = parseFloat(nodeEl.style.left) || 0;
                const py = parseFloat(nodeEl.style.top) || 0;
                updateNodePosition(activeNodeId, px, py);
            }
        }
        isDraggingNode = false;
        activeNodeId = null;
    } else if (isCreatingConnection) {
        if (hoverNodeId && activeNodeId && hoverNodeId !== activeNodeId) {
            createConnection(activeNodeId, hoverNodeId);
        }
        if (tempLine) tempLine.remove();
        tempLine = null;
        isCreatingConnection = false;
        activeNodeId = null;
        hoverNodeId = null;
        document.querySelectorAll('.node-hover').forEach(el => el.classList.remove('node-hover'));
    }
}

// --- LOGIC HELPERS ---

function startNodeDrag(el, id, e) {
    isDraggingNode = true;
    activeNodeId = id;
    const rect = el.getBoundingClientRect();
    dragOffset.x = e.clientX - rect.left;
    dragOffset.y = e.clientY - rect.top;
    el.style.zIndex = 100; // Bring to front
}

function startConnectionDrag(id, e) {
    isCreatingConnection = true;
    activeNodeId = id;

    const rect = canvas.getBoundingClientRect();
    const nodeEl = canvas.querySelector(`.network-node[data-id="${id}"]`);
    const nodeRect = nodeEl.getBoundingClientRect();

    // Start line from center of source
    const x1 = (nodeRect.left + nodeRect.width / 2) - rect.left;
    const y1 = (nodeRect.top + nodeRect.height / 2) - rect.top;

    tempLine = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    tempLine.setAttribute('x1', x1);
    tempLine.setAttribute('y1', y1);
    tempLine.setAttribute('x2', e.clientX - rect.left); // Follow mouse
    tempLine.setAttribute('y2', e.clientY - rect.top);
    tempLine.setAttribute('stroke', '#00d2ff');
    tempLine.setAttribute('stroke-width', '3');
    tempLine.setAttribute('stroke-dasharray', '5,5');
    tempLine.style.pointerEvents = 'none'; // CRITICAL: Allow mouse events to pass through to nodes
    svg.appendChild(tempLine);
}

function updateNodePosition(id, xPercent, yPercent) {
    const s = store.getState();
    const nodes = s.networkNodes || [];
    const newNodes = nodes.map(n => n.id === id ? { ...n, x: xPercent, y: yPercent } : n);
    store.setState({ networkNodes: newNodes });
}

async function createConnection(from, to) {
    console.log('[NETWORK] createConnection', from, to);
    const s = store.getState();
    const connections = s.networkConnections || [];

    // Check duplicates
    const exists = connections.find(c =>
        (c.from === from && c.to === to) || (c.from === to && c.to === from)
    );

    if (exists) {
        console.warn('[NETWORK] Connection already exists');
        return;
    }

    // Ask for label
    let label = '';
    if (window.promptConnectionLabel) {
        console.log('[NETWORK] Prompting for label...');
        label = await window.promptConnectionLabel(from, to);
        console.log('[NETWORK] Label result:', label);
        if (label === null) return; // Cancelled
    }

    const newConn = { id: Date.now(), from, to, label };
    console.log('[NETWORK] Adding connection:', newConn);

    // Update state
    store.setState({ networkConnections: [...connections, newConn] });
    console.log('[NETWORK] State updated');
}

function renderConnections() {
    if (!svg) {
        console.warn('[NETWORK] renderConnections: SVG not found');
        return;
    }
    svg.innerHTML = '';

    const s = store.getState();
    const nodes = s.networkNodes || [];
    const connections = s.networkConnections || [];

    console.log('[NETWORK] Rendering connections:', connections.length);

    const getCenter = (id) => {
        const node = nodes.find(n => n.id === id);
        if (!node) return { x: 0, y: 0 };
        const rect = canvas.getBoundingClientRect(); // Use current canvas dims
        // Safety check for rect
        if (rect.width === 0 || rect.height === 0) return { x: 0, y: 0 };

        return {
            x: (node.x / 100) * rect.width,
            y: (node.y / 100) * rect.height
        };
    };

    connections.forEach(conn => {
        const p1 = getCenter(conn.from);
        const p2 = getCenter(conn.to);

        console.log('[NETWORK] Drawing line', conn.id, p1, p2);

        // Group for line + hit area
        const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');

        const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        line.setAttribute('x1', p1.x);
        line.setAttribute('y1', p1.y);
        line.setAttribute('x2', p2.x);
        line.setAttribute('y2', p2.y);
        line.setAttribute('class', 'connection-line');
        line.setAttribute('stroke', '#00d2ff'); // Bright cyan for visibility
        line.setAttribute('stroke-width', '2');
        line.setAttribute('data-id', conn.id);

        // Transparent thick line for easier clicking
        const hitLine = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        hitLine.setAttribute('x1', p1.x);
        hitLine.setAttribute('y1', p1.y);
        hitLine.setAttribute('x2', p2.x);
        hitLine.setAttribute('y2', p2.y);
        hitLine.setAttribute('stroke', 'transparent');
        hitLine.setAttribute('stroke-width', '20');
        hitLine.setAttribute('data-id', conn.id);
        hitLine.setAttribute('class', 'connection-line');
        hitLine.style.cursor = 'pointer';

        g.appendChild(hitLine);
        g.appendChild(line);
        svg.appendChild(g);
    });
}

function migrateLegacyData(s) {
    // Convert old {network: [{"p1":"Name", "p2":"Name"}], networkPositions: {"Name": {x,y}}}
    // To {networkNodes: [{id, name, type, x, y}], networkConnections: [{from:id, to:id}]}

    const oldNet = s.network || [];
    const oldPos = s.networkPositions || {};
    const units = s.units || [];

    const nodes = [];
    const connections = [];
    const nameToId = {};

    // 1. Identify all unique names
    const names = new Set();
    oldNet.forEach(n => { names.add(n.p1); names.add(n.p2); });
    Object.keys(oldPos).forEach(k => names.add(k));

    // 2. Create Nodes
    names.forEach(name => {
        const id = 'node_' + Date.now() + Math.random().toString(36).substr(2, 5);
        nameToId[name] = id;

        const pos = oldPos[name] || { x: Math.random() * 80 + 10, y: Math.random() * 80 + 10 };
        // Try to find Unit info
        const unit = units.find(u => u.name === name);

        nodes.push({
            id,
            name,
            type: unit ? unit.type : 'Unknown',
            image: unit ? unit.image : null,
            x: pos.x,
            y: pos.y
        });
    });

    // 3. Create Connections
    oldNet.forEach(n => {
        if (nameToId[n.p1] && nameToId[n.p2]) {
            connections.push({
                id: Date.now() + Math.random(),
                from: nameToId[n.p1],
                to: nameToId[n.p2]
            });
        }
    });

    store.setState({
        networkNodes: nodes,
        networkConnections: connections,
        network: [], // Clear old
        networkPositions: {} // Clear old
    });
}

// --- EXPORTED HELPERS FOR MAIN.JS ---

export function addNetworkNode(name, type = 'Unknown') {
    const s = store.getState();
    const nodes = s.networkNodes || [];

    const newNode = {
        id: 'node_' + Date.now(),
        name,
        type,
        x: 50, // Center
        y: 50
    };

    store.setState({ networkNodes: [...nodes, newNode] });
}

export function setMode(mode) {
    document.body.dataset.networkMode = mode;
    // Update cursors
    if (mode === 'connect') {
        canvas.style.cursor = 'crosshair';
    } else {
        canvas.style.cursor = 'default';
    }
}
