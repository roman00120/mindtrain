<?php
header('Content-Type: application/json');
header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');
header('Pragma: no-cache');
header('Expires: 0');

require_once __DIR__ . '/bootstrap.php';
narrativa_send_security_headers();
narrativa_start_secure_session();
require_once __DIR__ . '/config.php';

function admin_fail(string $message, int $status = 400): void
{
    http_response_code($status);
    echo json_encode(['success' => false, 'message' => $message]);
    exit;
}

function admin_json_body(): array
{
    $raw = file_get_contents('php://input');
    if (!is_string($raw) || $raw === '') return [];
    $decoded = json_decode($raw, true);
    return is_array($decoded) ? $decoded : [];
}

function admin_role_column_exists(PDO $pdo): bool
{
    try {
        $stmt = $pdo->prepare("SHOW COLUMNS FROM usuarios LIKE 'role'");
        $stmt->execute();
        return (bool)$stmt->fetch();
    } catch (Throwable $e) {
        return false;
    }
}

function admin_ensure_role_column(PDO $pdo): bool
{
    if (admin_role_column_exists($pdo)) return true;
    try {
        $pdo->exec("ALTER TABLE usuarios ADD COLUMN role VARCHAR(32) NOT NULL DEFAULT 'user'");
    } catch (Throwable $e) {
        return false;
    }
    return admin_role_column_exists($pdo);
}

function admin_is_superadmin_role(string $role): bool
{
    $role = strtolower(trim($role));
    return in_array($role, ['superadmin', 'main', 'admin'], true);
}

function admin_user_role(PDO $pdo, int $userId): string
{
    static $hasRoleColumn = null;
    if ($hasRoleColumn === null) {
        $hasRoleColumn = admin_ensure_role_column($pdo);
    }
    if (!$hasRoleColumn) return 'user';
    try {
        $stmt = $pdo->prepare('SELECT role FROM usuarios WHERE id = ? LIMIT 1');
        $stmt->execute([$userId]);
        $row = $stmt->fetch();
        return isset($row['role']) ? (string)$row['role'] : 'user';
    } catch (Throwable $e) {
        return 'user';
    }
}

