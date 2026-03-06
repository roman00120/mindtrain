<?php
header('Content-Type: application/json');

require_once __DIR__ . '/bootstrap.php';
narrativa_send_security_headers();
narrativa_start_secure_session();

echo json_encode([
    'success' => true,
    'token' => narrativa_get_csrf_token(),
]);

