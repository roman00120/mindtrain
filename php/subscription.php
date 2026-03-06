<?php
header('Content-Type: application/json');

require_once __DIR__ . '/bootstrap.php';
narrativa_send_security_headers();
narrativa_start_secure_session();
require_once __DIR__ . '/config.php';
require_once __DIR__ . '/paypal_config.php';

function sub_fail(string $message, int $status = 400): void
{
    http_response_code($status);
    echo json_encode(['success' => false, 'message' => $message]);
    exit;
}

function sub_json_body(): array
{
    $raw = file_get_contents('php://input');
    if (!is_string($raw) || $raw === '') return [];
    $decoded = json_decode($raw, true);
    return is_array($decoded) ? $decoded : [];
}

function sub_http_post(string $url, array $headers, string $body): array
{
    if (function_exists('curl_init')) {
        $ch = curl_init($url);
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_POST => true,
            CURLOPT_POSTFIELDS => $body,
            CURLOPT_HTTPHEADER => $headers,
            CURLOPT_CONNECTTIMEOUT => 15,
            CURLOPT_TIMEOUT => 30,
        ]);
        $respBody = curl_exec($ch);
        $status = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
        $err = curl_error($ch);
        curl_close($ch);
        if ($respBody === false) {
            throw new RuntimeException('HTTP request failed: ' . $err);
        }
        $respJson = json_decode($respBody, true);
        return ['status' => $status, 'body' => is_array($respJson) ? $respJson : ['raw' => $respBody]];
    }

    // Fallback for hosts without cURL extension enabled.
    $context = stream_context_create([
        'http' => [
            'method' => 'POST',
            'header' => implode("\r\n", $headers),
            'content' => $body,
            'timeout' => 30,
            'ignore_errors' => true,
        ],
    ]);
    $respBody = @file_get_contents($url, false, $context);
    $status = 0;
    if (isset($http_response_header[0]) && preg_match('/\s(\d{3})\s/', $http_response_header[0], $m)) {
        $status = (int)$m[1];
    }
    if ($respBody === false) {
        throw new RuntimeException('HTTP request failed (stream context).');
    }
    $respJson = json_decode($respBody, true);
    return ['status' => $status, 'body' => is_array($respJson) ? $respJson : ['raw' => $respBody]];
}

function sub_paypal_token(): string
{
    $clientId = narrativa_paypal_client_id();
    $clientSecret = narrativa_paypal_client_secret();
    $auth = base64_encode($clientId . ':' . $clientSecret);
    $res = sub_http_post(
        narrativa_paypal_base_url() . '/v1/oauth2/token',
        [
            'Authorization: Basic ' . $auth,
            'Content-Type: application/x-www-form-urlencoded',
        ],
        'grant_type=client_credentials'
    );
    if ($res['status'] < 200 || $res['status'] >= 300 || empty($res['body']['access_token'])) {
        throw new RuntimeException('Unable to obtain PayPal access token.');
    }
    return (string)$res['body']['access_token'];
}

function sub_column_exists(PDO $pdo, string $table, string $column): bool
{
    try {
        $stmt = $pdo->prepare("SHOW COLUMNS FROM `$table` LIKE ?");
        $stmt->execute([$column]);
        return (bool)$stmt->fetch();
    } catch (Throwable $e) {
        return false;
    }
}

function sub_table_exists(PDO $pdo, string $table): bool
{
    try {
        // SHOW TABLES can be blocked in shared hosting even when table access is allowed.
        $pdo->query("SELECT 1 FROM `$table` LIMIT 1");
        return true;
    } catch (Throwable $e) {
        return false;
    }
}

function sub_role_column_exists(PDO $pdo): bool
{
    try {
        $stmt = $pdo->prepare("SHOW COLUMNS FROM usuarios LIKE 'role'");
        $stmt->execute();
        return (bool)$stmt->fetch();
    } catch (Throwable $e) {
        return false;
    }
}

function sub_ensure_role_column(PDO $pdo): bool
{
    if (sub_role_column_exists($pdo)) return true;
    try {
        $pdo->exec("ALTER TABLE usuarios ADD COLUMN role VARCHAR(32) NOT NULL DEFAULT 'user'");
    } catch (Throwable $e) {
        return false;
    }
    return sub_role_column_exists($pdo);
}

