<?php
require_once __DIR__ . '/php/config.php';
require_once __DIR__ . '/php/subscription.php';

$email = 'gerawx@gmail.com';
$msg = "Haz clic en el botón de abajo para activar la cuenta de <strong>$email</strong> con Acceso Full (Pro).";
$type = "info";

if (isset($_POST['grant'])) {
    try {
        // 1. Find User ID
        $stmt = $pdo->prepare('SELECT id FROM usuarios WHERE email = ? LIMIT 1');
        $stmt->execute([$email]);
        $user = $stmt->fetch();

        if (!$user) {
            $msg = "Error: El usuario con email <strong>$email</strong> no existe en la base de datos.";
            $type = "error";
        } else {
            $userId = (int)$user['id'];
            
            // 2. Ensure tables exist
            sub_ensure_tables($pdo);

            // 3. Deactivate old active subscriptions
            $pdo->prepare("UPDATE user_subscriptions SET status = 'inactive' WHERE user_id = ? AND status = 'active'")->execute([$userId]);

            // 4. Insert new 'active' pro subscription (valid for 100 years)
            $expiresAt = date('Y-m-d H:i:s', strtotime('+100 years'));
            $ins = $pdo->prepare('
                INSERT INTO user_subscriptions (user_id, plan_code, billing_cycle, provider, provider_order_id, amount, currency, status, expires_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ');
            $ins->execute([$userId, 'pro', 'yearly', 'admin_grant', 'manual_' . time(), 199.00, 'USD', 'active', $expiresAt]);

            // 5. Apply state subscription (updates user_states table)
            sub_apply_state_subscription($pdo, $userId, true);

            $msg = "¡Éxito! La cuenta de <strong>$email</strong> ahora tiene Acceso Full (Pro - Suscrito) de forma vitalicia.";
            $type = "success";
        }
    } catch (Throwable $e) {
        $msg = "Error crítico: " . $e->getMessage();
        $type = "error";
    }
}
?>
<!DOCTYPE html>
<html>
<head>
    <title>Grant Full Access</title>
    <style>
        body { font-family: sans-serif; background: #0f172a; color: #fff; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
        .card { background: rgba(255,255,255,0.05); padding: 2rem; border-radius: 20px; border: 1px solid rgba(255,255,255,0.1); text-align: center; max-width: 400px; }
        .btn { background: #3b82f6; color: #fff; border: none; padding: 10px 20px; border-radius: 10px; cursor: pointer; font-weight: bold; margin-top: 1rem; }
        .btn:hover { background: #2563eb; }
        .msg { margin-bottom: 1.5rem; line-height: 1.5; }
        .success { color: #4ade80; }
        .error { color: #f87171; }
    </style>
</head>
<body>
    <div class="card">
        <h2>Gestión de Acceso</h2>
        <div class="msg <?php echo $type; ?>"><?php echo $msg; ?></div>
        <?php if ($type !== 'success'): ?>
            <form method="POST">
                <button type="submit" name="grant" class="btn">ACTIVAR ACCESO FULL</button>
            </form>
        <?php else: ?>
            <p style="opacity:0.6; font-size:0.8rem;">Puedes borrar este archivo (grant_access.php) de tu servidor ahora.</p>
        <?php endif; ?>
    </div>
</body>
</html>
