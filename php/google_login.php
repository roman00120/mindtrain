<?php
header('Content-Type: application/json');

require_once __DIR__ . '/bootstrap.php';
narrativa_send_security_headers();
narrativa_start_secure_session();
require_once __DIR__ . '/config.php';
require_once __DIR__ . '/google_config.php';

function google_fail(string $message, int $status = 400): void
{
    http_response_code($status);
    echo json_encode(['success' => false, 'message' => $message]);
    exit;
}

function google_role_column_exists(PDO $pdo): bool
{
    try {
        $stmt = $pdo->prepare("SHOW COLUMNS FROM usuarios LIKE 'role'");
        $stmt->execute();
        return (bool)$stmt->fetch();
    } catch (Throwable $e) {
        return false;
    }
}

function google_ensure_role_column(PDO $pdo): bool
{
    if (google_role_column_exists($pdo)) return true;
    try {
        $pdo->exec("ALTER TABLE usuarios ADD COLUMN role VARCHAR(32) NOT NULL DEFAULT 'user'");
    } catch (Throwable $e) {
        return false;
    }
    return google_role_column_exists($pdo);
}

function fetch_google_tokeninfo(string $idToken): array
{
    $url = 'https://oauth2.googleapis.com/tokeninfo?id_token=' . urlencode($idToken);

    $response = @file_get_contents($url);
    if ($response === false) {
        google_fail('No se pudo validar el token de Google.', 502);
    }

    $data = json_decode($response, true);
    if (!is_array($data)) {
        google_fail('Respuesta invalida de Google.', 502);
    }

    return $data;
}

function unique_username(PDO $pdo, string $base): string
{
    $candidate = preg_replace('/[^a-zA-Z0-9_ ]/', '', $base);
    if ($candidate === '' || strlen($candidate) < 3) {
        $candidate = 'user';
    }
    $candidate = strtolower(substr($candidate, 0, 24));

    $suffix = 0;
    while (true) {
        $test = $candidate . ($suffix > 0 ? (string)$suffix : '');
        $stmt = $pdo->prepare('SELECT id FROM usuarios WHERE username = ? LIMIT 1');
        $stmt->execute([$test]);
        if (!$stmt->fetch()) {
            return $test;
        }
        $suffix++;
    }
}

if (!($pdo instanceof PDO)) {
    google_fail('Servicio no disponible temporalmente. Verifica la base de datos.', 503);
}

$hasRoleColumn = google_ensure_role_column($pdo);

if (GOOGLE_CLIENT_ID === 'REPLACE_WITH_GOOGLE_CLIENT_ID') {
    google_fail('Google Login no esta configurado. Falta GOOGLE_CLIENT_ID.');
}

$input = file_get_contents('php://input');
$data = json_decode($input, true);
if (!is_array($data) || empty($data['credential'])) {
    google_fail('Credencial de Google invalida.');
}

$tokenData = fetch_google_tokeninfo((string)$data['credential']);

if (($tokenData['aud'] ?? '') !== GOOGLE_CLIENT_ID) {
    google_fail('Token de Google no valido para esta aplicacion.', 401);
}

$email = (string)($tokenData['email'] ?? '');
$emailVerified = (string)($tokenData['email_verified'] ?? '');
$name = trim((string)($tokenData['name'] ?? ''));
$sub = (string)($tokenData['sub'] ?? '');

if ($email === '' || $sub === '') {
    google_fail('No se obtuvo email valido de Google.', 401);
}
if ($emailVerified !== 'true') {
    google_fail('Tu cuenta de Google no tiene email verificado.', 401);
}

try {
    $stmt = $pdo->prepare(
        $hasRoleColumn
            ? 'SELECT id, username, email, role FROM usuarios WHERE email = ? LIMIT 1'
            : 'SELECT id, username, email FROM usuarios WHERE email = ? LIMIT 1'
    );
    $stmt->execute([$email]);
    $user = $stmt->fetch();

    if (!$user) {
        $baseName = $name !== '' ? $name : explode('@', $email)[0];
        $username = unique_username($pdo, $baseName);
        $randomPassword = bin2hex(random_bytes(16));
        $passwordHash = password_hash($randomPassword, PASSWORD_DEFAULT);

        if ($hasRoleColumn) {
            $insert = $pdo->prepare('INSERT INTO usuarios (username, email, password, role) VALUES (?, ?, ?, ?)');
            $insert->execute([$username, $email, $passwordHash, 'user']);
        } else {
            $insert = $pdo->prepare('INSERT INTO usuarios (username, email, password) VALUES (?, ?, ?)');
            $insert->execute([$username, $email, $passwordHash]);
        }

        $stmt = $pdo->prepare(
            $hasRoleColumn
                ? 'SELECT id, username, email, role FROM usuarios WHERE email = ? LIMIT 1'
                : 'SELECT id, username, email FROM usuarios WHERE email = ? LIMIT 1'
        );
        $stmt->execute([$email]);
        $user = $stmt->fetch();
    } else {
        // Retroactive fix for users with joined names (e.g. "ROMANVELASCO" -> "ROMAN VELASCO")
        if ($name !== '') {
            $betterName = strtolower(substr(preg_replace('/[^a-zA-Z0-9_ ]/', '', $name), 0, 24));
            $joined = str_replace(' ', '', $betterName);

            if ($user['username'] === $joined && $user['username'] !== $betterName) {
                // Check if the spaced version is available
                $check = $pdo->prepare('SELECT id FROM usuarios WHERE username = ?');
                $check->execute([$betterName]);
                if (!$check->fetch()) {
                    $upd = $pdo->prepare('UPDATE usuarios SET username = ? WHERE id = ?');
                    $upd->execute([$betterName, $user['id']]);
                    $user['username'] = $betterName;
                }
            }
        }
    }

    session_regenerate_id(true);
    $_SESSION['user_id'] = $user['id'];
    $_SESSION['username'] = $user['username'];
    $_SESSION['role'] = $hasRoleColumn ? (string)($user['role'] ?? 'user') : 'user';

    echo json_encode([
        'success' => true,
        'message' => 'Acceso concedido.',
        'user' => [
            'name' => $user['username'],
            'email' => $user['email'],
        ],
    ]);
    exit;
} catch (Throwable $e) {
    google_fail('Error en el servidor.', 500);
}
