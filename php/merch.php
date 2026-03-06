<?php
header('Content-Type: application/json');
header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');
header('Pragma: no-cache');
header('Expires: 0');

require_once __DIR__ . '/bootstrap.php';
narrativa_send_security_headers();
narrativa_start_secure_session();
require_once __DIR__ . '/config.php';

function merch_fail(string $message, int $status = 400): void
{
    http_response_code($status);
    echo json_encode(['success' => false, 'message' => $message]);
    exit;
}

function merch_json_body(): array
{
    $raw = file_get_contents('php://input');
    if (!is_string($raw) || $raw === '') return [];
    $decoded = json_decode($raw, true);
    return is_array($decoded) ? $decoded : [];
}

if (!($pdo instanceof PDO)) {
    merch_fail('Base de datos no disponible.', 503);
}

// Ensure table exists
try {
    $pdo->exec("
        CREATE TABLE IF NOT EXISTS merch (
            id INT AUTO_INCREMENT PRIMARY KEY,
            name VARCHAR(255) NOT NULL,
            price VARCHAR(50) DEFAULT '',
            description TEXT DEFAULT '',
            image_url TEXT DEFAULT '',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    ");
} catch (Throwable $e) {
    // Ignore if already exists or restricted
}

$action = $_GET['action'] ?? '';
if ($action === '') {
    $body = merch_json_body();
    if (!empty($body['action'])) $action = (string)$body['action'];
}

// Public: List all items
if ($action === 'list') {
    try {
        $stmt = $pdo->query('SELECT * FROM merch ORDER BY id DESC');
        $rows = $stmt->fetchAll();
        echo json_encode(['success' => true, 'merch' => $rows]);
        exit;
    } catch (Throwable $e) {
        merch_fail('No se pudo listar productos.', 500);
    }
}

// Protected Actions (Admin only)
if (!isset($_SESSION['user_id'])) {
    merch_fail('No autenticado.', 401);
}

$userId = (int)$_SESSION['user_id'];
$role = $_SESSION['role'] ?? 'user';
$is_admin = in_array(strtolower(trim($role)), ['admin', 'superadmin', 'main'], true);

if (!$is_admin) {
    merch_fail('Acceso denegado.', 403);
}

if ($action === 'add') {
    if (!narrativa_validate_csrf_header()) merch_fail('Token CSRF invalido.', 403);
    $body = merch_json_body();
    $name = trim((string)($body['name'] ?? ''));
    if ($name === '') merch_fail('Nombre requerido.');
    
    try {
        $stmt = $pdo->prepare('INSERT INTO merch (name, price, description, image_url) VALUES (?, ?, ?, ?)');
        $stmt->execute([
            $name,
            (string)($body['price'] ?? ''),
            (string)($body['desc'] ?? ''),
            (string)($body['image'] ?? '')
        ]);
        echo json_encode(['success' => true, 'id' => $pdo->lastInsertId()]);
        exit;
    } catch (Throwable $e) {
        merch_fail('No se pudo añadir producto.', 500);
    }
}

if ($action === 'update') {
    if (!narrativa_validate_csrf_header()) merch_fail('Token CSRF invalido.', 403);
    $body = merch_json_body();
    $id = (int)($body['id'] ?? 0);
    if ($id <= 0) merch_fail('ID requerido.');
    
    try {
        $stmt = $pdo->prepare('UPDATE merch SET name = ?, price = ?, description = ?, image_url = ? WHERE id = ?');
        $stmt->execute([
            (string)($body['name'] ?? ''),
            (string)($body['price'] ?? ''),
            (string)($body['desc'] ?? ''),
            (string)($body['image'] ?? ''),
            $id
        ]);
        echo json_encode(['success' => true]);
        exit;
    } catch (Throwable $e) {
        merch_fail('No se pudo actualizar producto.', 500);
    }
}

if ($action === 'delete') {
    if (!narrativa_validate_csrf_header()) merch_fail('Token CSRF invalido.', 403);
    $body = merch_json_body();
    $id = (int)($body['id'] ?? 0);
    if ($id <= 0) merch_fail('ID requerido.');
    
    try {
        $stmt = $pdo->prepare('DELETE FROM merch WHERE id = ?');
        $stmt->execute([$id]);
        echo json_encode(['success' => true]);
        exit;
    } catch (Throwable $e) {
        merch_fail('No se pudo eliminar producto.', 500);
    }
}

merch_fail('Accion no soportada.');