function admin_ensure_user_states(PDO $pdo): void
{
    try {
        $pdo->exec("
            CREATE TABLE IF NOT EXISTS user_states (
                user_id INT PRIMARY KEY,
                state_json LONGTEXT NOT NULL,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        ");
    } catch (Throwable $e) {
        // Ignore if shared hosting denies CREATE.
    }
}

if (!($pdo instanceof PDO)) {
    admin_fail('Base de datos no disponible.', 503);
}

if (!isset($_SESSION['user_id'])) {
    admin_fail('No autenticado.', 401);
}

$userId = (int)$_SESSION['user_id'];
$role = admin_user_role($pdo, $userId);
if (!admin_is_superadmin_role($role)) {
    admin_fail('Acceso denegado.', 403);
}

$action = $_GET['action'] ?? '';
if ($action === '') {
    $body = admin_json_body();
    if (!empty($body['action'])) $action = (string)$body['action'];
}

if ($action === 'list_users') {
    try {
        admin_ensure_role_column($pdo);
        $stmt = $pdo->query('SELECT id, username, email, role, created_at FROM usuarios ORDER BY id DESC');
        $rows = $stmt->fetchAll();
        echo json_encode(['success' => true, 'users' => $rows]);
        exit;
    } catch (Throwable $e) {
        admin_fail('No se pudo listar usuarios.', 500);
    }
}

if ($action === 'get_user_state') {
    $targetId = (int)($_GET['userId'] ?? 0);
    if ($targetId <= 0) admin_fail('userId requerido.');
    admin_ensure_user_states($pdo);
    try {
        $stmt = $pdo->prepare('SELECT state_json, updated_at FROM user_states WHERE user_id = ? LIMIT 1');
        $stmt->execute([$targetId]);
        $row = $stmt->fetch();
        if (!$row) {
            echo json_encode(['success' => true, 'state' => null, 'updatedAt' => null]);
            exit;
        }
        $state = json_decode((string)$row['state_json'], true);
        if (!is_array($state)) $state = null;
        echo json_encode([
            'success' => true,
            'state' => $state,
            'updatedAt' => $row['updated_at'] ?? null,
        ]);
        exit;
    } catch (Throwable $e) {
        admin_fail('No se pudo cargar estado.', 500);
    }
}

if ($action === 'save_user_state') {
    if (!narrativa_validate_csrf_header()) admin_fail('Token CSRF invalido.', 403);
    $body = admin_json_body();
    $targetId = (int)($body['userId'] ?? 0);
    if ($targetId <= 0) admin_fail('userId requerido.');
    $state = $body['state'] ?? null;
    if (!is_array($state)) admin_fail('state invalido.');
    admin_ensure_user_states($pdo);
    $encoded = json_encode($state, JSON_UNESCAPED_UNICODE);
    if ($encoded === false) admin_fail('No se pudo serializar estado.');
    try {
        $stmt = $pdo->prepare('
            INSERT INTO user_states (user_id, state_json) VALUES (?, ?)
            ON DUPLICATE KEY UPDATE state_json = VALUES(state_json), updated_at = CURRENT_TIMESTAMP
        ');
        $stmt->execute([$targetId, $encoded]);
        $ts = $pdo->prepare('SELECT updated_at FROM user_states WHERE user_id = ? LIMIT 1');
        $ts->execute([$targetId]);
        $row = $ts->fetch();
        echo json_encode(['success' => true, 'updatedAt' => $row['updated_at'] ?? null]);
        exit;
    } catch (Throwable $e) {
        admin_fail('No se pudo guardar estado.', 500);
    }
}

if ($action === 'set_role') {
    if (!narrativa_validate_csrf_header()) admin_fail('Token CSRF invalido.', 403);
    $body = admin_json_body();
    $targetId = (int)($body['userId'] ?? 0);
    $nextRole = strtolower(trim((string)($body['role'] ?? 'user')));
    if ($targetId <= 0) admin_fail('userId requerido.');
    if (!in_array($nextRole, ['user', 'admin', 'superadmin', 'main'], true)) {
        admin_fail('Role invalido.');
    }
    admin_ensure_role_column($pdo);
    try {
        $stmt = $pdo->prepare('UPDATE usuarios SET role = ? WHERE id = ?');
        $stmt->execute([$nextRole, $targetId]);
        echo json_encode(['success' => true, 'role' => $nextRole]);
        exit;
    } catch (Throwable $e) {
        admin_fail('No se pudo actualizar role.', 500);
    }
}

if ($action === 'upload_merch_image') {
    if (!narrativa_validate_csrf_header()) admin_fail('Token CSRF invalido.', 403);
    if (empty($_FILES['image']) || !is_array($_FILES['image'])) {
        admin_fail('Archivo de imagen requerido.');
    }

    $file = $_FILES['image'];
    if (($file['error'] ?? UPLOAD_ERR_NO_FILE) !== UPLOAD_ERR_OK) {
        admin_fail('No se pudo subir la imagen.');
    }

    $size = (int)($file['size'] ?? 0);
    if ($size <= 0 || $size > 5 * 1024 * 1024) {
        admin_fail('La imagen debe pesar maximo 5MB.');
    }

    $tmp = (string)($file['tmp_name'] ?? '');
    if ($tmp === '' || !is_uploaded_file($tmp)) {
        admin_fail('Upload invalido.');
    }

    $finfo = function_exists('finfo_open') ? finfo_open(FILEINFO_MIME_TYPE) : false;
    $mime = $finfo ? (string)finfo_file($finfo, $tmp) : '';
    if ($finfo) finfo_close($finfo);

    $allowed = [
        'image/jpeg' => 'jpg',
        'image/png' => 'png',
        'image/webp' => 'webp',
        'image/gif' => 'gif',
    ];
    if (!isset($allowed[$mime])) {
        admin_fail('Formato no permitido. Usa JPG, PNG, WEBP o GIF.');
    }

    $uploadDir = dirname(__DIR__) . DIRECTORY_SEPARATOR . 'images' . DIRECTORY_SEPARATOR . 'merch_uploads';
    if (!is_dir($uploadDir) && !@mkdir($uploadDir, 0775, true) && !is_dir($uploadDir)) {
        admin_fail('No se pudo preparar la carpeta de imagenes.', 500);
    }

    $fileName = 'merch_' . date('Ymd_His') . '_' . bin2hex(random_bytes(6)) . '.' . $allowed[$mime];
    $targetPath = $uploadDir . DIRECTORY_SEPARATOR . $fileName;
    if (!move_uploaded_file($tmp, $targetPath)) {
        admin_fail('No se pudo guardar la imagen.', 500);
    }

    echo json_encode([
        'success' => true,
        'path' => 'images/merch_uploads/' . $fileName,
    ]);
    exit;
}

admin_fail('Accion no soportada.');
