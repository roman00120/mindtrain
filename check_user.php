<?php
require_once __DIR__ . '/php/config.php';

if ($db_connection_error) {
    echo "DB Error: $db_connection_error\n";
    exit;
}

$email = 'gerawx@gmail.com';
$stmt = $pdo->prepare('SELECT id, username FROM usuarios WHERE email = ?');
$stmt->execute([$email]);
$user = $stmt->fetch();

if ($user) {
    echo "READY: " . $user['id'] . " | " . $user['username'] . "\n";
} else {
    echo "NOT_FOUND\n";
    // Let's list some users to see what's in there
    $stmt = $pdo->query('SELECT email FROM usuarios LIMIT 5');
    echo "Recent users:\n";
    while($row = $stmt->fetch()) {
        echo "- " . $row['email'] . "\n";
    }
}
?>
