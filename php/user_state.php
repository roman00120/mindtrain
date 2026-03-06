<?php
header('Content-Type: application/json');
header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');
header('Pragma: no-cache');
header('Expires: 0');

require_once __DIR__ . '/bootstrap.php';
narrativa_send_security_headers();
narrativa_start_secure_session();
require_once __DIR__ . '/config.php';

function state_fail(string $message, int $status = 400): void
{
    http_response_code($status);
    echo json_encode(['success' => false, 'message' => $message]);
    exit;
}

if (!isset($_SESSION['user_id'])) {
    state_fail('No autenticado.', 401);
}

if (!($pdo instanceof PDO)) {
    state_fail('Base de datos no disponible.', 503);
}

$userId = (int)$_SESSION['user_id'];
$action = $_GET['action'] ?? '';
if ($action === '') {
    $raw = file_get_contents('php://input');
    $json = json_decode($raw, true);
    if (is_array($json) && isset($json['action'])) {
        $action = (string)$json['action'];
    }
}

try {
    $pdo->exec("
        CREATE TABLE IF NOT EXISTS user_states (
            user_id INT PRIMARY KEY,
            state_json LONGTEXT NOT NULL,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    ");
} catch (Throwable $e) {
    state_fail('No se pudo preparar almacenamiento de estado.', 500);
}

if ($action === 'load') {
    try {
        $stmt = $pdo->prepare('SELECT state_json, updated_at FROM user_states WHERE user_id = ? LIMIT 1');
        $stmt->execute([$userId]);
        $row = $stmt->fetch();
        if (!$row) {
            echo json_encode(['success' => true, 'state' => null]);
            exit;
        }

        $state = json_decode((string)$row['state_json'], true);
        if (!is_array($state)) {
            echo json_encode(['success' => true, 'state' => null]);
            exit;
        }

        echo json_encode([
            'success' => true,
            'state' => $state,
            'updatedAt' => $row['updated_at'] ?? null,
        ]);
        exit;
    } catch (Throwable $e) {
        state_fail('No se pudo cargar estado.', 500);
    }
}

if ($action === 'save') {
    $sentToken = $_SERVER['HTTP_X_CSRF_TOKEN'] ?? '';
    if ($sentToken !== '' && !narrativa_validate_csrf_header()) {
        state_fail('Token de seguridad invalido.', 403);
    }

    $raw = file_get_contents('php://input');
    $data = json_decode($raw, true);
    if (!is_array($data) || !isset($data['state']) || !is_array($data['state'])) {
        state_fail('Payload de estado invalido.');
    }
    $knownUpdatedAt = isset($data['knownUpdatedAt']) ? (string)$data['knownUpdatedAt'] : '';

    $encoded = json_encode($data['state'], JSON_UNESCAPED_UNICODE);
    if ($encoded === false) {
        state_fail('No se pudo serializar estado.');
    }

    try {
        $currentStmt = $pdo->prepare('SELECT state_json, updated_at FROM user_states WHERE user_id = ? LIMIT 1');
        $currentStmt->execute([$userId]);
        $currentRow = $currentStmt->fetch();
        $currentUpdatedAt = $currentRow['updated_at'] ?? '';

        // Prevent stale sessions from overwriting newer server data.
        if ($currentRow && $knownUpdatedAt !== '' && $currentUpdatedAt !== '' && $knownUpdatedAt !== $currentUpdatedAt) {
            http_response_code(409);
            echo json_encode([
                'success' => false,
                'message' => 'Estado desactualizado. Recarga sincronizacion.',
                'serverUpdatedAt' => $currentUpdatedAt,
                'state' => json_decode((string)$currentRow['state_json'], true),
            ]);
            exit;
        }

        $stmt = $pdo->prepare('
            INSERT INTO user_states (user_id, state_json) VALUES (?, ?)
            ON DUPLICATE KEY UPDATE state_json = VALUES(state_json), updated_at = CURRENT_TIMESTAMP
        ');
        $stmt->execute([$userId, $encoded]);
        $ts = $pdo->prepare('SELECT updated_at FROM user_states WHERE user_id = ? LIMIT 1');
        $ts->execute([$userId]);
        $row = $ts->fetch();
        echo json_encode([
            'success' => true,
            'updatedAt' => $row['updated_at'] ?? null,
        ]);
        exit;
    } catch (Throwable $e) {
        state_fail('No se pudo guardar estado.', 500);
    }
}

state_fail('Accion no soportada.');