function sub_is_superadmin_role(string $role): bool
{
    $role = strtolower(trim($role));
    return in_array($role, ['superadmin', 'main'], true);
}

function sub_user_role(PDO $pdo, int $userId): string
{
    static $hasRoleColumn = null;
    if ($hasRoleColumn === null) {
        $hasRoleColumn = sub_ensure_role_column($pdo);
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

function sub_ensure_subscription_columns(PDO $pdo): void
{
    if (!sub_column_exists($pdo, 'user_subscriptions', 'billing_cycle')) {
        try {
            $pdo->exec("ALTER TABLE user_subscriptions ADD COLUMN billing_cycle VARCHAR(16) NOT NULL DEFAULT 'monthly' AFTER plan_code");
        } catch (Throwable $e) {
            // Shared hosting can deny ALTER privileges; continue in backward-compatible mode.
        }
    }
    if (!sub_column_exists($pdo, 'user_subscriptions', 'expires_at')) {
        try {
            $pdo->exec("ALTER TABLE user_subscriptions ADD COLUMN expires_at DATETIME DEFAULT NULL AFTER status");
        } catch (Throwable $e) {
            // Shared hosting can deny ALTER privileges; continue in backward-compatible mode.
        }
    }
}

function sub_has_billing_cycle(PDO $pdo): bool
{
    static $value = null;
    if ($value !== null) return $value;
    $value = sub_column_exists($pdo, 'user_subscriptions', 'billing_cycle');
    return $value;
}

function sub_has_expires_at(PDO $pdo): bool
{
    static $value = null;
    if ($value !== null) return $value;
    $value = sub_column_exists($pdo, 'user_subscriptions', 'expires_at');
    return $value;
}

function sub_ensure_tables(PDO $pdo): void
{
    if (!sub_table_exists($pdo, 'user_subscriptions')) {
        try {
            $pdo->exec("
                CREATE TABLE IF NOT EXISTS user_subscriptions (
                    id BIGINT AUTO_INCREMENT PRIMARY KEY,
                    user_id INT NOT NULL,
                    plan_code VARCHAR(32) NOT NULL,
                    billing_cycle VARCHAR(16) NOT NULL DEFAULT 'monthly',
                    provider VARCHAR(32) NOT NULL,
                    provider_order_id VARCHAR(64) NOT NULL UNIQUE,
                    provider_capture_id VARCHAR(64) DEFAULT NULL,
                    amount DECIMAL(10,2) NOT NULL,
                    currency VARCHAR(8) NOT NULL,
                    status VARCHAR(32) NOT NULL,
                    expires_at DATETIME DEFAULT NULL,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                    INDEX idx_user_status (user_id, status)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
            ");
        } catch (Throwable $e) {
            // Shared hosting can deny CREATE privileges.
        }
    }

    if (!sub_table_exists($pdo, 'user_states')) {
        try {
            $pdo->exec("
                CREATE TABLE IF NOT EXISTS user_states (
                    user_id INT PRIMARY KEY,
                    state_json LONGTEXT NOT NULL,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
            ");
        } catch (Throwable $e) {
            // Shared hosting can deny CREATE privileges.
        }
    }

    if (sub_table_exists($pdo, 'user_subscriptions')) {
        sub_ensure_subscription_columns($pdo);
    }
}

function sub_get_billing_cycle(string $raw): string
{
    return strtolower($raw) === 'yearly' ? 'yearly' : 'monthly';
}

function sub_amount_for_cycle(string $billingCycle): string
{
    return $billingCycle === 'yearly'
        ? narrativa_paypal_pro_yearly_amount()
        : narrativa_paypal_pro_monthly_amount();
}

function sub_expiration_for_cycle(string $billingCycle): string
{
    $days = $billingCycle === 'yearly' ? 365 : 30;
    $dt = new DateTimeImmutable('now', new DateTimeZone('UTC'));
    return $dt->modify('+' . $days . ' days')->format('Y-m-d H:i:s');
}

function sub_deactivate_expired(PDO $pdo, int $userId): void
{
    if (!sub_has_expires_at($pdo)) return;
    $stmt = $pdo->prepare("
        UPDATE user_subscriptions
        SET status = 'expired', updated_at = CURRENT_TIMESTAMP
        WHERE user_id = ? AND status = 'active' AND expires_at IS NOT NULL AND expires_at <= UTC_TIMESTAMP()
    ");
    $stmt->execute([$userId]);
}

function sub_apply_state_subscription(PDO $pdo, int $userId, bool $active): void
{
    if (!sub_table_exists($pdo, 'user_states')) return;
    $stmt = $pdo->prepare('SELECT state_json FROM user_states WHERE user_id = ? LIMIT 1');
    $stmt->execute([$userId]);
    $row = $stmt->fetch();
    $state = [];
    if ($row && !empty($row['state_json'])) {
        $decoded = json_decode((string)$row['state_json'], true);
        if (is_array($decoded)) $state = $decoded;
    }
    $state['isSubscribed'] = $active;
    $state['subscriptionPlan'] = $active ? 'pro' : 'free';
    $encoded = json_encode($state, JSON_UNESCAPED_UNICODE);
    if ($encoded === false) return;
    $up = $pdo->prepare('
        INSERT INTO user_states (user_id, state_json) VALUES (?, ?)
        ON DUPLICATE KEY UPDATE state_json = VALUES(state_json), updated_at = CURRENT_TIMESTAMP
    ');
    $up->execute([$userId, $encoded]);
}

$action = $_GET['action'] ?? '';
if ($action === '') {
    $body = sub_json_body();
    if (!empty($body['action'])) $action = (string)$body['action'];
}

if (!($pdo instanceof PDO)) {
    sub_fail('Base de datos no disponible.', 503);
}
$subscriptionStorageReady = sub_table_exists($pdo, 'user_subscriptions');
try {
    sub_ensure_tables($pdo);
} catch (Throwable $e) {
    // Keep backward-compatible behavior when CREATE/ALTER are denied.
}
$subscriptionStorageReady = sub_table_exists($pdo, 'user_subscriptions');

if ($action === 'config') {
    echo json_encode([
        'success' => true,
        'configured' => narrativa_paypal_is_configured(),
        'clientId' => narrativa_paypal_client_id(),
        'currency' => narrativa_paypal_currency(),
        'amountMonthly' => narrativa_paypal_pro_monthly_amount(),
        'amountYearly' => narrativa_paypal_pro_yearly_amount(),
        'mode' => narrativa_paypal_mode(),
    ]);
    exit;
}

if (!isset($_SESSION['user_id'])) {
    sub_fail('No autenticado.', 401);
}
$userId = (int)$_SESSION['user_id'];
$userRole = sub_user_role($pdo, $userId);
$isSuperadmin = sub_is_superadmin_role($userRole);

if ($action === 'status') {
    if ($isSuperadmin) {
        sub_apply_state_subscription($pdo, $userId, true);
        echo json_encode([
            'success' => true,
            'isSubscribed' => true,
            'plan' => 'pro',
            'subscription' => [
                'status' => 'active',
                'plan_code' => 'pro',
                'provider' => 'role',
                'role' => $userRole,
            ],
        ]);
        exit;
    }
    if (!$subscriptionStorageReady || !sub_table_exists($pdo, 'user_subscriptions')) {
        echo json_encode([
            'success' => true,
            'isSubscribed' => false,
            'plan' => 'free',
            'subscription' => null,
            'storageReady' => false,
        ]);
        exit;
    }
    sub_deactivate_expired($pdo, $userId);
    $select = ['status', 'plan_code', 'amount', 'currency', 'updated_at'];
    if (sub_has_billing_cycle($pdo)) $select[] = 'billing_cycle';
    if (sub_has_expires_at($pdo)) $select[] = 'expires_at';
    $sql = "SELECT " . implode(', ', $select) . " FROM user_subscriptions WHERE user_id = ? AND status = 'active'";
    if (sub_has_expires_at($pdo)) {
        $sql .= " AND (expires_at IS NULL OR expires_at > UTC_TIMESTAMP())";
    }
    $sql .= " ORDER BY id DESC LIMIT 1";
    $q = $pdo->prepare($sql);
    $q->execute([$userId]);
    $row = $q->fetch();
    sub_apply_state_subscription($pdo, $userId, !!$row);
    echo json_encode([
        'success' => true,
        'isSubscribed' => !!$row,
        'plan' => $row['plan_code'] ?? 'free',
        'subscription' => $row ?: null,
    ]);
    exit;
}

if ($action === 'set_free') {
    if ($isSuperadmin) {
        sub_apply_state_subscription($pdo, $userId, true);
        echo json_encode(['success' => true, 'isSubscribed' => true, 'plan' => 'pro']);
        exit;
    }
    if (!$subscriptionStorageReady || !sub_table_exists($pdo, 'user_subscriptions')) {
        echo json_encode(['success' => true, 'isSubscribed' => false, 'plan' => 'free', 'storageReady' => false]);
        exit;
    }
    if (!narrativa_validate_csrf_header()) sub_fail('Token CSRF invalido.', 403);
    $pdo->prepare("UPDATE user_subscriptions SET status = 'inactive' WHERE user_id = ? AND status = 'active'")->execute([$userId]);
    sub_apply_state_subscription($pdo, $userId, false);
    echo json_encode(['success' => true, 'isSubscribed' => false, 'plan' => 'free']);
    exit;
}

if (!narrativa_paypal_is_configured()) {
    sub_fail('PayPal no configurado en servidor.', 503);
}

if (!$subscriptionStorageReady || !sub_table_exists($pdo, 'user_subscriptions')) {
    sub_fail('Falta la tabla user_subscriptions en la base de datos. Ejecuta db/subscriptions_tables.sql una sola vez.', 503);
}

if ($action === 'create_order') {
    if (!narrativa_validate_csrf_header()) sub_fail('Token CSRF invalido.', 403);
    $data = sub_json_body();
    $plan = (string)($data['plan'] ?? 'pro');
    $billingCycle = sub_get_billing_cycle((string)($data['billingCycle'] ?? 'monthly'));
    if ($plan !== 'pro') sub_fail('Plan no soportado.');
    try {
        $token = sub_paypal_token();
        $amount = sub_amount_for_cycle($billingCycle);
        $currency = narrativa_paypal_currency();
        $payload = json_encode([
            'intent' => 'CAPTURE',
            'purchase_units' => [[
                'amount' => [
                    'currency_code' => $currency,
                    'value' => $amount,
                ],
                'description' => $billingCycle === 'yearly' ? 'Narrativa Pro anual' : 'Narrativa Pro mensual',
            ]],
            'application_context' => [
                'brand_name' => 'Narrativa',
                'shipping_preference' => 'NO_SHIPPING',
                'user_action' => 'PAY_NOW',
            ],
        ]);
        $res = sub_http_post(
            narrativa_paypal_base_url() . '/v2/checkout/orders',
            [
                'Authorization: Bearer ' . $token,
                'Content-Type: application/json',
            ],
            (string)$payload
        );
        if ($res['status'] < 200 || $res['status'] >= 300 || empty($res['body']['id'])) {
            sub_fail('No se pudo crear la orden PayPal.', 502);
        }
        $orderId = (string)$res['body']['id'];
        if (sub_has_billing_cycle($pdo)) {
            $ins = $pdo->prepare('
                INSERT INTO user_subscriptions (user_id, plan_code, billing_cycle, provider, provider_order_id, amount, currency, status)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ON DUPLICATE KEY UPDATE billing_cycle = VALUES(billing_cycle), amount = VALUES(amount), currency = VALUES(currency), status = VALUES(status), updated_at = CURRENT_TIMESTAMP
            ');
            $ins->execute([$userId, 'pro', $billingCycle, 'paypal', $orderId, (float)$amount, $currency, 'pending']);
        } else {
            $ins = $pdo->prepare('
                INSERT INTO user_subscriptions (user_id, plan_code, provider, provider_order_id, amount, currency, status)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON DUPLICATE KEY UPDATE amount = VALUES(amount), currency = VALUES(currency), status = VALUES(status), updated_at = CURRENT_TIMESTAMP
            ');
            $ins->execute([$userId, 'pro', 'paypal', $orderId, (float)$amount, $currency, 'pending']);
        }
        echo json_encode(['success' => true, 'orderID' => $orderId]);
        exit;
    } catch (Throwable $e) {
        sub_fail('Error creando orden PayPal.', 500);
    }
}

if ($action === 'capture_order') {
    if (!narrativa_validate_csrf_header()) sub_fail('Token CSRF invalido.', 403);
    $data = sub_json_body();
    $orderId = trim((string)($data['orderID'] ?? ''));
    if ($orderId === '') sub_fail('orderID requerido.');

    try {
        $orderSql = sub_has_billing_cycle($pdo)
            ? "SELECT billing_cycle FROM user_subscriptions WHERE user_id = ? AND provider_order_id = ? LIMIT 1"
            : "SELECT plan_code FROM user_subscriptions WHERE user_id = ? AND provider_order_id = ? LIMIT 1";
        $orderStmt = $pdo->prepare($orderSql);
        $orderStmt->execute([$userId, $orderId]);
        $orderRow = $orderStmt->fetch();
        if (!$orderRow) sub_fail('Orden no encontrada en servidor.', 404);
        $billingCycle = sub_get_billing_cycle((string)($orderRow['billing_cycle'] ?? 'monthly'));

        $token = sub_paypal_token();
        $res = sub_http_post(
            narrativa_paypal_base_url() . '/v2/checkout/orders/' . rawurlencode($orderId) . '/capture',
            [
                'Authorization: Bearer ' . $token,
                'Content-Type: application/json',
            ],
            '{}'
        );
        $body = $res['body'];
        if ($res['status'] < 200 || $res['status'] >= 300) sub_fail('No se pudo capturar el pago.', 502);
        $status = (string)($body['status'] ?? '');
        if ($status !== 'COMPLETED') sub_fail('El pago no fue completado.', 400);

        $pu = $body['purchase_units'][0]['payments']['captures'][0] ?? null;
        $captureId = (string)($pu['id'] ?? '');
        $amountPaid = (string)($pu['amount']['value'] ?? '');
        $currencyPaid = (string)($pu['amount']['currency_code'] ?? '');

        $expectedAmount = sub_amount_for_cycle($billingCycle);
        $expectedCurrency = narrativa_paypal_currency();
        if ($amountPaid !== $expectedAmount || strtoupper($currencyPaid) !== strtoupper($expectedCurrency)) {
            sub_fail('Monto o moneda invalido en captura PayPal.', 400);
        }
        $expiresAt = sub_expiration_for_cycle($billingCycle);

        $pdo->prepare("UPDATE user_subscriptions SET status = 'inactive' WHERE user_id = ? AND status = 'active'")->execute([$userId]);
        if (sub_has_expires_at($pdo)) {
            $up = $pdo->prepare("
                UPDATE user_subscriptions
                SET status = 'active', provider_capture_id = ?, amount = ?, currency = ?, expires_at = ?, updated_at = CURRENT_TIMESTAMP
                WHERE user_id = ? AND provider_order_id = ?
            ");
            $up->execute([$captureId, (float)$expectedAmount, $expectedCurrency, $expiresAt, $userId, $orderId]);
        } else {
            $up = $pdo->prepare("
                UPDATE user_subscriptions
                SET status = 'active', provider_capture_id = ?, amount = ?, currency = ?, updated_at = CURRENT_TIMESTAMP
                WHERE user_id = ? AND provider_order_id = ?
            ");
            $up->execute([$captureId, (float)$expectedAmount, $expectedCurrency, $userId, $orderId]);
        }

        sub_apply_state_subscription($pdo, $userId, true);
        echo json_encode([
            'success' => true,
            'isSubscribed' => true,
            'plan' => 'pro',
            'billingCycle' => $billingCycle,
            'expiresAt' => $expiresAt,
            'captureId' => $captureId,
            'orderID' => $orderId,
        ]);
        exit;
    } catch (Throwable $e) {
        sub_fail('Error capturando orden PayPal.', 500);
    }
}

sub_fail('Accion no soportada.');
