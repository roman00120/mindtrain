<?php
header('Content-Type: application/json');

require_once __DIR__ . '/google_config.php';

echo json_encode([
    'success' => true,
    'clientId' => GOOGLE_CLIENT_ID,
]);

