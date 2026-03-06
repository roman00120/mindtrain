<?php
header('Content-Type: application/json');
require_once __DIR__ . '/bootstrap.php';
narrativa_send_security_headers();
narrativa_start_secure_session();
require_once __DIR__ . '/config.php';

error_reporting(E_ALL);
ini_set('display_errors', '0');

function auth_fail(string $message, int $status = 200): void
{
    http_response_code($status);
    echo json_encode(['success' => false, 'message' => $message]);
    exit;
}

function auth_role_column_exists(PDO $pdo): bool
{
    try {
        $stmt = $pdo->prepare("SHOW COLUMNS FROM usuarios LIKE 'role'");
        $stmt->execute();
        return (bool)$stmt->fetch();
    } catch (Throwable $e) {
        return false;
    }
}

function auth_ensure_role_column(PDO $pdo): bool
{
    if (auth_role_column_exists($pdo)) return true;
    try {
        $pdo->exec("ALTER TABLE usuarios ADD COLUMN role VARCHAR(32) NOT NULL DEFAULT 'user'");
    } catch (Throwable $e) {
        return false;
    }
    return auth_role_column_exists($pdo);
}

function get_client_ip(): string
{
    return $_SERVER['REMOTE_ADDR'] ?? 'unknown';
}

function get_rate_limit_path(string $ip): string
{
    return rtrim(sys_get_temp_dir(), DIRECTORY_SEPARATOR) . DIRECTORY_SEPARATOR . 'narrativa_auth_' . sha1($ip) . '.json';
}

function read_rate_limit_state(string $path): array
{
    if (!is_file($path)) {
        return ['count' => 0, 'first' => time()];
    }

    $raw = @file_get_contents($path);
    if ($raw === false) {
        return ['count' => 0, 'first' => time()];
    }

    $data = json_decode($raw, true);
    if (!is_array($data) || !isset($data['count'], $data['first'])) {
        return ['count' => 0, 'first' => time()];
    }

    return [
        'count' => (int)$data['count'],
        'first' => (int)$data['first'],
    ];
}

function write_rate_limit_state(string $path, array $state): void
{
    @file_put_contents($path, json_encode($state), LOCK_EX);
}

function clear_rate_limit_state(string $path): void
{
    if (is_file($path)) {
        @unlink($path);
    }
}

function check_login_rate_limit(): void
{
    $windowSeconds = 15 * 60;
    $maxAttempts = 12;
    $path = get_rate_limit_path(get_client_ip());
    $state = read_rate_limit_state($path);
    $now = time();

    if (($now - $state['first']) > $windowSeconds) {
        write_rate_limit_state($path, ['count' => 0, 'first' => $now]);
        return;
    }

    if ($state['count'] >= $maxAttempts) {
        auth_fail('Demasiados intentos. Intenta de nuevo en unos minutos.', 429);
    }
}

function mark_login_failure(): void
{
    $windowSeconds = 15 * 60;
    $path = get_rate_limit_path(get_client_ip());
    $state = read_rate_limit_state($path);
    $now = time();

    if (($now - $state['first']) > $windowSeconds) {
        $state = ['count' => 1, 'first' => $now];
    } else {
        $state['count']++;
    }

    write_rate_limit_state($path, $state);
}

function reset_login_failures(): void
{
    clear_rate_limit_state(get_rate_limit_path(get_client_ip()));
}

$input = file_get_contents('php://input');
$data = json_decode($input, true);

if (json_last_error() !== JSON_ERROR_NONE || !$data) {
    auth_fail('Error al procesar los datos enviados.');
}

if (!($pdo instanceof PDO)) {
    auth_fail('Servicio no disponible temporalmente. Verifica la base de datos.', 503);
}

$hasRoleColumn = auth_ensure_role_column($pdo);

$action = $data['action'] ?? '';
if (!in_array($action, ['login', 'register', 'logout'], true)) {
    auth_fail('Accion no reconocida.');
}

if (!narrativa_validate_csrf_header()) {
    auth_fail('Token de seguridad invalido.', 403);
}

if ($action === 'login') {
    check_login_rate_limit();
    $usernameOrEmail = trim((string)($data['username'] ?? ''));
    $password = (string)($data['password'] ?? '');

    if ($usernameOrEmail === '' || $password === '') {
        auth_fail('Campos requeridos vacios.');
    }

    try {
        $stmt = $pdo->prepare(
            $hasRoleColumn
                ? 'SELECT id, username, email, password, role FROM usuarios WHERE username = ? OR email = ? LIMIT 1'
                : 'SELECT id, username, email, password FROM usuarios WHERE username = ? OR email = ? LIMIT 1'
        );
        $stmt->execute([$usernameOrEmail, $usernameOrEmail]);
        $user = $stmt->fetch();

        if ($user && password_verify($password, $user['password'])) {
            session_regenerate_id(true);
            $_SESSION['user_id'] = $user['id'];
            $_SESSION['username'] = $user['username'];
            $_SESSION['role'] = $hasRoleColumn ? (string)($user['role'] ?? 'user') : 'user';
            reset_login_failures();

            echo json_encode([
                'success' => true,
                'message' => 'Acceso concedido.',
                'user' => [
                    'name' => $user['username'],
                    'email' => $user['email'],
                ],
            ]);
            exit;
        }

        mark_login_failure();
        echo json_encode(['success' => false, 'message' => 'Credenciales invalidas.']);
        exit;
    } catch (Throwable $e) {
        auth_fail('Error en el servidor.');
    }
}

if ($action === 'register') {
    $username = trim((string)($data['username'] ?? ''));
    $email = trim((string)($data['email'] ?? ''));
    $password = (string)($data['password'] ?? '');

    if ($username === '' || $email === '' || $password === '') {
        auth_fail('Todos los campos son obligatorios.');
    }

    try {
        $stmt = $pdo->prepare('SELECT id FROM usuarios WHERE username = ? OR email = ?');
        $stmt->execute([$username, $email]);
        if ($stmt->fetch()) {
            auth_fail('El usuario o el correo ya estan registrados.');
        }

        $hashed = password_hash($password, PASSWORD_DEFAULT);
        if ($hasRoleColumn) {
            $insert = $pdo->prepare('INSERT INTO usuarios (username, email, password, role) VALUES (?, ?, ?, ?)');
            $ok = $insert->execute([$username, $email, $hashed, 'user']);
        } else {
            $insert = $pdo->prepare('INSERT INTO usuarios (username, email, password) VALUES (?, ?, ?)');
            $ok = $insert->execute([$username, $email, $hashed]);
        }
        if ($ok) {
            echo json_encode(['success' => true, 'message' => 'Registro exitoso. Ya puedes iniciar sesion.']);
            exit;
        }

        auth_fail('Error al registrar el usuario.');
    } catch (Throwable $e) {
        auth_fail('Error en el servidor.');
    }
}

if ($action === 'logout') {
    $_SESSION = [];
    if (ini_get('session.use_cookies')) {
        $params = session_get_cookie_params();
        setcookie(
            session_name(),
            '',
            time() - 42000,
            $params['path'],
            $params['domain'],
            (bool)$params['secure'],
            (bool)$params['httponly']
        );
    }
    session_destroy();
    echo json_encode(['success' => true]);
    exit;
}
