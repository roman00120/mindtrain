<?php
header('Content-Type: application/json');
header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');
header('Pragma: no-cache');
header('Expires: 0');
require_once __DIR__ . '/bootstrap.php';
narrativa_send_security_headers();
narrativa_start_secure_session();

if (isset($_SESSION['user_id'])) {
    echo json_encode([
        'loggedIn' => true,
        'username' => $_SESSION['username'],
        'userId'   => $_SESSION['user_id'],
        'role'     => $_SESSION['role'] ?? 'user'
    ]);
} else {
    echo json_encode([
        'loggedIn' => false
    ]);
}
?>
